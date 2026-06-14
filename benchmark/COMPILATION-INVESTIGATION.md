# Investigation: compiling a per-class transform

After the 14 incremental optimization rounds (~2× throughput, see `RESULTS.md`), a
CPU profile attributed the remaining cost to `transform` itself (~28% self-time) —
the recursive, per-key, reflection-driven walk. The only way materially past that is
to stop re-interpreting metadata per object and instead **compile a specialized
transform per class**, the way `fast-json-stringify` compiles per schema.

This documents what that would buy and what it would cost. Two reproducible spikes:

```bash
TS_NODE_PROJECT=benchmark/tsconfig.json TS_NODE_TRANSPILE_ONLY=1 \
  node --expose-gc -r ts-node/register benchmark/ceiling.ts     # the ceiling
TS_NODE_PROJECT=benchmark/tsconfig.json TS_NODE_TRANSPILE_ONLY=1 \
  node --expose-gc -r ts-node/register benchmark/plan-proto.ts  # a safe approach
```

## Measured headroom (PLAIN_TO_CLASS, nested `Post` model, N=1000)

| Implementation                                        | ops/sec | vs generic |
| ----------------------------------------------------- | ------: | ---------: |
| generic `plainToInstance` (current, optimized)        |    ~290 |         1× |
| **closure/plan-compiled** (CSP-safe, `plan-proto.ts`) |   ~1500 |    **~5×** |
| **hand-written** (the ceiling, `ceiling.ts`)          |   ~7400 |   **~25×** |

So there is **~25× of theoretical headroom**, and a _safe_ compilation approach
recovers **~5×** of it on top of the current code.

## Two compilation strategies

### A. Closure / "plan" compilation — ~5×, CSP-safe (recommended first step)

Compile a per-class **plan**: an array of property handlers (closures) resolved once
from the `@Expose/@Exclude/@Type/@Transform` metadata. Transforming an object runs the
plan in a tight loop — no per-key metadata lookups, no per-key branching.

- **Pros:** no `eval`/`new Function` (works under strict CSP, the browser story), and
  it can fall back to the generic transform for anything it doesn't support.
- **Cons:** closure-call overhead per property + `Object.keys` iteration cap it at ~5×.

### B. `new Function` codegen — closer to ~10–25×, but `eval`-class

Generate JS source (`obj.id = src.id; obj.createdAt = src.createdAt == null ? ... : new Date(...)`)
and `new Function` it. Direct field access, no closure overhead.

- **Pros:** approaches the hand-written ceiling.
- **Cons:** `new Function` is blocked by strict Content-Security-Policy (`script-src`
  without `'unsafe-eval'`) — a real constraint for a library used in browsers. Harder
  to debug; larger attack surface. Would need a runtime feature-detect + fallback to A/generic.

## Why this is a separate effort, not another "round"

class-transformer's surface is large and every feature has to be either compiled or
detected-and-delegated to the generic path:

- transformation types: PLAIN_TO_CLASS, CLASS_TO_PLAIN, CLASS_TO_CLASS
- options that change shape: `excludeExtraneousValues`, `groups`, `version`,
  `strategy`, `excludePrefixes`, `exposeDefaultValues`, `exposeUnsetFields`,
  `enableImplicitConversion`, `enableCircularCheck`, `targetMaps`, `ignoreDecorators`
- value kinds: nested classes, arrays, `Map`, `Set`, `Date`, `Buffer`, `Promise`,
  discriminators (polymorphism), circular references
- inheritance (ancestor metadata)

A correct compiler must produce byte-identical output to the generic transform for
every combination, or feature-detect and fall back. The cache key must include the
options that affect output. This is a focused project with an exhaustive correctness
matrix — high value, but it earns its own PR and test suite, separate from the
behavior-preserving incremental work already on this branch.

## Recommendation

1. Ship the 14 incremental rounds now (safe ~2×, 97/97 tests, all builds green).
2. As a follow-up, implement **strategy A** (closure plans) as an internal fast-path:
   `compile(target, transformationType, options)` returns a plan for the supported
   subset, cached per `(target, type, options-signature)`, with automatic fallback to
   the current generic transform. That stacks ~5× on top of today's 2× for the common
   case (~10× vs the original baseline) while keeping 100% correctness via fallback.
3. Treat **strategy B** (`new Function`) as opt-in only, behind a flag, given the CSP
   constraint.

The spikes here are measurement tools, not production code (correctness is approximated
for the `Post` model only).
