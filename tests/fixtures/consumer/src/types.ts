import "vite-plugin-paraglide-sugar/virtual";
import paraglideSugar, { paraglideSugar as named } from "vite-plugin-paraglide-sugar";
import viteEntry from "vite-plugin-paraglide-sugar/vite";
import { messages } from "virtual:paraglide-sugar/messages/color_";
import { text } from "./i18n.js";

paraglideSugar({ outdir: "src/generated", importSource: "#app/messages" });
named({ outdir: "src/generated", importSource: "#app/messages", exportName: "text" });
viteEntry({ outdir: "src/generated", importSource: "#app/messages", missingKey: "undefined" });

const label: string = text.hello;
const greeting: string = text.welcome._({ name: "Ada" });
const localized: string = text.hello._({}, { locale: "ko" });
const dotted: string = text["footer.terms"];
const color: string | undefined = messages.color_red?.();
void [label, greeting, localized, dotted, color];

// @ts-expect-error: Catalog key completion must retain the original generated keys.
void text.not_a_key;
// @ts-expect-error: Required message inputs must remain required.
text.welcome._();
// @ts-expect-error: Generated locale options must retain their literal union.
text.hello._({}, { locale: "zz" });
