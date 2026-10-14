import { createMessages } from "vite-plugin-paraglide-sugar/runtime";

export const text = createMessages<typeof import("./generated/messages.js")>();
