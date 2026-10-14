import { text } from "#app/messages";
import { setLocale } from "./generated/runtime.js";

setLocale("en", { reload: false });

export const greeting = text.hello;
export const welcome = text.welcome._({ name: "Ada" });
