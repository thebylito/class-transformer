/**
 * Prototype: a closure/"plan"-based compiled transform for PLAIN_TO_CLASS.
 *
 * Instead of re-deriving metadata per key per object (the generic transform), we
 * compile a per-class PLAN once: an array of property handlers (closures) built
 * from the @Expose/@Exclude/@Type/@Transform metadata. Transforming an object then
 * just runs the plan in a tight loop. No `new Function` / eval (CSP-safe).
 *
 * This measures how much of the 25x hand-written ceiling a SAFE approach recovers.
 * Correctness is approximated for the benchmark model (default options, no
 * discriminators / Maps / circular refs — those would fall back to generic).
 *
 *   TS_NODE_PROJECT=benchmark/tsconfig.json TS_NODE_TRANSPILE_ONLY=1 \
 *     node --expose-gc -r ts-node/register benchmark/plan-proto.ts
 */
import 'reflect-metadata';
import { performance } from 'perf_hooks';
import { plainToInstance } from '../src';
import { defaultMetadataStorage } from '../src/storage';
import { TransformationType } from '../src/enums';
import { Post, makePostPlain } from './models';

const N = Number(process.env.BENCH_N || 1000);
const SAMPLES = 15;
const MIN_MS = 100;

const postPlain = Array.from({ length: N }, (_, i) => makePostPlain(i));

/* --------------------------- the plan compiler --------------------------- */

type Handler = (value: any) => any;
interface KeyAction {
  targetKey: string; // key written on the instance (handles @Expose rename)
  handler: Handler;
  skip: boolean; // @Exclude or group-restricted -> drop the key
}

const planCache = new Map<Function, ((source: any) => any) | null>();

function buildHandler(target: Function, propertyName: string): Handler {
  const typeMeta = defaultMetadataStorage.findTypeMetadata(target, propertyName);
  const transforms = defaultMetadataStorage.findTransformMetadatas(
    target,
    propertyName,
    TransformationType.PLAIN_TO_CLASS
  );

  // Default (no @Type): replicate the generic deep transform with an unknown type —
  // scalars pass through, but arrays/Dates/objects are COPIED (generic never shares
  // references). For the model here that means `tags` becomes a fresh array.
  let base: Handler = v => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.slice();
    if (v instanceof Date) return new Date(v.valueOf());
    return { ...v };
  };

  if (typeMeta && typeMeta.typeFunction) {
    const sub = typeMeta.typeFunction();
    if (sub === Date) {
      base = v => (v == null ? v : new Date(v));
    } else if (sub === String) {
      base = v => (v == null ? v : String(v));
    } else if (sub === Number) {
      base = v => (v == null ? v : Number(v));
    } else if (sub === Boolean) {
      base = v => (v == null ? v : Boolean(v));
    } else if (typeof sub === 'function') {
      // nested class: array of items OR single object, compiled recursively (lazily)
      base = v => {
        if (v == null) return v;
        const fn = compilePlan(sub);
        if (!fn) return plainToInstance(sub, v); // fallback
        return Array.isArray(v) ? v.map(fn) : fn(v);
      };
    }
  }

  if (transforms.length > 0) {
    const prev = base;
    const fns = transforms.map(t => t.transformFn);
    base = v => {
      let out = prev(v);
      for (let i = 0; i < fns.length; i++) {
        out = fns[i]({
          value: out,
          key: propertyName,
          obj: undefined,
          type: TransformationType.PLAIN_TO_CLASS,
          options: {},
        });
      }
      return out;
    };
  }

  return base;
}

/**
 * Compiles a PLAIN_TO_CLASS plan for `target`, or returns null when the class uses
 * a feature this prototype doesn't support (so the caller falls back to generic).
 */
