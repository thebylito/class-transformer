import { TypeMetadata, ExposeMetadata, ExcludeMetadata, TransformMetadata } from './interfaces';
import { TransformationType } from './enums';

/**
 * Shared empty result returned for targets with no @Transform metadata, so the
 * (per-key) lookup in the hot path allocates nothing in the common case. Treated
 * as read-only by callers (`applyCustomTransformations` returns early on length 0).
 */
const EMPTY_TRANSFORM_METADATAS: TransformMetadata[] = [];

/**
 * Storage all library metadata.
 */
export class MetadataStorage {
  // -------------------------------------------------------------------------
  // Properties
  // -------------------------------------------------------------------------

  // Inner-map keys are `string | undefined`: a class-level @Expose/@Exclude is
  // stored under the `undefined` key (see getStrategy), while property-level
  // decorators use the property name.
  private _typeMetadatas = new Map<Function, Map<string | undefined, TypeMetadata>>();
  private _transformMetadatas = new Map<Function, Map<string | undefined, TransformMetadata[]>>();
  private _exposeMetadatas = new Map<Function, Map<string | undefined, ExposeMetadata>>();
  private _excludeMetadatas = new Map<Function, Map<string | undefined, ExcludeMetadata>>();
  private _ancestorsMap = new Map<Function, Function[]>();

  /**
   * Derived, memoized lookups computed from the (immutable-after-decoration)
   * expose/exclude metadata above. They are invalidated whenever new expose or
   * exclude metadata is registered (or on `clear()`), so they stay correct even
   * when classes are decorated lazily.
   */
  private _strategyCache = new Map<Function, 'excludeAll' | 'exposeAll' | 'none'>();
  private _exposedMetadatasCache = new Map<Function, ExposeMetadata[]>();
  private _excludedMetadatasCache = new Map<Function, ExcludeMetadata[]>();
  private _exposedPropertiesCache = new Map<Function, Map<TransformationType, string[]>>();
  private _excludedPropertiesCache = new Map<Function, Map<TransformationType, string[]>>();
  private _exposedNamesPlainToClassCache = new Map<Function, string[]>();
  private _groupedPropertiesCache = new Map<Function, Set<string>>();
  private _exposeByCustomNameCache = new Map<Function, Map<string, ExposeMetadata>>();
  /** Whether a target (or any ancestor) has ANY @Transform metadata. */
  private _hasTransformMetadataCache = new Map<Function, boolean>();
  /** External listeners invalidated whenever metadata changes (e.g. compiled plans). */
  private _invalidationListeners: Array<() => void> = [];

  // -------------------------------------------------------------------------
  // Adder Methods
  // -------------------------------------------------------------------------

  addTypeMetadata(metadata: TypeMetadata): void {
    let map = this._typeMetadatas.get(metadata.target);
    if (!map) {
      map = new Map<string | undefined, TypeMetadata>();
      this._typeMetadatas.set(metadata.target, map);
    }
    map.set(metadata.propertyName, metadata);
    this.notifyInvalidation();
  }

  addTransformMetadata(metadata: TransformMetadata): void {
    let map = this._transformMetadatas.get(metadata.target);
    if (!map) {
      map = new Map<string | undefined, TransformMetadata[]>();
      this._transformMetadatas.set(metadata.target, map);
    }
    let list = map.get(metadata.propertyName);
    if (!list) {
      list = [];
      map.set(metadata.propertyName, list);
    }
    list.push(metadata);
    this._hasTransformMetadataCache.clear();
    this.notifyInvalidation();
  }

  addExposeMetadata(metadata: ExposeMetadata): void {
    let map = this._exposeMetadatas.get(metadata.target);
    if (!map) {
      map = new Map<string | undefined, ExposeMetadata>();
      this._exposeMetadatas.set(metadata.target, map);
    }
    map.set(metadata.propertyName, metadata);
    this.clearDerivedCaches();
  }

  addExcludeMetadata(metadata: ExcludeMetadata): void {
    let map = this._excludeMetadatas.get(metadata.target);
    if (!map) {
      map = new Map<string | undefined, ExcludeMetadata>();
      this._excludeMetadatas.set(metadata.target, map);
    }
    map.set(metadata.propertyName, metadata);
    this.clearDerivedCaches();
  }

  // -------------------------------------------------------------------------
  // Public Methods
  // -------------------------------------------------------------------------

