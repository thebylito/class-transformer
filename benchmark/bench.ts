/**
 * Reproducible benchmark harness for class-transformer.
 *
 * Metrics per scenario:
 *   - throughput: ops/sec (1 op = transforming the whole array once), median of S samples
 *   - allocation pressure: GC count + total GC pause time during the measured window
 *
 * Run with:  node --expose-gc -r ts-node/register/transpile-only benchmark/bench.ts
 * (env TS_NODE_PROJECT=benchmark/tsconfig.json)
 */
import 'reflect-metadata';
import { performance, PerformanceObserver } from 'perf_hooks';
import { plainToInstance, instanceToPlain, instanceToInstance } from '../src';
import { FlatUser, Post, makeFlatUser, makePostPlain } from './models';

/* --------------------------------- config --------------------------------- */

const N = Number(process.env.BENCH_N || 1000); // objects per op (per transform call)
const SAMPLES = Number(process.env.BENCH_SAMPLES || 12); // measured samples per scenario
const WARMUP = Number(process.env.BENCH_WARMUP || 5);
const MIN_TIME_MS = 100; // each sample runs at least this long; iterations auto-scale

/* ------------------------------ GC accounting ----------------------------- */

let gcCount = 0;
let gcTime = 0;
const gcObserver = new PerformanceObserver(list => {
  for (const entry of list.getEntries()) {
    gcCount++;
    gcTime += entry.duration;
  }
});
gcObserver.observe({ entryTypes: ['gc'] });

function resetGc(): void {
  gcCount = 0;
  gcTime = 0;
}

/** GC PerformanceObserver entries are delivered on a macrotask; yield to flush them. */
function flushGc(): Promise<void> {
  return new Promise(resolve => setImmediate(() => setImmediate(resolve)));
}

/* ------------------------------- statistics ------------------------------- */

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Result {
  name: string;
  opsPerSec: number;
  msPerOp: number;
  gcCount: number;
  gcTimeMs: number;
  gcPerKOp: number;
}

/**
 * Times `fn` (one op). Auto-scales iterations so each sample lasts >= MIN_TIME_MS,
 * then reports the median ops/sec across SAMPLES, plus GC stats over the whole run.
 */
async function bench(name: string, fn: () => void): Promise<Result> {
  // warmup
  for (let i = 0; i < WARMUP; i++) fn();

  // calibrate iterations per sample
  let iters = 1;
  while (true) {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn();
    const elapsed = performance.now() - t0;
    if (elapsed >= MIN_TIME_MS || iters >= 1 << 20) break;
    iters = Math.max(iters * 2, Math.ceil((iters * MIN_TIME_MS) / Math.max(elapsed, 0.01)));
  }

  if (global.gc) global.gc();
  await flushGc();
  resetGc();

  const opsPerSecSamples: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn();
    const elapsed = performance.now() - t0;
    opsPerSecSamples.push((iters / elapsed) * 1000);
    await flushGc(); // let GC observer entries drain so gcCount/gcTime are accurate
  }

  const opsPerSec = median(opsPerSecSamples);
  const totalOps = iters * SAMPLES;
  return {
    name,
    opsPerSec,
    msPerOp: 1000 / opsPerSec,
    gcCount,
    gcTimeMs: gcTime,
    gcPerKOp: (gcCount / totalOps) * 1000,
  };
}

/* -------------------------------- fixtures -------------------------------- */

const flatPlain = Array.from({ length: N }, (_, i) => makeFlatUser(i));
const flatInstances = plainToInstance(FlatUser, flatPlain);

const postPlain = Array.from({ length: N }, (_, i) => makePostPlain(i));
const postInstances = plainToInstance(Post, postPlain);

/* -------------------------------- scenarios ------------------------------- */

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}
function padl(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

async function main(): Promise<void> {
  const results: Result[] = [];

  results.push(await bench(`plainToInstance  · flat   · ${N}`, () => plainToInstance(FlatUser, flatPlain)));
  results.push(await bench(`instanceToPlain  · flat   · ${N}`, () => instanceToPlain(flatInstances)));

  results.push(await bench(`plainToInstance  · nested · ${N}`, () => plainToInstance(Post, postPlain)));
  results.push(await bench(`instanceToPlain  · nested · ${N}`, () => instanceToPlain(postInstances)));
  results.push(await bench(`instanceToInstance·nested · ${N}`, () => instanceToInstance(postInstances)));

  results.push(
    await bench(`plainToInstance  · excludeExtraneous+groups · ${N}`, () =>
      plainToInstance(Post, postPlain, { excludeExtraneousValues: true, groups: ['admin'] })
    )
  );

  console.log('');
  console.log(`class-transformer benchmark  (N=${N}, samples=${SAMPLES}, node ${process.version})`);
  console.log('-'.repeat(94));
  console.log(
    pad('scenario', 46) +
      padl('ops/sec', 12) +
      padl('ms/op', 12) +
      padl('gc#', 6) +
      padl('gc/Kop', 9) +
      padl('gc ms', 9)
  );
  console.log('-'.repeat(94));
  for (const r of results) {
    console.log(
      pad(r.name, 46) +
        padl(r.opsPerSec.toFixed(1), 12) +
        padl(r.msPerOp.toFixed(3), 12) +
        padl(String(r.gcCount), 6) +
        padl(r.gcPerKOp.toFixed(2), 9) +
        padl(r.gcTimeMs.toFixed(1), 9)
    );
  }
  console.log('-'.repeat(94));
  console.log('');

  // machine-readable line for diffing across runs
  console.log(
    'JSON ' +
      JSON.stringify(results.map(r => ({ n: r.name, ops: Math.round(r.opsPerSec), gcK: +r.gcPerKOp.toFixed(2) })))
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
