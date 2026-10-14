import { createRequire } from "node:module";
import { analyze } from "@typescript-eslint/scope-manager";
import { parse } from "@typescript-eslint/typescript-estree";
import { visitorKeys } from "@typescript-eslint/visitor-keys";
import MagicString from "magic-string";

export type MessageExport = { source: string; exportName: string };
export type MessageManifest = ReadonlyMap<string, MessageExport>;
export type TransformOptions = {
  /** Module that exports the syntax-sugar marker. */
  importSource: string;
  /** Named marker export, which can be locally aliased. Defaults to `m`. */
  exportName?: string;
  /** Unknown static keys fail the build by default. */
  missingKey?: "error" | "undefined";
};

// Both parsers expose ESTree nodes and the same ESLint scope interface. Svelte's
// nodes extend ESTree, so keep the small common interface local to this adapter.
type Node = {
  type: string;
  range: [number, number];
  [key: string]: any;
};
type Reference = { identifier: Node; isTypeReference?: boolean; isValueReference?: boolean };
type Variable = { defs: { type: string; node: Node; parent?: Node }[]; references: Reference[] };
type ParsedSource = {
  ast: Node;
  visitorKeys: Record<string, readonly string[]>;
  scopeManager: { scopes: { variables: Variable[] }[] };
};

const runtimeSource = "vite-plugin-paraglide-sugar/runtime";
const require = createRequire(import.meta.url);
// Scope analysis needs only a syntax tree and a scope manager. The full
// @typescript-eslint/parser requires an ESLint peer, and svelte-eslint-parser
// recognizes it as type-aware and adds a much slower TypeScript analysis pass.
const typescriptParser = {
  parseForESLint(code: string, options: { filePath?: string; sourceType?: "module" | "script" }) {
    const ast = parse(code, {
      filePath: options.filePath,
      jsDocParsingMode: "none",
      comment: true,
      loc: true,
      range: true,
      tokens: true,
    });
    ast.sourceType = options.sourceType ?? "module";
    return { ast, scopeManager: analyze(ast, { sourceType: ast.sourceType }), visitorKeys };
  },
};
const identifierName = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u;
const transparentExpressions = new Set([
  "TSAsExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSInstantiationExpression",
  "ChainExpression",
]);

function propertyName(node: Node): string | undefined {
  let property = node.property as Node;
  while (transparentExpressions.has(property.type) && property.expression)
    property = property.expression;
  if (!node.computed && property.type === "Identifier") return property.name;
  if (node.computed && property.type === "Literal") {
    return ["string", "number", "bigint"].includes(typeof property.value)
      ? String(property.value)
      : undefined;
  }
  if (node.computed && property.type === "TemplateLiteral" && property.expressions.length === 0) {
    return property.quasis[0].value.cooked ?? undefined;
  }
  return undefined;
}

/**
 * Resolve references to the actual imported binding, including Svelte template
 * scopes. Rewriting source ranges preserves comments, literals, and formatting.
 */
