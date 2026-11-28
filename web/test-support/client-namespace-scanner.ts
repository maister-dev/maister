// Pure TypeScript AST scanner for root client i18n namespace enforcement
// (ADR-225, docs/system-analytics/client-messages.md, CMSG-02..05).
// Performs zero filesystem I/O: accepts a POSIX-relative `fileMap` and returns
// the client-reachable `useTranslations` literals plus any policy violations.
import path from "node:path";

import ts from "typescript";

export type ScanViolationKind =
  | "root_use_translations"
  | "dynamic_use_translations"
  | "use_messages"
  | "stray_provider"
  | "intl_reexport"
  | "indirect_intl_import";

export interface ScanViolation {
  kind: ScanViolationKind;
  file: string;
  line: number;
  detail: string;
  chain?: string[];
}

/** How the root layout feeds one `NextIntlClientProvider`. */
export interface RootProviderWiring {
  /** Module the `messages` picker was imported from; `null` when it is no call. */
  pickerSource: string | null;
  /** Module the picker's list argument was imported from. */
  listSource: string | null;
}

export interface ClientNamespaceScanResult {
  literals: Map<string, string[]>;
  violations: ScanViolation[];
  rootProviders: RootProviderWiring[];
}

const ROOT_LAYOUT_PATH = "app/layout.tsx";
// Recognized by name, so a re-export under another name would hide every call.
const INTL_CLIENT_NAMES = new Set([
  "useTranslations",
  "useMessages",
  "NextIntlClientProvider",
]);

type Directive = "use client" | "use server" | null;

type IntlBoundary = {
  kind: "intl_reexport" | "indirect_intl_import";
  line: number;
  detail: string;
};

interface ParsedModule {
  file: string;
  directive: Directive;
  sourceFile: ts.SourceFile;
  valueImports: string[];
  hasStrayProvider: { line: number; detail: string }[];
  intlBoundaries: IntlBoundary[];
  rootProviders: RootProviderWiring[];
}

function normalizePath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function getDirective(sourceFile: ts.SourceFile): Directive {
  for (const stmt of sourceFile.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
      if (stmt.expression.text === "use client") return "use client";
      if (stmt.expression.text === "use server") return "use server";
      continue;
    }
    break;
  }

  return null;
}

function isStaticStringLiteral(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  return null;
}

function getLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

function isTypeOnlyImportDeclaration(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;

  if (!clause) {
    // Side-effect import: `import "./setup"`
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.name) {
    return false;
  }
  if (!clause.namedBindings) {
    return false;
  }
  if (ts.isNamespaceImport(clause.namedBindings)) {
    return false;
  }

  // `import { type A, type B } from "..."` has no value bindings.
  return (
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((el) => el.isTypeOnly)
  );
}

function isTypeOnlyExportDeclaration(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) {
    return true;
  }
  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    return (
      node.exportClause.elements.length > 0 &&
      node.exportClause.elements.every((el) => el.isTypeOnly)
    );
  }

  return false;
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/u.test(file)) return ts.ScriptKind.JS;

  return ts.ScriptKind.TS;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  return ts.isAwaitExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr)
    ? expr.expression
    : expr;
}

