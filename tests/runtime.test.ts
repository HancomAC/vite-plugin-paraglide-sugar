import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createMessages, resolveMessage, type Messages } from "../src/runtime.js";

describe("message runtime", () => {
  it("resolves the current locale on every value read", () => {
    let locale = "en";
    const message = () => (locale === "en" ? "Hello" : "Bonjour");
    expect(resolveMessage(message)).toBe("Hello");
    locale = "fr";
    expect(resolveMessage(message)).toBe("Bonjour");
  });

  it("defers required inputs without changing function identity or arguments", () => {
    const inputs = { name: "Ada" };
    const options = { locale: "fr" };
    const message = vi.fn(
      (value: typeof inputs, settings: typeof options) => `${settings.locale}:${value.name}`,
    );
    const value = resolveMessage(message) as { _: typeof message };
    expect(message).not.toHaveBeenCalled();
    expect(value._).toBe(message);
    expect(value._(inputs, options)).toBe("fr:Ada");
    expect(message.mock.calls[0][0]).toBe(inputs);
    expect(message.mock.calls[0][1]).toBe(options);
  });

  it("propagates translation errors for immediate and deferred calls", () => {
    const error = new Error("Invalid interpolation");
    expect(() =>
      resolveMessage(() => {
        throw error;
      }),
    ).toThrow(error);
    const message = (_inputs: { name: string }) => {
      throw error;
    };
    const value = resolveMessage(message) as { _: typeof message };
    expect(() => value._({ name: "Ada" })).toThrow(error);
  });

  it("does not reinterpret default-parameter errors as deferred messages", () => {
    const message = (inputs: { name?: string } = {}) => {
      if (!inputs.name) throw new Error("name is required");
      return inputs.name;
    };
    expect(() => resolveMessage(message)).toThrow("name is required");
  });

  it("fails clearly when the configured transform has not run", () => {
    const messages = createMessages<{ hello: () => string }>();
    expect(() => messages.hello).toThrow(/Uncompiled message access hello.*importSource/);
    expect(() => (messages as any).__proto__).toThrow(/Uncompiled message access/);
  });

  it("retains catalog keys, inputs, locale options and readonly access", () => {
    type Catalog = {
      hello: () => string;
      welcome: (inputs: { name: string }, options?: { locale: "en" | "fr" }) => string;
      metadata: number;
      m: { hello: () => string };
    };
    type Sugar = Messages<Catalog>;
    expectTypeOf<keyof Sugar>().toEqualTypeOf<"hello" | "welcome">();
    expectTypeOf<Sugar["hello"]>().toMatchTypeOf<string>();
    expectTypeOf<Sugar["welcome"]["_"]>().toEqualTypeOf<Catalog["welcome"]>();
    expectTypeOf<Sugar["welcome"]>().not.toMatchTypeOf<string>();
    const marker = createMessages<Catalog>();
    expectTypeOf(marker).toEqualTypeOf<Sugar>();
    function invalidTypes(messages: Sugar) {
      // @ts-expect-error The marker has no non-message properties.
      void messages.metadata;
      // @ts-expect-error Required inputs remain required.
      messages.welcome._();
      // @ts-expect-error Locale options retain their literal union.
      messages.welcome._({ name: "Ada" }, { locale: "de" });
      // @ts-expect-error Message keys are readonly.
      messages.hello = "overwritten";
    }
    expectTypeOf(invalidTypes).toBeFunction();
  });
});