export function transformMessages(
  code: string,
  id: string,
  messages: MessageManifest,
  options: TransformOptions,
) {
  const { importSource, exportName = "m", missingKey = "error" } = options;
  if (!importSource) throw new Error("[paraglide-sugar] importSource must not be empty.");
  if (!exportName) throw new Error("[paraglide-sugar] exportName must not be empty.");
  // An escaped module specifier can omit the literal spelling of importSource.
  if (!code.includes(importSource) && !code.includes("\\")) return null;
  const parserOptions = {
    filePath: id,
    sourceType: "module" as const,
    ecmaVersion: "latest" as const,
    range: true,
    loc: true,
    project: false as const,
    projectService: false,
  };
  const parsed = (id.endsWith(".svelte")
    ? (require("svelte-eslint-parser") as typeof import("svelte-eslint-parser")).parseForESLint(
        code,
        {
          ...parserOptions,
          parser: typescriptParser,
        },
      )
    : typescriptParser.parseForESLint(code, parserOptions)) as unknown as ParsedSource;
  const parents = new WeakMap<Node, Node>();
  const identifiers = new Set<string>();
  const imports = new Set<Node>();
  const reexports: Node[] = [];
  const dynamicImports: Node[] = [];
  function walk(node: Node, parent?: Node) {
    if (parent) parents.set(node, parent);
    if (node.type === "Identifier") identifiers.add(node.name);
    if (node.type === "ImportDeclaration" && node.source.value === importSource) imports.add(node);
    if (
      node.type === "ImportExpression" &&
      (node.source.value === importSource ||
        (node.source.type === "TemplateLiteral" &&
          node.source.expressions.length === 0 &&
          node.source.quasis[0].value.cooked === importSource))
    )
      dynamicImports.push(node);
    if (
      node.source?.value === importSource &&
      node.exportKind !== "type" &&
      (node.type === "ExportAllDeclaration" ||
        (node.type === "ExportNamedDeclaration" &&
          node.specifiers.some(
            (specifier: Node) =>
              specifier.exportKind !== "type" &&
              (specifier.local.name ?? specifier.local.value) === exportName,
          )))
    )
      reexports.push(node);
    for (const key of parsed.visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) walk(item, node);
      } else if (child?.type) walk(child, node);
    }
  }
  walk(parsed.ast);
  let nextId = 0;
  function uniqueName() {
    let candidate: string;
    do candidate = `__paraglide_sugar_${nextId++}`;
    while (identifiers.has(candidate));
    identifiers.add(candidate);
    return candidate;
  }
  function unwrap(node: Node) {
    let parent = parents.get(node);
    while (parent && transparentExpressions.has(parent.type) && parent.expression === node) {
      node = parent;
      parent = parents.get(node);
    }
    return node;
  }
  function isTypeReference(node: Node) {
    for (let parent = parents.get(node); parent; parent = parents.get(parent)) {
      // `typeof m` inside a type is marked as a value reference by the scope
      // analyzer. Other type references have their own reference flag. Do not
      // classify every TS node as a type: namespaces and enums execute code.
      if (parent.type === "TSTypeQuery") return true;
    }
    return false;
  }
  function fail(node: Node, detail: string): never {
    const before = code.slice(0, node.range[0]);
    const line = before.split("\n").length;
    const column = node.range[0] - before.lastIndexOf("\n");
    throw new Error(
      `[paraglide-sugar] ${id}:${line}:${column}: ${detail}. Use a static message key or a bounded virtual:paraglide-sugar/messages/<prefix> group.`,
    );
  }
  function assertReadable(node: Node) {
    let target = unwrap(node);
    let parent = parents.get(target);
    while (
      parent &&
      ((parent.type === "Property" && parent.value === target) ||
        parent.type === "ObjectPattern" ||
        parent.type === "ArrayPattern" ||
        (parent.type === "RestElement" && parent.argument === target) ||
        (parent.type === "AssignmentPattern" && parent.left === target))
    ) {
      target = parent;
      parent = parents.get(target);
    }
    if (
      (parent?.type === "AssignmentExpression" && parent.left === target) ||
      ((parent?.type === "ForOfStatement" || parent?.type === "ForInStatement") &&
        parent.left === target) ||
      parent?.type === "UpdateExpression" ||
      (parent?.type === "UnaryExpression" && parent.operator === "delete") ||
      (parent?.type === "SvelteDirective" && parent.kind === "Binding")
    )
      fail(node, "Message properties are read-only");
  }
  if (reexports.length) fail(reexports[0], "The message namespace cannot be re-exported");
  if (dynamicImports.length)
    fail(
      dynamicImports[0],
      `Dynamic imports of ${JSON.stringify(importSource)} are unsupported; use named imports`,
    );
  const output = new MagicString(code);
  const rewritten = new Set<Node>();
  const missing: { key: string; position: number }[] = [];
  const variablesByDefinition = new WeakMap<Node, Variable>();
  for (const scope of parsed.scopeManager.scopes) {
    for (const variable of scope.variables) {
      for (const definition of variable.defs) variablesByDefinition.set(definition.node, variable);
    }
  }
  for (const declaration of imports) {
    if (declaration.importKind === "type") continue;
    const namespace = (declaration.specifiers as Node[]).find(
      (specifier) =>
        specifier.type === "ImportNamespaceSpecifier" ||
        specifier.type === "ImportDefaultSpecifier",
    );
    if (namespace)
      fail(
        namespace,
        `${JSON.stringify(importSource)} requires named imports; namespace and default imports are unsupported`,
      );
    const removed = new Set<Node>();
    const typeOnly = new Set<Node>();
    const injected: string[] = [];
    const importedMessages = new Map<string, string>();
    const helpers = new Map<string, string>();
    function helper(name: string) {
      let local = helpers.get(name);
      if (!local) {
        local = uniqueName();
        helpers.set(name, local);
        injected.push(`import { ${name} as ${local} } from ${JSON.stringify(runtimeSource)};`);
      }
      return local;
    }
    function message(key: string, entry: MessageExport) {
      let expression = importedMessages.get(key);
      if (!expression) {
        const local = uniqueName();
        if (identifierName.test(entry.exportName)) {
          injected.push(
            `import { ${entry.exportName} as ${local} } from ${JSON.stringify(entry.source)};`,
          );
          expression = local;
        } else {
          // Svelte currently loses aliases on string-named imports. A static
          // property of this one message module keeps quoted/dotted IDs usable
          // without retaining the complete catalog namespace.
          injected.push(`import * as ${local} from ${JSON.stringify(entry.source)};`);
          expression = `${local}[${JSON.stringify(entry.exportName)}]`;
        }
        importedMessages.set(key, expression);
      }
      return expression;
    }
    for (const specifier of declaration.specifiers as Node[]) {
      if (
        specifier.type !== "ImportSpecifier" ||
        (specifier.imported.name ?? specifier.imported.value) !== exportName ||
        specifier.importKind === "type"
      )
        continue;
      const variable = variablesByDefinition.get(specifier);
      if (!variable) fail(specifier, "Cannot resolve the imported message binding");
      let needsTypeImport = false;
      function transformBinding(binding: Variable, alias?: Node): boolean {
        let preserveAliasType = false;
        for (const reference of binding.references) {
          // Scope analyzers include the declaration's initial write among a
          // const binding's references. Later writes are still rejected below.
          if (alias && reference.identifier === alias) continue;
          if (
            (reference.isTypeReference && !reference.isValueReference) ||
            isTypeReference(reference.identifier)
          ) {
            if (alias) preserveAliasType = true;
            else needsTypeImport = true;
            continue;
          }
          const receiver = unwrap(reference.identifier);
          const member = parents.get(receiver);
          if (
            member?.type === "VariableDeclarator" &&
            member.init === receiver &&
            member.id.type === "Identifier"
          ) {
            const declaration = parents.get(member);
            if (
              declaration?.type !== "SvelteConstTag" &&
              (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const")
            ) {
              fail(member, "Message aliases must be immutable const bindings");
            }
            if (parents.get(declaration)?.type === "ExportNamedDeclaration") {
              fail(member, "The message namespace cannot be re-exported through an alias");
            }
            const aliasBinding = variablesByDefinition.get(member);
            if (!aliasBinding) fail(member, "Cannot resolve the message alias binding");
            let marker = alias ? `(void ${reference.identifier.name}, void 0)` : "(void 0)";
            if (transformBinding(aliasBinding, member.id)) {
              // Preserve `typeof alias` through its asserted/inferred type,
              // while retaining only a type import for the original marker.
              marker = `(${marker} as unknown as typeof ${reference.identifier.name})`;
              preserveAliasType = true;
            }
            output.overwrite(reference.identifier.range[0], reference.identifier.range[1], marker);
            continue;
          }
          if (member?.type !== "MemberExpression" || member.object !== receiver) {
            fail(reference.identifier, "The imported message namespace cannot be used dynamically");
          }
          const key = propertyName(member);
          if (key === undefined) fail(member, "Dynamic message keys cannot be resolved statically");
          const outside = parents.get(unwrap(member));
          assertReadable(member);
          const entry = messages.get(key);
          if (!entry) {
            if (missingKey === "error") fail(member, `Unknown message key ${JSON.stringify(key)}`);
            missing.push({ key, position: member.range[0] });
          }
          let target = member;
          let replacement = "(void 0)";
          if (entry) {
            const raw =
              outside?.type === "MemberExpression" &&
              outside.object === unwrap(member) &&
              propertyName(outside) === "_";
            if (raw) target = outside;
            assertReadable(target);
            const expression = message(key, entry);
            replacement = raw ? expression : `${helper("resolveMessage")}(${expression})`;
          }
          // Keep the lexical read so an alias used before initialization still
          // throws; only the catalog property lookup is compiled away.
          if (alias) replacement = `(void ${reference.identifier.name}, ${replacement})`;
          if (!rewritten.has(target)) {
            if (replacement.startsWith("(")) {
              // A leading parenthesis can join a previously separate statement
              // (for example, `effect()\nalias.key._()`). Protect only expression
              // statements in statement lists, never a bare if/loop/label body.
              let statement = target;
              let parent = parents.get(statement);
              while (
                statement.type !== "ExpressionStatement" &&
                parent?.range[0] === target.range[0]
              ) {
                statement = parent;
                parent = parents.get(statement);
              }
              if (
                statement.type === "ExpressionStatement" &&
                parent &&
                (parsed.visitorKeys[parent.type] ?? []).some(
                  (key) => Array.isArray(parent[key]) && parent[key].includes(statement),
                )
              ) {
                replacement = `;${replacement}`;
              }
            }
            output.overwrite(target.range[0], target.range[1], replacement);
            rewritten.add(target);
          }
        }
        return preserveAliasType;
      }
      const aliasNeedsTypes = transformBinding(variable);
      if (needsTypeImport || aliasNeedsTypes) typeOnly.add(specifier);
      else removed.add(specifier);
    }
    if (!removed.size && !injected.length && !typeOnly.size) continue;
    const kept = (declaration.specifiers as Node[]).filter((specifier) => !removed.has(specifier));
    let retained = "";
    if (kept.length) {
      const named = kept.map(
        (specifier) => `${typeOnly.has(specifier) ? "type " : ""}${code.slice(...specifier.range)}`,
      );
      retained = `import { ${named.join(", ")} } from ${JSON.stringify(declaration.source.value)};`;
    }
    output.overwrite(
      declaration.range[0],
      declaration.range[1],
      [retained, ...injected].filter(Boolean).join("\n") || ";",
    );
  }
  if (!output.hasChanged()) return null;
  return {
    code: output.toString(),
    map: output.generateMap({ source: id, includeContent: true, hires: true }),
    missing,
  };
}
