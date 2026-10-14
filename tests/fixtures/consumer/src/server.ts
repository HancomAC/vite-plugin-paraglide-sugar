import { render } from "svelte/server";
import { read } from "./main.js";
import Component from "./Entry.svelte";

export function request(locale: "en" | "ko", name: string) {
  return { ...read(locale, name), html: render(Component, { props: { name } }).body };
}
