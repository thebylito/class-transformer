// TODO: Document this interface. What does each property means?
export interface TypeHelpOptions {
  newObject: any;
  object: Record<string, any>;
  /** The property being transformed, or `undefined` for array-level (discriminator) types. */
  property: string | undefined;
}