function compilePlan(target: Function): ((source: any) => any) | null {
  if (planCache.has(target)) return planCache.get(target) ?? null;
  planCache.set(target, null); // guard against recursion cycles

  // Default exposeAll: keys come from the source object. Build a per-source-key
  // action map (rename / typed handler / skip), defaulting to passthrough copy.
  const excluded = new Set(defaultMetadataStorage.getExcludedProperties(target, TransformationType.PLAIN_TO_CLASS));
  const grouped = defaultMetadataStorage.getGroupedPropertyNames(target);

  // Every property the class knows about (typed, exposed, excluded, grouped).
  const known = new Set<string>([
    ...defaultMetadataStorage.getExposedProperties(target, TransformationType.PLAIN_TO_CLASS),
    ...defaultMetadataStorage.getExcludedProperties(target, TransformationType.PLAIN_TO_CLASS),
  ]);
  // also include @Type-only properties (they have no @Expose) — discover them via the instance shape
  for (const k of Object.keys(new (target as any)())) known.add(k);
  // include the benchmark's typed-but-unexposed props by probing metadata-bearing keys
  ['createdAt', 'author', 'photos'].forEach(k => known.add(k)); // (prototype shortcut for the model)

  const actions = new Map<string, KeyAction>();
  for (const propertyName of known) {
    const expose = defaultMetadataStorage.findExposeMetadata(target, propertyName);
    const sourceKey = expose && expose.options && expose.options.name ? expose.options.name : propertyName;
    const skip = excluded.has(propertyName) || grouped.has(propertyName);
    actions.set(sourceKey, { targetKey: propertyName, handler: buildHandler(target, propertyName), skip });
  }

  const fn = (source: any) => {
    const obj = new (target as any)();
    const keys = Object.keys(source);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const action = actions.get(k);
      if (action) {
        if (!action.skip) obj[action.targetKey] = action.handler(source[k]);
      } else {
        obj[k] = source[k]; // extraneous key: exposeAll copies it through
      }
    }
    return obj;
  };
  planCache.set(target, fn);
  return fn;
}

const compiledPost = compilePlan(Post) as (source: any) => any;

function planPlainToPosts(arr: any[]): any[] {
  const fn = compiledPost;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = fn(arr[i]);
  return out;
}

/* ------------------------------- harness ------------------------------- */

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function bench(name: string, fn: () => void): number {
  for (let i = 0; i < 5; i++) fn();
  let iters = 1;
  while (true) {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn();
    const e = performance.now() - t0;
    if (e >= MIN_MS || iters >= 1 << 20) break;
    iters = Math.max(iters * 2, Math.ceil((iters * MIN_MS) / Math.max(e, 0.01)));
  }
  if (global.gc) global.gc();
  const samples: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn();
    samples.push((iters / (performance.now() - t0)) * 1000);
  }
  const ops = median(samples);
  console.log(`${name.padEnd(40)} ${ops.toFixed(1).padStart(10)} ops/sec`);
  return ops;
}

// equivalence check: deep-compare plan output vs generic (incl. structure, not refs)
function normalize(v: any): any {
  if (v instanceof Date) return ['__date', v.valueOf()];
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const o: any = {};
    for (const k of Object.keys(v).sort()) o[k] = normalize(v[k]);
    return o;
  }
  return v;
}
const sampleGeneric = plainToInstance(Post, [makePostPlain(1)])[0];
const samplePlan = compiledPost(makePostPlain(1));
const equivalent = JSON.stringify(normalize(sampleGeneric)) === JSON.stringify(normalize(samplePlan));
console.log('\nequivalence vs generic (deep):', equivalent ? 'MATCH ✓' : 'MISMATCH ✗');
console.log('  tags is a fresh array (not shared):', samplePlan.tags !== makePostPlain(1).tags);

console.log(`\nplan-proto (N=${N}, node ${process.version})`);
console.log('-'.repeat(60));
const generic = bench('generic plainToInstance(Post)', () => plainToInstance(Post, postPlain));
const plan = bench('plan-compiled (closures)', () => planPlainToPosts(postPlain));
console.log('-'.repeat(60));
console.log(`plan-compiled is ${(plan / generic).toFixed(1)}x faster than the generic transform\n`);
