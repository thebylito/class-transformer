import { defaultMetadataStorage } from './storage';
import { ClassTransformOptions, TransformMetadata, TypeHelpOptions, TypeMetadata } from './interfaces';
import { TransformationType } from './enums';
import { getGlobal, isPromise } from './utils';
import { getCompiledPlanPlainToClass, isCompilableOptions, runCompiledPlan } from './CompiledTransform';

/**
 * The global object reference is stable for the lifetime of the module, so we
 * resolve it once instead of running the `typeof` probe chain on every value.
 * The `Buffer` property is still read at use-time to honor late polyfills.
 */
const GLOBAL = getGlobal();

function instantiateArrayType(arrayType: Function): Array<any> | Set<any> {
  const array = new (arrayType as any)();
  if (!(array instanceof Set) && !('push' in array)) {
    return [];
  }
  return array;
}

/**
 * Per-prototype cache of own property names that must NOT be overwritten when
 * writing into a class instance — methods and getter-only accessors (any own
 * descriptor without a setter). The set is the same for every instance of a
 * class, so we compute it once instead of probing `getOwnPropertyDescriptor`
 * per key per object. Keyed weakly so prototypes can still be garbage-collected.
 */
const nonWritableKeysCache = new WeakMap<object, Set<string>>();

function getNonWritableKeys(prototype: object): Set<string> {
  let keys = nonWritableKeysCache.get(prototype);
  if (!keys) {
    keys = new Set<string>();
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor && !descriptor.set) {
        keys.add(name);
      }
    }
    nonWritableKeysCache.set(prototype, keys);
  }
  return keys;
}

export class TransformOperationExecutor {
  // -------------------------------------------------------------------------
  // Private Properties
  // -------------------------------------------------------------------------

  private recursionStack = new Set<Record<string, any>>();

  /**
   * Per-operation memo of the @Transform metadatas that apply to (target, key)
   * after version/group filtering. Options are fixed for an executor instance, so
   * an array of N same-typed objects resolves each selection once instead of N times.
   */
  private _transformMetadatasCache = new Map<Function, Map<string, TransformMetadata[]>>();

  /** Whether the compiled PLAIN_TO_CLASS fast path is eligible for this operation. */
  private readonly compilablePlainToClass: boolean;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  constructor(private transformationType: TransformationType, private options: ClassTransformOptions) {
    this.compilablePlainToClass =
      transformationType === TransformationType.PLAIN_TO_CLASS && isCompilableOptions(options);
  }

  // -------------------------------------------------------------------------
  // Public Methods
  // -------------------------------------------------------------------------

