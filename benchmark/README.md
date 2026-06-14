# class-transformer benchmark

Reproducible micro-benchmark used to measure performance / resource-consumption
work. No external benchmarking library — the harness self-calibrates iteration
counts and reports the median across samples.

## Metrics

- **ops/sec** — one "op" = transforming the whole `N`-object array once (median of `BENCH_SAMPLES`).
- **ms/op** — wall-clock per op.
- **gc#** — number of GC events observed during the measured window (allocation pressure).
- **gc/Kop** — GC events per 1000 ops, the normalized allocation-pressure metric. Lower is better.
- **gc ms** — total GC pause time during the run.

GC events are read from a `perf_hooks` `PerformanceObserver`; entries are delivered
asynchronously, so the harness yields (`setImmediate`) between samples to drain them.

## Run

```bash
TS_NODE_PROJECT=benchmark/tsconfig.json TS_NODE_TRANSPILE_ONLY=1 \
  node --expose-gc -r ts-node/register benchmark/bench.ts
```

`--expose-gc` lets the harness force a clean GC before each scenario so GC counts
are attributable to that scenario.

### Tunables (env vars)

| var             | default | meaning                        |
| --------------- | ------- | ------------------------------ |
| `BENCH_N`       | 1000    | objects per op (per transform) |
| `BENCH_SAMPLES` | 12      | measured samples per scenario  |
| `BENCH_WARMUP`  | 5       | warmup ops before measuring    |

## Scenarios

| scenario                                   | exercises                                                 |
| ------------------------------------------ | --------------------------------------------------------- |
| plainToInstance · flat                     | `Object.keys` path, no decorators (most common usage)     |
| instanceToPlain · flat                     | CLASS_TO_PLAIN over plain instances                       |
| plainToInstance · nested                   | `@Type` (nested + arrays), `@Expose` rename, `@Transform` |
| instanceToPlain · nested                   | full feature surface, class → plain                       |
| instanceToInstance · nested                | CLASS_TO_CLASS deep clone                                 |
| plainToInstance · excludeExtraneous+groups | heavy `getKeys()` filter path (groups + exclusion)        |

## Files

- `bench.ts` — harness + scenarios + report.
- `models.ts` — representative model classes and data factories.
- `baseline.txt` — snapshot before optimization work (compare against this).
