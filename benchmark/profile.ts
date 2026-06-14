/**
 * Focused CPU profile driver. Run with V8's sampling profiler:
 *   TS_NODE_PROJECT=benchmark/tsconfig.json TS_NODE_TRANSPILE_ONLY=1 \
 *     node --prof -r ts-node/register benchmark/profile.ts
 *   node --prof-process isolate-*.log > benchmark/profile.txt
 */
import 'reflect-metadata';
import { plainToInstance, instanceToPlain } from '../src';
import { Post, makePostPlain } from './models';

const N = 2000;
const ITERS = Number(process.env.PROFILE_ITERS || 4000);

const plain = Array.from({ length: N }, (_, i) => makePostPlain(i));
const instances = plainToInstance(Post, plain);

let sink = 0;
for (let i = 0; i < ITERS; i++) {
  const a = plainToInstance(Post, plain);
  const b = instanceToPlain(instances);
  sink += (a as any[]).length + (b as any[]).length;
}
// keep the optimizer honest
if (sink < 0) console.log(sink);
console.log('done', sink);
