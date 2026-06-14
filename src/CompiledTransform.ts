import { defaultMetadataStorage } from './storage';
import { TransformationType } from './enums';
import { ClassTransformOptions } from './interfaces';

/**
 * Optional "compiled plan" fast path for the common PLAIN_TO_CLASS case.
 *
 * The generic {@link TransformOperationExecutor.transform} re-derives, per key per
 * object, which keys to process, their rename, their @Type, and their @Transform.
 * For an array of N same-typed objects that work is identical every time. This
 * module compiles a per-class PLAN once — a list of property handlers built from the
 * metadata — so transforming an object is a tight loop with no per-key metadata
 * lookups. Value transformation itself is delegated back to the executor (so all the
 * exotic value kinds stay handled by the proven generic code), while the cheap, hot
 * scalar / Date cases are inlined.
 *
 * Compilation is deliberately conservative: {@link getCompiledPlanPlainToClass}
 * returns `null` for anything it is not 100% sure it can reproduce identically, and
 * the caller falls back to the generic transform. Only fully-default options are
 * eligible (see {@link isCompilableOptions}).
 */

/** Minimal view of the executor the compiled handlers need. */
export interface ExecutorLike {
  transform(
    source: any,
    value: any,
    targetType: Function | undefined,
    arrayType: Function | undefined,
    isMap: boolean | undefined,
    level: number
  ): any;
}

type ValueHandler = (executor: ExecutorLike, value: any, level: number) => any;

interface PlanProperty {
  sourceKey: string; // key read from the plain object (rename-aware)
  targetKey: string; // property written on the instance
  handler: ValueHandler;
  transformFns: Array<(params: any) => any>;
  exposed: boolean; // part of the always-present key set (exposeUnsetFields)
}

interface CompiledPlan {
  target: Function;
  /** Source keys with an action, mapped to the property definition. */
  bySourceKey: Map<string, PlanProperty>;
  /** Source keys that are explicitly dropped (@Exclude / group-restricted). */
  skipKeys: Set<string>;
  /** Exposed source keys, always emitted even when absent from the source. */
  exposedKeys: string[];
  /** Prototype methods / getters that must not be overwritten on the instance. */
  nonWritableKeys: Set<string>;
}

const planCache = new Map<Function, CompiledPlan | null>();

let compilationEnabled = true;

/** Enable/disable the compiled fast path (used by the equivalence test suite). */
export function setCompilationEnabled(enabled: boolean): void {
  compilationEnabled = enabled;
}

/**
 * Whether the options are plain enough that the compiled plan reproduces the generic
 * output exactly. Anything that reshapes the result disables the fast path.
 */
export function isCompilableOptions(options: ClassTransformOptions): boolean {
  return (
    !options.enableCircularCheck &&
    !options.enableImplicitConversion &&
    !options.excludeExtraneousValues &&
    (!options.excludePrefixes || options.excludePrefixes.length === 0) &&
    !options.exposeDefaultValues &&
    (!options.groups || options.groups.length === 0) &&
    options.version === undefined &&
    !options.strategy &&
    (!options.targetMaps || options.targetMaps.length === 0) &&
    !options.ignoreDecorators &&
    options.exposeUnsetFields !== false
  );
}

/** Inlined value handler for an untyped property — mirrors `transform(value, undefined)`. */
function untypedHandler(executor: ExecutorLike, value: any, level: number): any {
  // scalars / null / undefined: passed straight through (the common, hot case)
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.valueOf());
  // arrays, Sets, Buffers, Promises, plain objects, Maps: defer to the proven generic
  // transform so every edge case (holes, Sets, Buffer, Promise…) stays identical.
  return executor.transform(undefined, value, undefined, undefined, value instanceof Map, level + 1);
}

function buildHandler(type: any, reflectedType: Function | undefined): ValueHandler | null {
  if (type === undefined) return untypedHandler;
  if (type === Date) {
    return (_e, v) => (v === null || v === undefined ? v : v instanceof Date ? new Date(v.valueOf()) : new Date(v));
  }
  if (type === String) return (_e, v) => (v === null || v === undefined ? v : String(v));
  if (type === Number) return (_e, v) => (v === null || v === undefined ? v : Number(v));
  if (type === Boolean) return (_e, v) => (v === null || v === undefined ? v : Boolean(v));
  if (typeof type === 'function') {
    // nested class (single or array). Defer to the executor, which recurses and will
    // itself use the compiled plan for the nested type when eligible.
    return (e, v, level) =>
      e.transform(undefined, v, type, Array.isArray(v) ? reflectedType : undefined, v instanceof Map, level + 1);
  }
  return null; // unsupported type shape -> caller falls back
}

/**
 * Compiles (and caches) a PLAIN_TO_CLASS plan for `target`, or returns `null` when the
 * class uses a feature this fast path does not handle (the caller then falls back to
 * the generic transform).
 */
