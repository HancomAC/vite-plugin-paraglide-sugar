declare module "virtual:paraglide-sugar/messages/*" {
  /** Full message keys with the requested prefix; missing keys are undefined. */
  export const messages: Readonly<Record<string, ((...args: any[]) => string) | undefined>>;
}
