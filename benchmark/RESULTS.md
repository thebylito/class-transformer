# Optimization results

Cumulative effect of the optimization rounds on branch `perf/optimize-transform`.

Method: median of 3 runs × 25 samples each, same machine, toggling only `src/`
via `git stash` between optimized and baseline. Node v23.6.0, N=1000 objects/op.

- **ops/sec** — higher is better (throughput).
- **gc/Kop** — GC events per 1000 ops, lower is better (allocation pressure).

| Scenario                                   | base ops | opt ops | Δ throughput | base gc/Kop | opt gc/Kop |  Δ alloc |
| ------------------------------------------ | -------: | ------: | -----------: | ----------: | ---------: | -------: |
| plainToInstance · flat                     |      394 |    1662 | **+322%** ⚡ |         536 |         76 | **−86%** |
| instanceToPlain · flat                     |      375 |     802 |    **+114%** |         547 |        150 | **−73%** |
| plainToInstance · nested                   |      112 |     488 | **+336%** ⚡ |        1980 |        245 | **−88%** |
| instanceToPlain · nested                   |      133 |     254 |     **+91%** |        1437 |        563 | **−61%** |
| instanceToInstance · nested                |      137 |     239 |     **+74%** |        1455 |        579 | **−60%** |
| plainToInstance · excludeExtraneous+groups |      563 |    1071 |     **+90%** |         416 |        137 | **−67%** |

The incremental rounds (1–14) gave a ~2× across-the-board win; the compiled fast
path (round 15) then **roughly doubles `plainToInstance` again** — the most common
deserialization direction is now **~4.3× faster than baseline with ~87% less GC**.
The ⚡ rows use the compiled fast path; the others (CLASS_TO_PLAIN, CLASS_TO_CLASS,
and `excludeExtraneousValues`) fall back to the generic transform and reflect the
rounds 1–14 gains only.

## What changed

All changes are behavior-preserving (97/97 regression tests green after each round).

### Round 1 — `TransformOperationExecutor.ts` (local, zero behavior change)

- Hoisted `getGlobal()` to a module constant (was a `typeof` probe chain per value).
- Removed a duplicate `findTypeMetadata` lookup per array property (reuse the
  already-resolved `@Type` metadata; deleted the now-dead `getReflectedType`).
- Early-return in `applyCustomTransformations` when no `@Transform` exists.
- Replaced the O(n²) `indexOf` key-dedup with an O(n) `Set`.

### Round 2 — `MetadataStorage.ts` (the main lever)

- Memoized `getStrategy`, `getExposedProperties`, `getExcludedProperties` per
  `(target, transformationType)`. These re-allocated 2–3 arrays **per object**
  over metadata that is immutable after decoration.

### Round 3 — `MetadataStorage.ts`

- Memoized the raw `getExposedMetadatas` / `getExcludedMetadatas` lists per target,
  killing the `Array.from(...).filter()` that `findExposeMetadataByCustomName` ran
  per key in the PLAIN_TO_CLASS path.

### Round 4 — `MetadataStorage.ts` + `getKeys()`

- Memoized the PLAIN_TO_CLASS `@Expose({ name })` renamed property list per target.
- Memoized the set of group-restricted property names; the per-object group
  filtering pass (and its allocation) is now skipped entirely when a class has no
  grouped properties — the common case.

### Round 5 — `getKeys()` (no-decorator / "flat" path)

- Track whether metadata-derived property lists were actually merged in. When they
  weren't (plain objects, classes without expose/exclude), skip both the `concat`
  copy and the final dedup — `Object.keys` is already unique.

### Round 6 — `TransformOperationExecutor.ts`

- Only build the `TypeHelpOptions` argument for a `@Type()` function when that
  function declares a parameter. The common `@Type(() => Foo)` form ignores it.

### Round 7 — `getKeys()` (decorated path)

- Merge object keys with exposed properties into a single `Set` in one pass
  (preserving first-seen order), replacing `concat` + a separate `Set`/`Array`
  dedup round-trip — one fewer allocation per object.

### Round 8 — `MetadataStorage.ts` (large win)

- Fast path for classes with **no `@Transform`** (the common case): a memoized
  `hasAnyTransformMetadata(target)` short-circuits `findTransformMetadatas` to a
  shared frozen empty array. Previously every key allocated ~4–5 arrays
  (`slice`/`reverse`/`concat`/`filter`) just to discover there were no transforms.

### Round 9 — `TransformOperationExecutor.ts`