  findTransformMetadatas(
    target: Function,
    propertyName: string,
    transformationType: TransformationType
  ): TransformMetadata[] {
    // Fast path: most classes have no @Transform at all. Skip the ancestor walk and
    // the slice/reverse/concat/filter allocations entirely for them.
    if (!this.hasAnyTransformMetadata(target)) {
      return EMPTY_TRANSFORM_METADATAS;
    }
    return this.findMetadatas(this._transformMetadatas, target, propertyName).filter(metadata => {
      if (!metadata.options) return true;
      if (metadata.options.toClassOnly === true && metadata.options.toPlainOnly === true) return true;

      if (metadata.options.toClassOnly === true) {
        return (
          transformationType === TransformationType.CLASS_TO_CLASS ||
          transformationType === TransformationType.PLAIN_TO_CLASS
        );
      }
      if (metadata.options.toPlainOnly === true) {
        return transformationType === TransformationType.CLASS_TO_PLAIN;
      }

      return true;
    });
  }

  /**
   * Whether the target (or any ancestor) declares any @Transform at all. Lets the
   * caller skip the per-key custom-transformation lookup for the common case of
   * classes with no @Transform decorators.
   */
  hasTransformMetadata(target: Function): boolean {
    return this.hasAnyTransformMetadata(target);
  }

  /** All @Type metadata for a target (including inherited), used by the compiled fast path. */
  getTypeMetadatas(target: Function): TypeMetadata[] {
    return this.getMetadata(this._typeMetadatas, target);
  }

  /** Property names carrying @Transform metadata on a target (including inherited). */
  getTransformPropertyNames(target: Function): string[] {
    const names = new Set<string>();
    const collect = (t: Function): void => {
      const map = this._transformMetadatas.get(t);
      if (map) for (const key of Array.from(map.keys())) if (key !== undefined) names.add(key);
    };
    collect(target);
    for (const ancestor of this.getAncestors(target)) collect(ancestor);
    return Array.from(names);
  }

  /**
   * Registers a listener fired whenever any metadata changes (add / clear). Used to
   * invalidate caches derived outside this class, such as compiled transform plans.
   */
  onInvalidate(listener: () => void): void {
    this._invalidationListeners.push(listener);
  }

  findExcludeMetadata(target: Function, propertyName: string): ExcludeMetadata | undefined {
    return this.findMetadata(this._excludeMetadatas, target, propertyName);
  }

  findExposeMetadata(target: Function, propertyName: string): ExposeMetadata | undefined {
    return this.findMetadata(this._exposeMetadatas, target, propertyName);
  }

  findExposeMetadataByCustomName(target: Function, name: string): ExposeMetadata | undefined {
    // Looked up per key during PLAIN_TO_CLASS; back it with a memoized
    // customName -> metadata map so it is O(1) and allocates no scan closure.
    return this.getExposeMetadataByCustomNameMap(target).get(name);
  }

  findTypeMetadata(target: Function, propertyName: string): TypeMetadata | undefined {
    return this.findMetadata(this._typeMetadatas, target, propertyName);
  }

  getStrategy(target: Function): 'excludeAll' | 'exposeAll' | 'none' {
    const cached = this._strategyCache.get(target);
    if (cached !== undefined) return cached;

    const excludeMap = this._excludeMetadatas.get(target);
    const exclude = excludeMap && excludeMap.get(undefined);
    const exposeMap = this._exposeMetadatas.get(target);
    const expose = exposeMap && exposeMap.get(undefined);
    let strategy: 'excludeAll' | 'exposeAll' | 'none';
    if ((exclude && expose) || (!exclude && !expose)) strategy = 'none';
    else strategy = exclude ? 'excludeAll' : 'exposeAll';

    this._strategyCache.set(target, strategy);
    return strategy;
  }

  getExposedMetadatas(target: Function): ExposeMetadata[] {
    let cached = this._exposedMetadatasCache.get(target);
    if (cached) return cached;
    // memoized + shared — callers (filter/find/map) must not mutate the array
    cached = this.getMetadata(this._exposeMetadatas, target);
    this._exposedMetadatasCache.set(target, cached);
    return cached;
  }

  getExcludedMetadatas(target: Function): ExcludeMetadata[] {
    let cached = this._excludedMetadatasCache.get(target);
    if (cached) return cached;
    // memoized + shared — see getExposedMetadatas
    cached = this.getMetadata(this._excludeMetadatas, target);
    this._excludedMetadatasCache.set(target, cached);
    return cached;
  }

