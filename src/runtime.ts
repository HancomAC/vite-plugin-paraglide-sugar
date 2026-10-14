export type Message = (...args: any[]) => string;

/** Types for compile-time property access; non-message module exports are excluded. */
export type Messages<Catalog> = {
  readonly [Key in keyof Catalog as Catalog[Key] extends Message
    ? Key
    : never]: Catalog[Key] extends Message
    ? [] extends Parameters<Catalog[Key]>
      ? ReturnType<Catalog[Key]> & { readonly _: Catalog[Key] }
      : { readonly _: Catalog[Key] }
    : never;
};

/**
 * Declare a typed compiler marker without importing the catalog at runtime.
 * The Vite plugin removes static accesses. An untransformed access is an error.
 */
export function createMessages<Catalog>(): Messages<Catalog> {
  return new Proxy(Object.create(null), {
    get(_target, key) {
      throw new Error(
        `[paraglide-sugar] Uncompiled message access ${String(key)}. Configure the plugin importSource, exportName and sourceRoots for this consumer.`,
      );
    },
  }) as Messages<Catalog>;
}

/** Read at render/request time. No locale cache or exception suppression. */
export function resolveMessage<F extends Message>(message: F): ReturnType<F> | { readonly _: F } {
  return message.length > 0 ? { _: message } : (message() as ReturnType<F>);
}
