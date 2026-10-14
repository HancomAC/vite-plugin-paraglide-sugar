import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { MessageExport } from "./transform.js";

/** Read real ESM exports; Paraglide file stems are not message identifiers. */
export function readMessageManifest(entryFile: string): Map<string, MessageExport> {
  type ResolvedExport = { message: MessageExport; binding: string };
  // An ambiguous name must survive through parent star exports, even though it
  // will not be exposed in the final message manifest.
  type ModuleExports = Map<string, ResolvedExport | undefined>;
  const cache = new Map<string, ModuleExports>();
  const active = new Set<string>();
  function read(file: string): ModuleExports {
    const cached = cache.get(file);
    if (cached) return cached;
    if (active.has(file))
      throw new Error(`[paraglide-sugar] Circular message re-export in ${file}`);
    active.add(file);
    let code: string;
    try {
      code = fs.readFileSync(file, "utf8");
    } catch (cause) {
      throw new Error(
        `[paraglide-sugar] Cannot read ${file}. Run Paraglide before paraglideSugar with outputStructure: 'message-modules'.`,
        { cause },
      );
    }
    const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const diagnostics = (ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
      .parseDiagnostics;
    if (diagnostics.length) {
      throw new Error(
        `[paraglide-sugar] Invalid generated module ${file}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n")}`,
      );
    }
    const entries: ModuleExports = new Map();
    const stars: ModuleExports = new Map();
    const namespaces = new Map<string, ModuleExports>();
    const direct = (name: string, localName = name): ResolvedExport => ({
      message: { source: file.split(path.sep).join("/"), exportName: name },
      // Different exported aliases can identify the same local binding. Comparing
      // export names would incorrectly reject valid diamond re-exports.
      binding: `${file}\0${localName}`,
    });
    for (const statement of ast.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        const specifier = statement.moduleSpecifier;
        let child: ModuleExports | undefined;
        if (specifier && ts.isStringLiteral(specifier)) {
          if (!specifier.text.startsWith(".")) {
            throw new Error(
              `[paraglide-sugar] Message re-exports must be local modules: ${specifier.text}`,
            );
          }
          child = read(path.resolve(path.dirname(file), specifier.text));
        }
        if (!statement.exportClause) {
          for (const [key, value] of child ?? []) {
            if (key === "default") continue;
            if (!stars.has(key)) stars.set(key, value);
            else if (stars.get(key)?.binding !== value?.binding) stars.set(key, undefined);
          }
        } else if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            if (element.isTypeOnly) continue;
            const exportedName = element.name.text;
            const importedName = element.propertyName?.text ?? exportedName;
            const entry = child ? child.get(importedName) : direct(exportedName, importedName);
            if (!entry) {
              throw new Error(
                `[paraglide-sugar] Missing export ${JSON.stringify(importedName)} re-exported by ${file}`,
              );
            }
            entries.set(exportedName, entry);
          }
        } else if (ts.isNamespaceExport(statement.exportClause) && child) {
          // Recent Paraglide versions also expose `export * as m`. The
          // namespace is a container, never a callable message identifier.
          namespaces.set(statement.exportClause.name.text, child);
        }
      } else if (
        ts.canHaveModifiers(statement) &&
        ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name))
              entries.set(declaration.name.text, direct(declaration.name.text));
          }
        } else if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name
        ) {
          entries.set(statement.name.text, direct(statement.name.text));
        }
      }
    }
    // Explicit exports take precedence regardless of declaration order. Namespace
    // exports are explicit too, but are not callable message entries.
    for (const [key, value] of stars) {
      if (!entries.has(key) && !namespaces.has(key)) entries.set(key, value);
    }
    if (!entries.size && namespaces.size) {
      if (namespaces.size !== 1) {
        throw new Error(`[paraglide-sugar] Ambiguous namespace-only message barrel in ${file}`);
      }
      for (const [key, entry] of namespaces.values().next().value!) entries.set(key, entry);
    }
    if (
      !entries.size &&
      path.resolve(file) !== path.resolve(entryFile) &&
      path.basename(file) !== "_index.js"
    ) {
      throw new Error(`[paraglide-sugar] Generated message module has no exports yet: ${file}`);
    }
    active.delete(file);
    cache.set(file, entries);
    return entries;
  }
  const messages = new Map<string, MessageExport>();
  for (const [key, entry] of read(path.resolve(entryFile))) {
    if (entry) messages.set(key, entry.message);
  }
  // Importing a locale-module barrel cannot provide the route-level splitting
  // promised by this plugin. Fail clearly instead of silently losing that benefit.
  for (const entry of messages.values()) {
    if (
      path.resolve(entry.source) === path.resolve(entryFile) ||
      path.basename(entry.source) === "_index.js"
    ) {
      throw new Error(
        `[paraglide-sugar] ${entryFile} must use Paraglide outputStructure: 'message-modules'.`,
      );
    }
  }
  return messages;
}
