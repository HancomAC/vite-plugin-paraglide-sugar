import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { MessageExport } from "./transform.js";

/** Read real ESM exports; Paraglide file stems are not message identifiers. */
export function readMessageManifest(entryFile: string): Map<string, MessageExport> {
  const cache = new Map<string, Map<string, MessageExport>>();
  const active = new Set<string>();
  function read(file: string): Map<string, MessageExport> {
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
    const entries = new Map<string, MessageExport>();
    const namespaces = new Map<string, Map<string, MessageExport>>();
    const direct = (name: string) => ({
      source: file.split(path.sep).join("/"),
      exportName: name,
    });
    for (const statement of ast.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        const specifier = statement.moduleSpecifier;
        let child: Map<string, MessageExport> | undefined;
        if (specifier && ts.isStringLiteral(specifier)) {
          if (!specifier.text.startsWith(".")) {
            throw new Error(
              `[paraglide-sugar] Message re-exports must be local modules: ${specifier.text}`,
            );
          }
          child = read(path.resolve(path.dirname(file), specifier.text));
        }
        if (!statement.exportClause) {
          for (const [key, value] of child ?? []) if (key !== "default") entries.set(key, value);
        } else if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            if (element.isTypeOnly) continue;
            const exportedName = element.name.text;
            const importedName = element.propertyName?.text ?? exportedName;
            const entry = child ? child.get(importedName) : direct(exportedName);
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
  const messages = read(path.resolve(entryFile));
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
