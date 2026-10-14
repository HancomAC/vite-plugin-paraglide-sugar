import { text as t } from "#app/messages";
import { messages } from "virtual:paraglide-sugar/messages/color_";
import { setLocale } from "./generated/runtime.js";

export { default as Component } from "./Entry.svelte";
export const lazy = () => import("./lazy.js");

export function read(locale: "en" | "ko", name: string) {
  setLocale(locale, { reload: false });
  const alias = t;
  return {
    label: alias.hello,
    welcome: alias.welcome._({ name }),
    terms: alias["footer.terms"],
    color: messages.color_red?.(),
  };
}