  getExposedProperties(target: Function, transformationType: TransformationType): string[] {
    let byType = this._exposedPropertiesCache.get(target);
    if (byType) {
      const cached = byType.get(transformationType);
      if (cached) return cached;
    } else {
      byType = new Map<TransformationType, string[]>();
      this._exposedPropertiesCache.set(target, byType);
    }

    // NOTE: the returned array is memoized and shared — callers must treat it as
    // immutable (the transform executor only reads / re-derives via concat/filter).
    const properties = this.getExposedMetadatas(target)
      .filter(metadata => {
        if (!metadata.options) return true;
        if (metadata.options.toClassOnly === true && metadata.options.toPlainOnly === true) return true;

        if (metadata.options.toClassOnly === true) {
          return (
            transformationType === TransformationType.CLASS_TO_CLASS ||
            transformationType === TransformationType.PLAIN_TO_CLASS
          );
        }
        if (metadata.options.toPlainOnly === true) {
          return transformationType === TransformationType.CLASS_TO_PLAIN;
        }

        return true;
      })
      // getMetadata() already filters out undefined propertyNames, so this is a string.
      .map(metadata => metadata.propertyName as string);

    byType.set(transformationType, properties);
    return properties;
  }

  getExcludedProperties(target: Function, transformationType: TransformationType): string[] {
    let byType = this._excludedPropertiesCache.get(target);
    if (byType) {
      const cached = byType.get(transformationType);
      if (cached) return cached;
    } else {
      byType = new Map<TransformationType, string[]>();
      this._excludedPropertiesCache.set(target, byType);
    }

    // NOTE: memoized and shared — see getExposedProperties.
    const properties = this.getExcludedMetadatas(target)
      .filter(metadata => {
        if (!metadata.options) return true;
        if (metadata.options.toClassOnly === true && metadata.options.toPlainOnly === true) return true;

        if (metadata.options.toClassOnly === true) {
          return (
            transformationType === TransformationType.CLASS_TO_CLASS ||
            transformationType === TransformationType.PLAIN_TO_CLASS
          );
        }
        if (metadata.options.toPlainOnly === true) {
          return transformationType === TransformationType.CLASS_TO_PLAIN;
        }

        return true;
      })
      // getMetadata() already filters out undefined propertyNames, so this is a string.
      .map(metadata => metadata.propertyName as string);

    byType.set(transformationType, properties);
    return properties;
  }

  /**
   * Exposed property names for PLAIN_TO_CLASS with the `@Expose({ name })` rename
   * already applied. The mapping depends only on the target, so it is memoized
   * instead of being rebuilt (with a per-property metadata lookup) for every object.
   */
  getExposedPropertiesForPlainToClass(target: Function): string[] {
    let cached = this._exposedNamesPlainToClassCache.get(target);
    if (cached) return cached;

    // NOTE: memoized and shared — callers must treat it as immutable.
    cached = this.getExposedProperties(target, TransformationType.PLAIN_TO_CLASS).map(propertyName => {
      const exposeMetadata = this.findExposeMetadata(target, propertyName);
      return exposeMetadata && exposeMetadata.options && exposeMetadata.options.name
        ? exposeMetadata.options.name
        : propertyName;
    });
    this._exposedNamesPlainToClassCache.set(target, cached);
    return cached;
  }

  /**
   * Set of property names that are restricted to one or more groups via
   * `@Expose({ groups })`. Used to drop group-only properties when no group is
   * requested; memoized so the common "no grouped properties" case can skip the
   * per-object filtering pass entirely.
   */
  getGroupedPropertyNames(target: Function): Set<string> {
    let cached = this._groupedPropertiesCache.get(target);
    if (cached) return cached;

    cached = new Set<string>();
    for (const metadata of this.getExposedMetadatas(target)) {
      if (
        metadata.propertyName !== undefined &&
        metadata.options &&
        metadata.options.groups &&
        metadata.options.groups.length
      ) {
        cached.add(metadata.propertyName);
      }
    }
    this._groupedPropertiesCache.set(target, cached);
    return cached;
  }