export function getCompiledPlanPlainToClass(target: Function): CompiledPlan | null {
  if (!compilationEnabled) return null;

  const cached = planCache.get(target);
  if (cached !== undefined) return cached;

  // Reserve a null entry up-front so recursive/self-referential types don't loop.
  planCache.set(target, null);

  // Only the default "expose by decorator" strategy is handled here. A class-level
  // @Expose/@Exclude (excludeAll/exposeAll) changes the key set — fall back.
  if (defaultMetadataStorage.getStrategy(target) !== 'none') return null;

  const exposed = defaultMetadataStorage.getExposedProperties(target, TransformationType.PLAIN_TO_CLASS);
  const excluded = defaultMetadataStorage.getExcludedProperties(target, TransformationType.PLAIN_TO_CLASS);
  const grouped = defaultMetadataStorage.getGroupedPropertyNames(target);

  // Property names we know about: exposed, excluded, and @Type-decorated (which may
  // not be exposed). The instance shape surfaces typed-but-unexposed properties.
  const known = new Set<string>(exposed);
  excluded.forEach(p => known.add(p));

  const bySourceKey = new Map<string, PlanProperty>();
  const skipKeys = new Set<string>();
  const exposedSet = new Set(exposed);

  // Collect @Type- and @Transform-decorated property names too (they need a handler
  // even without @Expose) — read from metadata, never by constructing the class.
  for (const typeMeta of defaultMetadataStorage.getTypeMetadatas(target)) {
    if (typeMeta.propertyName !== undefined) known.add(typeMeta.propertyName);
  }
  defaultMetadataStorage.getTransformPropertyNames(target).forEach(p => known.add(p));

  for (const propertyName of Array.from(known)) {
    const expose = defaultMetadataStorage.findExposeMetadata(target, propertyName);
    const sourceKey = expose && expose.options && expose.options.name ? expose.options.name : propertyName;

    // @Exclude or group-restricted (no group requested) -> drop the key entirely.
    if (excluded.includes(propertyName) || grouped.has(propertyName)) {
      skipKeys.add(sourceKey);
      continue;
    }

    const typeMeta = defaultMetadataStorage.findTypeMetadata(target, propertyName);
    let resolvedType: any = undefined;
    let reflectedType: Function | undefined = undefined;
    if (typeMeta) {
      // Discriminators / Map types are not handled by the fast path.
      if (typeMeta.options && typeMeta.options.discriminator) return null;
      if (typeMeta.reflectedType === Map) return null;
      reflectedType = typeMeta.reflectedType;
      if (typeMeta.typeFunction) {
        // A type function that inspects its argument can return different types per
        // object; only the simple `() => T` form is safe to resolve once.
        if (typeMeta.typeFunction.length > 0) return null;
        resolvedType = (typeMeta.typeFunction as () => Function)();
      } else {
        resolvedType = typeMeta.reflectedType;
      }
    }

    const handler = buildHandler(resolvedType, reflectedType);
    if (!handler) return null;

    const transformFns = defaultMetadataStorage
      .findTransformMetadatas(target, propertyName, TransformationType.PLAIN_TO_CLASS)
      .map(m => m.transformFn);

    bySourceKey.set(sourceKey, {
      sourceKey,
      targetKey: propertyName,
      handler,
      transformFns,
      exposed: exposedSet.has(propertyName),
    });
  }

  const plan: CompiledPlan = {
    target,
    bySourceKey,
    skipKeys,
    exposedKeys: Array.from(bySourceKey.values())
      .filter(p => p.exposed)
      .map(p => p.sourceKey),
    nonWritableKeys: computeNonWritableKeys(target),
  };
  planCache.set(target, plan);
  return plan;
}

/**
 * Own property names on the class prototype that must not be overwritten (methods and
 * getter-only accessors). Mirrors the generic transform's per-key descriptor skip.
 */
function computeNonWritableKeys(target: Function): Set<string> {
  const keys = new Set<string>();
  const prototype = target && (target as any).prototype;
  if (!prototype) return keys;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor && !descriptor.set) keys.add(name);
  }
  return keys;
}

/** Runs a compiled plan against a plain source object, producing a class instance. */
export function runCompiledPlan(
  plan: CompiledPlan,
  executor: ExecutorLike,
  source: Record<string, any>,
  level: number,
  options: ClassTransformOptions
): any {
  const instance = new (plan.target as any)();
  const nonWritable = plan.nonWritableKeys;

  // Key set = the source's own keys ∪ exposed keys (so exposeUnsetFields is honored).
  const sourceKeys = Object.keys(source);
  const seen = new Set<string>();

  for (let i = 0; i < sourceKeys.length; i++) {
    const key = sourceKeys[i];
    if (key === '__proto__' || key === 'constructor') continue;
    seen.add(key);
    if (plan.skipKeys.has(key)) continue;

    const prop = plan.bySourceKey.get(key);
    const targetKey = prop ? prop.targetKey : key;
    // Don't overwrite a prototype method / getter (matches the generic transform).
    if (nonWritable.has(targetKey) || instance[targetKey] instanceof Function) continue;

    if (prop) {
      let value = prop.handler(executor, source[key], level);
      value = applyTransforms(prop.transformFns, value, prop.targetKey, source, options);
      instance[targetKey] = value;
    } else {
      // extraneous key (exposeAll copies it, deep-transformed with an unknown type)
      instance[key] = untypedHandler(executor, source[key], level);
    }
  }

  // Exposed properties absent from the source still get emitted (exposeUnsetFields).
  for (let i = 0; i < plan.exposedKeys.length; i++) {
    const key = plan.exposedKeys[i];
    if (seen.has(key) || plan.skipKeys.has(key)) continue;
    const prop = plan.bySourceKey.get(key);
    if (!prop) continue;
    if (nonWritable.has(prop.targetKey) || instance[prop.targetKey] instanceof Function) continue;
    let value = prop.handler(executor, undefined, level);
    value = applyTransforms(prop.transformFns, value, prop.targetKey, source, options);
    instance[prop.targetKey] = value;
  }

  return instance;
}

function applyTransforms(
  fns: Array<(params: any) => any>,
  value: any,
  key: string,
  obj: any,
  options: ClassTransformOptions
): any {
  for (let i = 0; i < fns.length; i++) {
    value = fns[i]({ value, key, obj, type: TransformationType.PLAIN_TO_CLASS, options });
  }
  return value;
}

/** Test/diagnostic hook: drops the compiled-plan cache. */
export function clearCompiledPlans(): void {
  planCache.clear();
}

// Plans are derived from metadata; rebuild them whenever metadata changes.
defaultMetadataStorage.onInvalidate(clearCompiledPlans);