  transform(
    source: any,
    value: any,
    targetType: Function | TypeMetadata | undefined,
    arrayType: Function | undefined,
    isMap: boolean | undefined,
    level: number = 0
  ): any {
    if (Array.isArray(value) || value instanceof Set) {
      const newValue =
        arrayType && this.transformationType === TransformationType.PLAIN_TO_CLASS
          ? instantiateArrayType(arrayType)
          : [];
      // Indexed loop instead of `forEach` to avoid the per-array callback closure
      // and keep the hot array path monomorphic. `Set.forEach` passes the element
      // as both value and key, and `forEach` skips array holes — both preserved.
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          if (!(index in value)) continue;
          this.transformArrayItem(source, value[index], index, targetType, newValue, level);
        }
      } else {
        // value is a Set; forEach avoids `for...of` iteration, which would require
        // --downlevelIteration on the ES5 build target. Matches the original Set
        // semantics (the element is passed as both value and key).
        value.forEach((subValue: any) => {
          this.transformArrayItem(source, subValue, subValue, targetType, newValue, level);
        });
      }
      return newValue;
    } else if (targetType === String && !isMap) {
      if (value === null || value === undefined) return value;
      return String(value);
    } else if (targetType === Number && !isMap) {
      if (value === null || value === undefined) return value;
      return Number(value);
    } else if (targetType === Boolean && !isMap) {
      if (value === null || value === undefined) return value;
      return Boolean(value);
    } else if ((targetType === Date || value instanceof Date) && !isMap) {
      if (value instanceof Date) {
        return new Date(value.valueOf());
      }
      if (value === null || value === undefined) return value;
      return new Date(value);
    } else if (!!GLOBAL.Buffer && (targetType === GLOBAL.Buffer || value instanceof GLOBAL.Buffer) && !isMap) {
      if (value === null || value === undefined) return value;
      return GLOBAL.Buffer.from(value);
    } else if (isPromise(value) && !isMap) {
      return new Promise((resolve, reject) => {
        value.then(
          (data: any) => resolve(this.transform(undefined, data, targetType, undefined, false, level + 1)),
          reject
        );
      });
    } else if (!isMap && value !== null && typeof value === 'object' && typeof value.then === 'function') {
      // Note: We should not enter this, as promise has been handled above
      // This option simply returns the Promise preventing a JS error from happening and should be an inaccessible path.
      return value; // skip promise transformation
    } else if (typeof value === 'object' && value !== null) {
      // try to guess the type
      if (!targetType && value.constructor !== Object /* && TransformationType === TransformationType.CLASS_TO_PLAIN*/)
        if (!Array.isArray(value) && value.constructor === Array) {
          // Somebody attempts to convert special Array like object to Array, eg:
          // const evilObject = { '100000000': '100000000', __proto__: [] };
          // This could be used to cause Denial-of-service attack so we don't allow it.
          // See prevent-array-bomb.spec.ts for more details.
        } else {
          // We are good we can use the built-in constructor
          targetType = value.constructor;
        }
      if (!targetType && source) targetType = source.constructor;

      // Compiled fast path: PLAIN_TO_CLASS, default options, a decorated target class,
      // and a plain (non-Map) source object. Falls back to the generic walk below for
      // anything the compiler can't reproduce exactly (it returns a null plan).
      if (this.compilablePlainToClass && !source && !isMap && targetType && !(value instanceof Map)) {
        const plan = getCompiledPlanPlainToClass(targetType as Function);
        if (plan) {
          return runCompiledPlan(plan, this, value as Record<string, any>, level, this.options);
        }
      }

      if (this.options.enableCircularCheck) {
        // add transformed type to prevent circular references
        this.recursionStack.add(value);
      }

      const keys = this.getKeys(targetType as Function, value, isMap === true);
      let newValue: any = source ? source : {};
      if (
        !source &&
        (this.transformationType === TransformationType.PLAIN_TO_CLASS ||
          this.transformationType === TransformationType.CLASS_TO_CLASS)
      ) {
        if (isMap) {
          newValue = new Map();
        } else if (targetType) {
          newValue = new (targetType as any)();
        } else {
          newValue = {};
        }
      }

      // @Transform metadata is the same for every key of this object, so resolve
      // once: most classes have none, letting us skip the per-key custom-transform
      // lookup entirely below.
      const hasTransforms = targetType ? defaultMetadataStorage.hasTransformMetadata(targetType as Function) : false;

      // When writing into a class instance, methods / getter-only accessors on the
      // prototype must be skipped. That set is the same for every key, so resolve
      // it once per object instead of probing a descriptor per key.
      const nonWritableKeys =
        (this.transformationType === TransformationType.PLAIN_TO_CLASS ||
          this.transformationType === TransformationType.CLASS_TO_CLASS) &&
        newValue.constructor &&
        newValue.constructor.prototype
          ? getNonWritableKeys(newValue.constructor.prototype)
          : undefined;

      // traverse over keys
      for (const key of keys) {
        if (key === '__proto__' || key === 'constructor') {
          continue;
        }

        const valueKey = key;
        let newValueKey = key,
          propertyName = key;
        if (!this.options.ignoreDecorators && targetType) {
          if (this.transformationType === TransformationType.PLAIN_TO_CLASS) {
            const exposeMetadata = defaultMetadataStorage.findExposeMetadataByCustomName(targetType as Function, key);
            if (exposeMetadata && exposeMetadata.propertyName) {
              propertyName = exposeMetadata.propertyName;
              newValueKey = exposeMetadata.propertyName;
            }
          } else if (
            this.transformationType === TransformationType.CLASS_TO_PLAIN ||
            this.transformationType === TransformationType.CLASS_TO_CLASS
          ) {
            const exposeMetadata = defaultMetadataStorage.findExposeMetadata(targetType as Function, key);
            if (exposeMetadata && exposeMetadata.options && exposeMetadata.options.name) {
              newValueKey = exposeMetadata.options.name;
            }
          }
        }

        // get a subvalue
        let subValue: any = undefined;
        if (this.transformationType === TransformationType.PLAIN_TO_CLASS) {
          /**
           * This section is added for the following report:
           * https://github.com/typestack/class-transformer/issues/596
           *
           * We should not call functions or constructors when transforming to class.
           */
          subValue = value[valueKey];
        } else {
          if (value instanceof Map) {
            subValue = value.get(valueKey);
          } else if (value[valueKey] instanceof Function) {
            subValue = value[valueKey]();
          } else {
            subValue = value[valueKey];
          }
        }

        // determine a type
        // Resolve the @Type() metadata once and reuse it both here and for the
        // array-type lookup below, instead of querying the metadata storage twice.
        const typeMetadata = targetType
          ? defaultMetadataStorage.findTypeMetadata(targetType as Function, propertyName)
          : undefined;
        let type: any = undefined,
          isSubValueMap = subValue instanceof Map;
        if (targetType && isMap) {
          type = targetType;
        } else if (targetType) {
          const metadata = typeMetadata;
          if (metadata) {
            let newType: any;
            if (metadata.typeFunction) {
              // Only build the TypeHelpOptions argument when the type function
              // actually declares a parameter. The common `@Type(() => Foo)` form
              // ignores it, so we skip an object allocation per property per object.
              newType =
                metadata.typeFunction.length === 0
                  ? metadata.typeFunction()
                  : metadata.typeFunction({ newObject: newValue, object: value, property: propertyName });
            } else {
              newType = metadata.reflectedType;
            }
            if (
              metadata.options &&
              metadata.options.discriminator &&
              metadata.options.discriminator.property &&
              metadata.options.discriminator.subTypes
            ) {
              const discriminator = metadata.options.discriminator;
              if (!(value[valueKey] instanceof Array)) {
                if (this.transformationType === TransformationType.PLAIN_TO_CLASS) {
                  type = discriminator.subTypes.find(subType => {
                    if (subValue && subValue instanceof Object && discriminator.property in subValue) {
                      return subType.name === subValue[discriminator.property];
                    }
                  });
                  if (type === undefined) {
                    type = newType;
                  } else {
                    type = type.value;
                  }
                  if (!metadata.options.keepDiscriminatorProperty) {
                    if (subValue && subValue instanceof Object && discriminator.property in subValue) {
                      delete subValue[discriminator.property];
                    }
                  }
                }
                if (this.transformationType === TransformationType.CLASS_TO_CLASS) {
                  type = subValue.constructor;
                }
                if (this.transformationType === TransformationType.CLASS_TO_PLAIN) {
                  if (subValue) {
                    const matchedSubType = discriminator.subTypes.find(
                      subType => subType.value === subValue.constructor
                    );
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    subValue[discriminator.property] = matchedSubType!.name;
                  }
                }
              } else {
                type = metadata;
              }
            } else {
              type = newType;
            }
            isSubValueMap = isSubValueMap || metadata.reflectedType === Map;
          } else if (this.options.targetMaps) {
            // try to find a type in target maps
            this.options.targetMaps
              .filter(map => map.target === targetType && !!map.properties[propertyName])
              .forEach(map => (type = map.properties[propertyName]));
          } else if (
            this.options.enableImplicitConversion &&
            this.transformationType === TransformationType.PLAIN_TO_CLASS
          ) {
            // if we have no registererd type via the @Type() decorator then we check if we have any
            // type declarations in reflect-metadata (type declaration is emited only if some decorator is added to the property.)
            const reflectedType = (Reflect as any).getMetadata(
              'design:type',
              (targetType as Function).prototype,
              propertyName
            );

            if (reflectedType) {
              type = reflectedType;
            }
          }
        }

        // if value is an array try to get its custom array type
        const arrayType = Array.isArray(value[valueKey]) && typeMetadata ? typeMetadata.reflectedType : undefined;

        // const subValueKey = TransformationType === TransformationType.PLAIN_TO_CLASS && newKeyName ? newKeyName : key;
        const subSource = source ? source[valueKey] : undefined;

        // if its deserialization then type if required
        // if we uncomment this types like string[] will not work
        // if (this.transformationType === TransformationType.PLAIN_TO_CLASS && !type && subValue instanceof Object && !(subValue instanceof Date))
        //     throw new Error(`Cannot determine type for ${(targetType as any).name }.${propertyName}, did you forget to specify a @Type?`);

        // if newValue is a class instance whose prototype has a method/getter matching
        // newValueKey, skip it (don't overwrite it). The non-writable key set is resolved
        // once per object above; the Function check stays per-key (instance dependent).
        if (
          nonWritableKeys &&
          // eslint-disable-next-line @typescript-eslint/unbound-method
          (nonWritableKeys.has(newValueKey) || newValue[newValueKey] instanceof Function)
        ) {
          continue;
        }

        if (!this.options.enableCircularCheck || !this.isCircular(subValue)) {
          const transformKey = this.transformationType === TransformationType.PLAIN_TO_CLASS ? newValueKey : key;
          let finalValue;

          if (this.transformationType === TransformationType.CLASS_TO_PLAIN) {
            // Get original value
            finalValue = value[transformKey];
            // Apply custom transformation (only when the class declares any @Transform)
            if (hasTransforms) {
              finalValue = this.applyCustomTransformations(
                finalValue,
                targetType as Function,
                transformKey,
                value,
                this.transformationType
              );
              // If nothing change, it means no custom transformation was applied, so use the subValue.
              finalValue = value[transformKey] === finalValue ? subValue : finalValue;
            } else {
              finalValue = subValue;
            }
            // Apply the default transformation
            finalValue = this.transform(subSource, finalValue, type, arrayType, isSubValueMap, level + 1);
          } else {
            if (subValue === undefined && this.options.exposeDefaultValues) {
              // Set default value if nothing provided
              finalValue = newValue[newValueKey];
            } else {
              finalValue = this.transform(subSource, subValue, type, arrayType, isSubValueMap, level + 1);
              if (hasTransforms) {
                finalValue = this.applyCustomTransformations(
                  finalValue,
                  targetType as Function,
                  transformKey,
                  value,
                  this.transformationType
                );
              }
            }
          }

          if (finalValue !== undefined || this.options.exposeUnsetFields) {
            if (newValue instanceof Map) {
              newValue.set(newValueKey, finalValue);
            } else {
              newValue[newValueKey] = finalValue;
            }
          }
        } else if (this.transformationType === TransformationType.CLASS_TO_CLASS) {
          let finalValue = subValue;
          if (hasTransforms) {
            finalValue = this.applyCustomTransformations(
              finalValue,
              targetType as Function,
              key,
              value,
              this.transformationType
            );
          }
          if (finalValue !== undefined || this.options.exposeUnsetFields) {
            if (newValue instanceof Map) {
              newValue.set(newValueKey, finalValue);
            } else {
              newValue[newValueKey] = finalValue;
            }
          }
        }
      }

      if (this.options.enableCircularCheck) {
        this.recursionStack.delete(value);
      }

      return newValue;
    } else {
      return value;
    }
  }

  /**
   * Transforms a single element of an array/set and appends it to `newValue`.
   * Extracted from the array branch so the iteration can use a plain loop (no
   * per-array closure). `index` is the array index, or — matching `Set.forEach` —
   * the element itself when iterating a Set.
   */
  private transformArrayItem(
    source: any,
    subValue: any,
    index: any,
    targetType: Function | TypeMetadata | undefined,
    newValue: Array<any> | Set<any>,
    level: number
  ): void {
    const subSource = source ? source[index] : undefined;
    if (!this.options.enableCircularCheck || !this.isCircular(subValue)) {
      let realTargetType;
      if (
        typeof targetType !== 'function' &&
        targetType &&
        targetType.options &&
        targetType.options.discriminator &&
        targetType.options.discriminator.property &&
        targetType.options.discriminator.subTypes
      ) {
        const discriminator = targetType.options.discriminator;
        if (this.transformationType === TransformationType.PLAIN_TO_CLASS) {
          realTargetType = discriminator.subTypes.find(subType => subType.name === subValue[discriminator.property]);
          const options: TypeHelpOptions = { newObject: newValue, object: subValue, property: undefined };
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const newType = targetType.typeFunction!(options);
          if (realTargetType === undefined) {
            realTargetType = newType;
          } else {
            realTargetType = realTargetType.value;
          }
          if (!targetType.options.keepDiscriminatorProperty) delete subValue[discriminator.property];
        }

        if (this.transformationType === TransformationType.CLASS_TO_CLASS) {
          realTargetType = subValue.constructor;
        }
        if (this.transformationType === TransformationType.CLASS_TO_PLAIN) {
          const matchedSubType = discriminator.subTypes.find(subType => subType.value === subValue.constructor);
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          subValue[discriminator.property] = matchedSubType!.name;
        }
      } else {
        realTargetType = targetType;
      }
      const transformed = this.transform(
        subSource,
        subValue,
        realTargetType,
        undefined,
        subValue instanceof Map,
        level + 1
      );

      if (newValue instanceof Set) {
        newValue.add(transformed);
      } else {
        newValue.push(transformed);
      }
    } else if (this.transformationType === TransformationType.CLASS_TO_CLASS) {
      if (newValue instanceof Set) {
        newValue.add(subValue);
      } else {
        newValue.push(subValue);
      }
    }
  }

  private applyCustomTransformations(
    value: any,
    target: Function,
    key: string,
    obj: any,
    transformationType: TransformationType
  ): any {
    const metadatas = this.getTransformMetadatas(target, key);
    for (let i = 0; i < metadatas.length; i++) {
      value = metadatas[i].transformFn({ value, key, obj, type: transformationType, options: this.options });
    }
    return value;
  }

  /**
   * Resolves the @Transform metadatas for (target, key) after version/group
   * filtering, memoized for this executor. The selection depends only on
   * (target, key) since the options are fixed per operation.
   */
  private getTransformMetadatas(target: Function, key: string): TransformMetadata[] {
    let byKey = this._transformMetadatasCache.get(target);
    if (byKey) {
      const cached = byKey.get(key);
      if (cached) return cached;
    } else {
      byKey = new Map<string, TransformMetadata[]>();
      this._transformMetadatasCache.set(target, byKey);
    }

    let metadatas = defaultMetadataStorage.findTransformMetadatas(target, key, this.transformationType);
    // Only the non-empty case needs version/group filtering (each filter allocates).
    if (metadatas.length > 0) {
      if (this.options.version !== undefined) {
        metadatas = metadatas.filter(metadata => {
          if (!metadata.options) return true;
          return this.checkVersion(metadata.options.since, metadata.options.until);
        });
      }
      if (this.options.groups && this.options.groups.length) {
        metadatas = metadatas.filter(metadata => {
          if (!metadata.options) return true;
          return this.checkGroups(metadata.options.groups);
        });
      } else {
        metadatas = metadatas.filter(metadata => {
          return !metadata.options || !metadata.options.groups || !metadata.options.groups.length;
        });
      }
    }

    byKey.set(key, metadatas);
    return metadatas;
  }

  // preventing circular references
  private isCircular(object: Record<string, any>): boolean {
    return this.recursionStack.has(object);
  }

  private getKeys(target: Function, object: Record<string, any>, isMap: boolean): string[] {
    // determine exclusion strategy
    let strategy = defaultMetadataStorage.getStrategy(target);
    if (strategy === 'none') strategy = this.options.strategy || 'exposeAll'; // exposeAll is default strategy

    // get all keys that need to expose
    let keys: any[] = [];
    // Object.keys / Map keys are already unique, and every filter pass below
    // preserves uniqueness — so a final dedup is only required once we merge in
    // metadata-derived property lists. Track that to skip it in the common case.
    let needsDedup = false;
    if (strategy === 'exposeAll' || isMap) {
      if (object instanceof Map) {
        keys = Array.from(object.keys());
      } else {
        keys = Object.keys(object);
      }
    }

    if (isMap) {
      // expose & exclude do not apply for map keys only to fields
      return keys;
    }

    /**
     * If decorators are ignored but we don't want the extraneous values, then we use the
     * metadata to decide which property is needed, but doesn't apply the decorator effect.
     */
    if (this.options.ignoreDecorators && this.options.excludeExtraneousValues && target) {
      const exposedProperties = defaultMetadataStorage.getExposedProperties(target, this.transformationType);
      const excludedProperties = defaultMetadataStorage.getExcludedProperties(target, this.transformationType);
      keys = [...exposedProperties, ...excludedProperties];
      needsDedup = true;
    }

    if (!this.options.ignoreDecorators && target) {
      // add all exposed to list of keys. For PLAIN_TO_CLASS the @Expose({ name })
      // rename is applied; both variants are memoized per target in the storage.
      const exposedProperties =
        this.transformationType === TransformationType.PLAIN_TO_CLASS
          ? defaultMetadataStorage.getExposedPropertiesForPlainToClass(target)
          : defaultMetadataStorage.getExposedProperties(target, this.transformationType);
      if (this.options.excludeExtraneousValues) {
        keys = exposedProperties;
        needsDedup = true;
      } else if (exposedProperties.length > 0) {
        // Merge object keys with exposed properties, deduped in a single pass.
        // Preserves first-seen order (object keys before newly-added exposed ones,
        // matching the old concat + dedup-first-wins) while avoiding a separate
        // concat array and the final Set/Array round-trip — so no later dedup.
        const merged = new Set<string>(keys);
        for (let i = 0; i < exposedProperties.length; i++) {
          merged.add(exposedProperties[i]);
        }
        keys = Array.from(merged);
      }

      // exclude excluded properties
      const excludedProperties = defaultMetadataStorage.getExcludedProperties(target, this.transformationType);
      if (excludedProperties.length > 0) {
        keys = keys.filter(key => {
          return !excludedProperties.includes(key);
        });
      }

      // apply versioning options
      if (this.options.version !== undefined) {
        keys = keys.filter(key => {
          const exposeMetadata = defaultMetadataStorage.findExposeMetadata(target, key);
          if (!exposeMetadata || !exposeMetadata.options) return true;

          return this.checkVersion(exposeMetadata.options.since, exposeMetadata.options.until);
        });
      }

      // apply grouping options
      if (this.options.groups && this.options.groups.length) {
        keys = keys.filter(key => {
          const exposeMetadata = defaultMetadataStorage.findExposeMetadata(target, key);
          if (!exposeMetadata || !exposeMetadata.options) return true;

          return this.checkGroups(exposeMetadata.options.groups);
        });
      } else {
        // No groups requested: drop properties restricted to a group. The set of
        // grouped property names is memoized per target, so when a class has none
        // (the common case) we skip the filtering pass — and its allocation — entirely.
        const groupedProperties = defaultMetadataStorage.getGroupedPropertyNames(target);
        if (groupedProperties.size > 0) {
          keys = keys.filter(key => !groupedProperties.has(key));
        }
      }
    }

    // exclude prefixed properties
    if (this.options.excludePrefixes && this.options.excludePrefixes.length) {
      const excludePrefixes = this.options.excludePrefixes;
      keys = keys.filter(key =>
        excludePrefixes.every(prefix => {
          return key.substr(0, prefix.length) !== prefix;
        })
      );
    }

    // make sure we have unique keys — only when metadata-derived lists were merged
    // in above. Set preserves first-seen order; O(n) vs the old O(n²) indexOf filter.
    if (needsDedup) {
      keys = Array.from(new Set(keys));
    }

    return keys;
  }

  private checkVersion(since?: number, until?: number): boolean {
    const version = this.options.version;
    let decision = true;
    if (decision && since) decision = version !== undefined && version >= since;
    if (decision && until) decision = version !== undefined && version < until;

    return decision;
  }

  private checkGroups(groups?: string[]): boolean {
    if (!groups) return true;

    const optionGroups = this.options.groups;
    return optionGroups !== undefined && optionGroups.some(optionGroup => groups.includes(optionGroup));
  }
}