- Replaced the array-branch `forEach` (a per-array callback closure) with an
  indexed loop calling an extracted `transformArrayItem` method — fewer allocations
  and a monomorphic hot path. Preserves `Set.forEach` semantics and array-hole skipping.

### Round 10 — `TransformOperationExecutor.ts`

- Gated the per-key `Object.getOwnPropertyDescriptor` lookup on the transformation
  type. CLASS_TO_PLAIN (`instanceToPlain`) computed it for every key and never used
  the result — now skipped for the whole serialization direction.

### Round 11 — `MetadataStorage.ts`

- Memoized a `customName -> metadata` map per target, so the per-key
  `findExposeMetadataByCustomName` (PLAIN_TO_CLASS) is an O(1) map lookup instead of
  a full `.find()` scan with a fresh closure on every key.

### Round 12 — `TransformOperationExecutor.ts` (CPU-profile guided)

- Resolve `hasTransformMetadata(target)` **once per object** before the key loop and
  skip `applyCustomTransformations` entirely for classes with no `@Transform` — the
  per-key call + lookup was 5% of total time even with Round 8's fast path.

### Round 13 — `TransformOperationExecutor.ts` (CPU-profile guided)

- Replaced the per-key `Object.getOwnPropertyDescriptor` probe (a C++ call) on the
  PLAIN_TO_CLASS / CLASS_TO_CLASS paths with a per-prototype memoized `Set` of
  non-writable keys (methods / getter-only accessors), keyed by a `WeakMap`. The
  deserialization paths do this per key per object — now a JS `Set.has`. (+26% p2i flat.)

### Round 14 — `TransformOperationExecutor.ts` (CPU-profile guided)

- Memoized the @Transform metadata **selection** (after version/group filtering) per
  `(target, key)` on the executor. Transforming an array of N same-typed objects with
  `@Transform` resolved it once instead of N times (each resolution did
  `slice`/`reverse`/`concat` + filter allocations). Also fixed the method's `: boolean`
  return-type annotation (it returns the transformed value). (−20–24% GC on nested.)

All `MetadataStorage` caches are invalidated on `addExposeMetadata` /
`addExcludeMetadata` / `addTransformMetadata` / `clear()`, so they stay correct even
for classes decorated lazily. The executor-level caches (Round 14) live only for the
duration of one transform operation.

### Round 15 — `CompiledTransform.ts` (the compiled fast path)

The CPU profile after round 14 attributed the remaining cost to `transform` itself
(~28% self-time) — the recursive, per-key, reflection-driven walk. This round adds a
**compiled plan** for the most common direction (`plainToInstance`, default options):

- `getCompiledPlanPlainToClass(target)` builds, once per class, a list of property
  handlers from the `@Expose/@Exclude/@Type/@Transform` metadata. Running it is a tight
  loop with no per-key metadata lookups. Hot scalar / Date cases are inlined; nested
  values defer back to the executor (which recurses into the nested class's own plan).
- It is **deliberately conservative**: the plan is `null` (→ generic fallback) for
  anything it can't reproduce exactly — discriminators, `Map` types, type functions that
  inspect their argument, class-level `@Expose/@Exclude` strategies, or any non-default
  option (`groups`, `version`, `excludeExtraneousValues`, circular checks, …).
- It uses **closures, not `new Function`** — no `eval`, so it works under strict CSP.
- Plans are invalidated via a `MetadataStorage` listener whenever metadata changes.

Correctness is covered by `test/functional/compiled-fast-path.spec.ts`, which runs 19
diverse models through both paths (`setCompilationEnabled(true|false)`) and asserts
`toStrictEqual` — identical types, `undefined` fields and sparse arrays — plus the full
existing 97-test suite (which exercises the generic fallback for every advanced feature).

Net effect: `plainToInstance` roughly doubles again on top of rounds 1–14, reaching
~4.3× the original baseline with ~87% less GC. The other directions still benefit from
rounds 1–14 and fall back to the (now much faster) generic transform.

## Remaining headroom

A hand-written transform is ~25× the original generic (see `ceiling.ts`); the closure
plan recovers a large part of that for PLAIN_TO_CLASS. Extending the same approach to
CLASS_TO_PLAIN / CLASS_TO_CLASS, and to `excludeExtraneousValues` (where the key set is
fully static and compilation is easiest), is the natural next step. A `new Function`
codegen variant could approach the ceiling but trades away CSP-safety, so it would be
opt-in only.