function collectModuleMetadata(file: string, content: string): ParsedModule {
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const directive = getDirective(sourceFile);
  const valueImports: string[] = [];
  const providerAliases = new Set<string>(["NextIntlClientProvider"]);
  const nextIntlNamespaces = new Set<string>();
  const hasStrayProvider: { line: number; detail: string }[] = [];
  const intlBoundaries: IntlBoundary[] = [];
  const rootProviders: RootProviderWiring[] = [];
  // Local name -> module it was imported from.
  const importSources = new Map<string, string>();
  // Local names bound to a hook or the provider imported from `next-intl`.
  const intlLocals = new Set<string>();
  // `const name = <expression>` anywhere in the file.
  const localInitializers = new Map<string, ts.Expression>();

  for (const stmt of sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      const namedBindings = stmt.importClause?.namedBindings;

      if (!isTypeOnlyImportDeclaration(stmt)) {
        valueImports.push(spec);
      }

      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const el of namedBindings.elements) {
          const imported = el.propertyName?.text ?? el.name.text;

          importSources.set(el.name.text, spec);

          if (INTL_CLIENT_NAMES.has(imported) && spec !== "next-intl") {
            intlBoundaries.push({
              kind: "indirect_intl_import",
              line: getLine(sourceFile, stmt),
              detail: `${imported} from "${spec}"`,
            });
          }

          if (spec === "next-intl") {
            intlLocals.add(el.name.text);

            if (imported === "NextIntlClientProvider") {
              providerAliases.add(el.name.text);
            }
          }
        }
      } else if (
        spec === "next-intl" &&
        namedBindings &&
        ts.isNamespaceImport(namedBindings)
      ) {
        nextIntlNamespaces.add(namedBindings.name.text);
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      !isTypeOnlyExportDeclaration(stmt)
    ) {
      const spec =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : null;

      if (spec !== null) valueImports.push(spec);

      if (!stmt.exportClause) {
        if (spec === "next-intl") {
          intlBoundaries.push({
            kind: "intl_reexport",
            line: getLine(sourceFile, stmt),
            detail: stmt.getText(sourceFile),
          });
        }
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const reexported = el.propertyName?.text ?? el.name.text;
          const isIntlReexport =
            INTL_CLIENT_NAMES.has(reexported) ||
            (spec === null && intlLocals.has(reexported));

          if (isIntlReexport) {
            intlBoundaries.push({
              kind: "intl_reexport",
              line: getLine(sourceFile, el),
              detail: el.getText(sourceFile),
            });
          }
        }
      }
    }
  }

  function recordVariables(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      localInitializers.set(node.name.text, node.initializer);
    }

    ts.forEachChild(node, recordVariables);
  }

  // Follows `const picked = pickMessages(...)` and `messages={picked}` links
  // so the provider can be fed through a local binding.
  function followLocals(expr: ts.Expression): ts.Expression {
    let current = unwrapExpression(expr);

    for (let hops = 0; hops < 6 && ts.isIdentifier(current); hops += 1) {
      const initializer = localInitializers.get(current.text);

      if (!initializer) break;

      current = unwrapExpression(initializer);
    }

    return current;
  }

  function providerWiring(
    element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  ): RootProviderWiring {
    const messages = element.attributes.properties.find(
      (attr): attr is ts.JsxAttribute =>
        ts.isJsxAttribute(attr) &&
        (ts.isIdentifier(attr.name) || ts.isStringLiteral(attr.name)) &&
        attr.name.text === "messages",
    );
    const expression =
      messages?.initializer && ts.isJsxExpression(messages.initializer)
        ? messages.initializer.expression
        : undefined;
    const picker = expression ? followLocals(expression) : undefined;

    if (
      !picker ||
      !ts.isCallExpression(picker) ||
      !ts.isIdentifier(picker.expression) ||
      picker.arguments.length !== 2
    ) {
      return { pickerSource: null, listSource: null };
    }
    const list = followLocals(picker.arguments[1]!);

    return {
      pickerSource: importSources.get(picker.expression.text) ?? null,
      listSource: ts.isIdentifier(list)
        ? (importSources.get(list.text) ?? null)
        : null,
    };
  }

  function visit(node: ts.Node): void {
    // Dynamic `import("...")` (covers `next/dynamic(() => import("..."))`,
    // `React.lazy(() => import("..."))`, and `await import("...")`).
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1
    ) {
      const target = isStaticStringLiteral(node.arguments[0]);

      if (target !== null) {
        valueImports.push(target);
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      const isProvider =
        (ts.isIdentifier(tag) && providerAliases.has(tag.text)) ||
        (ts.isPropertyAccessExpression(tag) &&
          ts.isIdentifier(tag.expression) &&
          nextIntlNamespaces.has(tag.expression.text) &&
          tag.name.text === "NextIntlClientProvider");

      // The root layout owns the only provider; every other render is stray.
      if (isProvider) {
        if (file === ROOT_LAYOUT_PATH) {
          rootProviders.push(providerWiring(node));
        } else {
          hasStrayProvider.push({
            line: getLine(sourceFile, node),
            detail: `<${tag.getText(sourceFile)}>`,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  recordVariables(sourceFile);
  visit(sourceFile);

  return {
    file,
    directive,
    sourceFile,
    valueImports,
    hasStrayProvider,
    intlBoundaries,
    rootProviders,
  };
}

function resolveImportSpecifier(
  importer: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  let base: string;

  if (specifier.startsWith("@/")) {
    base = specifier.slice(2);
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(importer), specifier),
    );
  } else {
    return null;
  }

  const strippedJs = base.replace(/\.(mjs|cjs|jsx|js)$/u, "");
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    ...(strippedJs !== base ? [`${strippedJs}.ts`, `${strippedJs}.tsx`] : []),
  ];

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function inspectClientModule(
  mod: ParsedModule,
  chain: string[],
  literals: Map<string, string[]>,
  violations: ScanViolation[],
): void {
  const { file, sourceFile } = mod;
  const useTranslationsNames = new Set<string>(["useTranslations"]);
  const useMessagesNames = new Set<string>(["useMessages"]);
  const nextIntlNamespaces = new Set<string>();

  for (const stmt of sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === "next-intl" &&
      stmt.importClause?.namedBindings
    ) {
      if (ts.isNamedImports(stmt.importClause.namedBindings)) {
        for (const el of stmt.importClause.namedBindings.elements) {
          const imported = el.propertyName?.text ?? el.name.text;

          if (imported === "useTranslations") {
            useTranslationsNames.add(el.name.text);
          } else if (imported === "useMessages") {
            useMessagesNames.add(el.name.text);
          }
        }
      } else if (ts.isNamespaceImport(stmt.importClause.namedBindings)) {
        nextIntlNamespaces.add(stmt.importClause.namedBindings.name.text);
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const isUseTranslations =
        (ts.isIdentifier(expr) && useTranslationsNames.has(expr.text)) ||
        (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          nextIntlNamespaces.has(expr.expression.text) &&
          expr.name.text === "useTranslations");

      if (isUseTranslations) {
        if (node.arguments.length === 0) {
          violations.push({
            kind: "root_use_translations",
            file,
            line: getLine(sourceFile, node),
            detail: node.getText(sourceFile),
            chain,
          });
        } else {
          const literal = isStaticStringLiteral(node.arguments[0]);

          if (literal === null || literal.length === 0) {
            violations.push({
              kind: "dynamic_use_translations",
              file,
              line: getLine(sourceFile, node),
              detail: node.getText(sourceFile),
              chain,
            });
          } else if (!literals.has(literal)) {
            literals.set(literal, chain);
          }
        }
      }

      const isUseMessages =
        (ts.isIdentifier(expr) && useMessagesNames.has(expr.text)) ||
        (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          nextIntlNamespaces.has(expr.expression.text) &&
          expr.name.text === "useMessages");

      if (isUseMessages) {
        violations.push({
          kind: "use_messages",
          file,
          line: getLine(sourceFile, node),
          detail: node.getText(sourceFile),
          chain,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

/**
 * Returns the sorted minimal covering set of message paths: deduplicates and
 * drops any path `p` when an ancestor `q` (`p.startsWith(q + ".")`) is present.
 */
export function minimalCover(paths: readonly string[]): string[] {
  const uniqueSorted = [...new Set(paths)].sort();
  const kept: string[] = [];

  for (const candidate of uniqueSorted) {
    const covered = kept.some(
      (ancestor) =>
        candidate === ancestor || candidate.startsWith(`${ancestor}.`),
    );

    if (!covered) {
      kept.push(candidate);
    }
  }

  return kept;
}

/**
 * Scans an in-memory map of POSIX-relative JS/TS source files:
 * 1. Checks every file for stray `<NextIntlClientProvider>` outside `app/layout.tsx`
 *    and reports how the root layout feeds its own (`rootProviders`).
 * 2. Flags the intl hooks and provider re-exported or imported from any module
 *    other than `next-intl`, in every file.
 * 3. Traverses value imports, re-exports and dynamic `import()` edges from every
 *    `"use client"` root, stopping at `"use server"` modules.
 * 4. Collects literal `useTranslations("...")` namespaces and flags forbidden
 *    root/dynamic `useTranslations` and `useMessages()` calls.
 */
export function scanClientNamespaces(
  fileMap: Record<string, string>,
): ClientNamespaceScanResult {
  const modules = new Map<string, ParsedModule>();

  for (const [rawPath, content] of Object.entries(fileMap)) {
    const file = normalizePath(rawPath);

    modules.set(file, collectModuleMetadata(file, content));
  }

  const knownFiles = new Set(modules.keys());
  const violations: ScanViolation[] = [];
  const rootProviders: RootProviderWiring[] = [];

  // CMSG-05 and the direct-import rule apply to every production file.
  for (const mod of modules.values()) {
    for (const stray of mod.hasStrayProvider) {
      violations.push({
        kind: "stray_provider",
        file: mod.file,
        line: stray.line,
        detail: stray.detail,
      });
    }

    for (const boundary of mod.intlBoundaries) {
      violations.push({
        kind: boundary.kind,
        file: mod.file,
        line: boundary.line,
        detail: boundary.detail,
      });
    }

    rootProviders.push(...mod.rootProviders);
  }

  // BFS from every `"use client"` entry module, stopping at `"use server"`.
  const visitedChains = new Map<string, string[]>();
  const queue: string[] = [];

  for (const file of [...modules.keys()].sort()) {
    const mod = modules.get(file)!;

    if (mod.directive === "use client") {
      visitedChains.set(file, [file]);
      queue.push(file);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const mod = modules.get(current)!;
    const chain = visitedChains.get(current)!;

    for (const specifier of mod.valueImports) {
      const target = resolveImportSpecifier(current, specifier, knownFiles);

      if (!target || visitedChains.has(target)) continue;

      const targetMod = modules.get(target)!;

      if (targetMod.directive === "use server") continue;

      visitedChains.set(target, [...chain, target]);
      queue.push(target);
    }
  }

  const literals = new Map<string, string[]>();

  for (const [file, chain] of visitedChains) {
    inspectClientModule(modules.get(file)!, chain, literals, violations);
  }

  return { literals, violations, rootProviders };
}
