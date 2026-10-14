import { compileProject } from "@inlang/paraglide-js";
import { insertBundleNested, loadProjectInMemory, newProject } from "@inlang/sdk";

/**
 * Compile real Paraglide output without loading an external resource plugin.
 * This keeps package tests independent of network-hosted translation plugins.
 *
 * @returns {Promise<Record<string, string>>}
 */
export async function compileCatalog() {
  const project = await loadProjectInMemory({
    blob: await newProject({
      settings: { baseLocale: "en", locales: ["en", "ko"], modules: [] },
    }),
  });
  try {
    const labels = [
      ["hello", "Hello", "안녕"],
      ["footer.terms", "Terms", "약관"],
      ["status_MixedCase", "Mixed case", "대소문자"],
      ["color_red", "Red", "빨강"],
      ["color_blue", "Blue", "파랑"],
      ["lazy_only", "LAZY_TRANSLATION_SENTINEL", "LAZY_TRANSLATION_SENTINEL_KO"],
      ["unused", "UNUSED_TRANSLATION_SENTINEL", "UNUSED_TRANSLATION_SENTINEL_KO"],
    ];
    for (const [id, en, ko] of [...labels, ["welcome", "Welcome, ", "환영합니다, "]]) {
      await insertBundleNested(project.db, {
        id,
        declarations: id === "welcome" ? [{ type: "input-variable", name: "name" }] : [],
        messages: [en, ko].map((text, index) => {
          const locale = ["en", "ko"][index];
          const messageId = `${id}_${locale}`;
          return {
            id: messageId,
            bundleId: id,
            locale,
            selectors: [],
            variants: [
              {
                id: `${messageId}_variant`,
                messageId,
                matches: [],
                pattern: [
                  { type: "text", value: text },
                  ...(id === "welcome"
                    ? [{ type: "expression", arg: { type: "variable-reference", name: "name" } }]
                    : []),
                ],
              },
            ],
          };
        }),
      });
    }
    return await compileProject({
      project,
      compilerOptions: {
        outputStructure: "message-modules",
        emitTsDeclarations: true,
        emitGitIgnore: false,
        emitPrettierIgnore: false,
        strategy: ["globalVariable"],
      },
    });
  } finally {
    await project.close();
  }
}