  clear(): void {
    this._typeMetadatas.clear();
    this._exposeMetadatas.clear();
    this._excludeMetadatas.clear();
    this._ancestorsMap.clear();
    this.clearDerivedCaches();
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /** Drop memoized strategy / exposed / excluded lookups (call on any metadata change). */
  private clearDerivedCaches(): void {
    this._strategyCache.clear();
    this._exposedMetadatasCache.clear();
    this._excludedMetadatasCache.clear();
    this._exposedPropertiesCache.clear();
    this._excludedPropertiesCache.clear();
    this._exposedNamesPlainToClassCache.clear();
    this._groupedPropertiesCache.clear();
    this._exposeByCustomNameCache.clear();
    this._hasTransformMetadataCache.clear();
    this.notifyInvalidation();
  }

  private notifyInvalidation(): void {
    for (let i = 0; i < this._invalidationListeners.length; i++) this._invalidationListeners[i]();
  }

  /** Memoized map of `@Expose({ name })` custom name -> metadata for a target (first-wins). */
  private getExposeMetadataByCustomNameMap(target: Function): Map<string, ExposeMetadata> {
    let cached = this._exposeByCustomNameCache.get(target);
    if (cached) return cached;

    cached = new Map<string, ExposeMetadata>();
    for (const metadata of this.getExposedMetadatas(target)) {
      if (metadata.options && metadata.options.name !== undefined && !cached.has(metadata.options.name)) {
        cached.set(metadata.options.name, metadata);
      }
    }
    this._exposeByCustomNameCache.set(target, cached);
    return cached;
  }

  /** Whether the target or any of its ancestors carries any @Transform metadata (memoized). */
  private hasAnyTransformMetadata(target: Function): boolean {
    const cached = this._hasTransformMetadataCache.get(target);
    if (cached !== undefined) return cached;

    let result = this._transformMetadatas.has(target);
    if (!result) {
      for (const ancestor of this.getAncestors(target)) {
        if (this._transformMetadatas.has(ancestor)) {
          result = true;
          break;
        }
      }
    }
    this._hasTransformMetadataCache.set(target, result);
    return result;
  }

  private getMetadata<T extends { target: Function; propertyName: string | undefined }>(
    metadatas: Map<Function, Map<string | undefined, T>>,
    target: Function
  ): T[] {
    const metadataFromTargetMap = metadatas.get(target);
    let metadataFromTarget: T[] | undefined;
    if (metadataFromTargetMap) {
      metadataFromTarget = Array.from(metadataFromTargetMap.values()).filter(meta => meta.propertyName !== undefined);
    }
    const metadataFromAncestors: T[] = [];
    for (const ancestor of this.getAncestors(target)) {
      const ancestorMetadataMap = metadatas.get(ancestor);
      if (ancestorMetadataMap) {
        const metadataFromAncestor = Array.from(ancestorMetadataMap.values()).filter(
          meta => meta.propertyName !== undefined
        );
        metadataFromAncestors.push(...metadataFromAncestor);
      }
    }
    return metadataFromAncestors.concat(metadataFromTarget || []);
  }

  private findMetadata<T extends { target: Function; propertyName: string | undefined }>(
    metadatas: Map<Function, Map<string | undefined, T>>,
    target: Function,
    propertyName: string
  ): T | undefined {
    const metadataFromTargetMap = metadatas.get(target);
    if (metadataFromTargetMap) {
      const metadataFromTarget = metadataFromTargetMap.get(propertyName);
      if (metadataFromTarget) {
        return metadataFromTarget;
      }
    }
    for (const ancestor of this.getAncestors(target)) {
      const ancestorMetadataMap = metadatas.get(ancestor);
      if (ancestorMetadataMap) {
        const ancestorResult = ancestorMetadataMap.get(propertyName);
        if (ancestorResult) {
          return ancestorResult;
        }
      }
    }
    return undefined;
  }

  private findMetadatas<T extends { target: Function; propertyName: string | undefined }>(
    metadatas: Map<Function, Map<string | undefined, T[]>>,
    target: Function,
    propertyName: string
  ): T[] {
    const metadataFromTargetMap = metadatas.get(target);
    let metadataFromTarget: T[] | undefined;
    if (metadataFromTargetMap) {
      metadataFromTarget = metadataFromTargetMap.get(propertyName);
    }
    const metadataFromAncestorsTarget: T[] = [];
    for (const ancestor of this.getAncestors(target)) {
      const ancestorMetadataMap = metadatas.get(ancestor);
      if (ancestorMetadataMap) {
        const ancestorMetadata = ancestorMetadataMap.get(propertyName);
        if (ancestorMetadata) {
          metadataFromAncestorsTarget.push(...ancestorMetadata);
        }
      }
    }
    return metadataFromAncestorsTarget
      .slice()
      .reverse()
      .concat((metadataFromTarget || []).slice().reverse());
  }

  private getAncestors(target: Function): Function[] {
    if (!target) return [];
    let ancestors = this._ancestorsMap.get(target);
    if (!ancestors) {
      ancestors = [];
      for (
        let baseClass = Object.getPrototypeOf(target.prototype.constructor);
        typeof baseClass.prototype !== 'undefined';
        baseClass = Object.getPrototypeOf(baseClass.prototype.constructor)
      ) {
        ancestors.push(baseClass);
      }
      this._ancestorsMap.set(target, ancestors);
    }
    return ancestors;
  }
}
