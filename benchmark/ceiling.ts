/**
 * Ceiling spike: how fast COULD a compiled transform be?
 *
 * Hand-writes the optimal PLAIN_TO_CLASS transform for the Post model (what a
 * per-class compiler would emit) and compares it against the generic
 * `plainToInstance`. The gap is the maximum headroom a compilation approach could
 * recover. This is a measurement tool, not a correctness-equivalent implementation.
 *
 *   TS_NODE_PROJECT=benchmark/tsconfig.json TS_NODE_TRANSPILE_ONLY=1 \
 *     node --expose-gc -r ts-node/register benchmark/ceiling.ts
 */
import 'reflect-metadata';
import { performance } from 'perf_hooks';
import { plainToInstance } from '../src';
import { Author, Photo, Post, makePostPlain } from './models';

const N = Number(process.env.BENCH_N || 1000);
const SAMPLES = 15;
const MIN_MS = 100;

const postPlain = Array.from({ length: N }, (_, i) => makePostPlain(i));

/* ---- hand-written "compiled" transforms (what codegen would produce) ---- */

function fastAuthor(p: any): Author {
  const a = new Author();
  a.firstName = p.firstName;
  a.lastName = p.lastName;
  a.email = p.email_address; // @Expose({ name: 'email_address' })
  // password is @Exclude; internalId is group-restricted -> omitted by default
  return a;
}

function fastPhoto(p: any): Photo {
  const ph = new Photo();
  ph.id = p.id;
  ph.filename = p.filename;
  ph.views = typeof p.views === 'number' ? p.views * 2 : p.views; // @Transform
  return ph;
}

function fastPost(p: any): Post {
  const post = new Post();
  post.id = p.id;
  post.title = p.title;
  post.body = p.body;
  post.createdAt = p.createdAt != null ? new Date(p.createdAt) : p.createdAt;
  post.author = p.author != null ? fastAuthor(p.author) : p.author;
  post.photos = Array.isArray(p.photos) ? p.photos.map(fastPhoto) : p.photos;
  post.tags = p.tags;
  return post;
}

function fastPlainToPosts(arr: any[]): Post[] {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = fastPost(arr[i]);
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

console.log(`\nceiling spike (N=${N}, node ${process.version})`);
console.log('-'.repeat(60));
const generic = bench('generic plainToInstance(Post)', () => plainToInstance(Post, postPlain));
const compiled = bench('hand-compiled fastPlainToPosts', () => fastPlainToPosts(postPlain));
console.log('-'.repeat(60));
console.log(`headroom: hand-compiled is ${(compiled / generic).toFixed(1)}x faster than the generic transform\n`);
