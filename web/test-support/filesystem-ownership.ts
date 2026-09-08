// D10 (AB-16): the operation-scoped filesystem inventory scanner.
//
// The Stage B guard classified whole FILES: a file with any `node:fs` import
// was allow-listed once, so a new host-runtime read added to an already
// classified file was invisible. This scanner enumerates every CALLSITE of a
// filesystem, child-process or SQLite operation across the production roots
// (`.ts/.tsx/.mts/.cts/.js/.mjs/.cjs`), keyed by source + enclosing function +
// resolved callee + operation, and every use of a tracked binding it cannot
// resolve to a call is reported as `unresolved` so it needs an explicit entry.
// Test and migration-only sources are ROLE-tagged, never silently dropped.
//
// It is a static supplement: the real isolation proof is the denied-root
// harness (`execution-ab-isolation.integration.test.ts`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

export type FilesystemOperation =
  | "read"
  | "write"
  | "remove"
  | "stat"
  | "list"
  | "open"
  | "watch"
  | "spawn"
  | "sqlite"
  // A call to an exported production function whose body (within its own
  // module) performs one of the operations above — depth-1 wrapper use.
  | "wrapper"
  | "unresolved";

export type SourceRole = "production" | "test";

export type FilesystemCallsite = Readonly<{
  source: string;
  enclosing: string;
  callee: string;
  operation: FilesystemOperation;
  command: string | null;
  line: number;
}>;

export type FilesystemCallsiteKey = Readonly<{
  source: string;
  enclosing: string;
  callee: string;
  operation: FilesystemOperation;
  command?: string | null;
}>;

export type FilesystemScan = Readonly<{
  roles: ReadonlyMap<string, SourceRole>;
  callsites: readonly FilesystemCallsite[];
  // module → exported functions that perform filesystem effects (wrappers).
  wrappers: ReadonlyMap<string, ReadonlySet<string>>;
}>;

export type ScanOptions = Readonly<{
  webDir: string;
  // Virtual sources: a path → text override (an existing file's replacement
  // or a file that does not exist on disk). Used by the mutation cases.
  overrides?: ReadonlyMap<string, string>;
  // `module#function` wrappers whose CALLER chooses the filesystem location;
  // only their uses are enumerated per caller. Every detected wrapper is
  // still reported in `wrappers`, so the inventory decides this per wrapper.
  pathGenericWrappers?: ReadonlySet<string>;
}>;

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
]);
// Production roots inside `web/` plus the shared `runtime/` helpers both
// services import. Test-only trees are listed so their sources get a role.
const WEB_ROOT_DIRECTORIES = [
  "app",
  "lib",
  "components",
  "scripts",
  "i18n",
  "config",
  "types",
  "e2e",
  "test-support",
  "test-fixtures",
] as const;
const WEB_ROOT_FILES = [
  "instrumentation.ts",
  "server.ts",
  "proxy.ts",
  "auth.ts",
  "auth.config.ts",
  "next.config.mjs",
  "postcss.config.mjs",
  "eslint.config.mjs",
  "drizzle.config.ts",
  "vitest.config.ts",
  "vitest.workspace.ts",
  "playwright.config.ts",
  "playwright.live.config.ts",
  "playwright.execution-ab.config.ts",
] as const;
const SHARED_RUNTIME_DIRECTORY = "../runtime";
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", ".auth"]);

const TRACKED_MODULES: ReadonlyMap<string, string> = new Map([
  ["node:fs", "node:fs"],
  ["fs", "node:fs"],
  ["node:fs/promises", "node:fs/promises"],
  ["fs/promises", "node:fs/promises"],
  ["node:child_process", "node:child_process"],
  ["child_process", "node:child_process"],
  ["node:sqlite", "node:sqlite"],
  ["sqlite", "node:sqlite"],
]);

const OPERATIONS: ReadonlyMap<string, FilesystemOperation> = new Map<
  string,
  FilesystemOperation
>([
  ...[
    "readFile",
    "readFileSync",
    "createReadStream",
    "readSync",
    "read",
    "readlink",
    "readlinkSync",
  ].map((name): [string, FilesystemOperation] => [name, "read"]),
  ...["readdir", "readdirSync", "opendir", "opendirSync"].map(
    (name): [string, FilesystemOperation] => [name, "list"],
  ),
  ...[
    "stat",
    "statSync",
    "lstat",
    "lstatSync",
    "fstat",
    "access",
    "accessSync",
    "existsSync",
    "realpath",
    "realpathSync",
  ].map((name): [string, FilesystemOperation] => [name, "stat"]),
  ...["open", "openSync"].map((name): [string, FilesystemOperation] => [
    name,
    "open",
  ]),
  ...[
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "mkdir",
    "mkdirSync",
    "mkdtemp",
    "mkdtempSync",
    "rename",
    "renameSync",
    "copyFile",
    "copyFileSync",
    "cp",
    "cpSync",
    "createWriteStream",
    "chmod",
    "chmodSync",
    "chown",
    "chownSync",
    "utimes",
    "utimesSync",
    "symlink",
    "symlinkSync",
    "link",
    "linkSync",
    "truncate",
    "truncateSync",
    "write",
    "writeSync",
    "fsync",
    "fsyncSync",
  ].map((name): [string, FilesystemOperation] => [name, "write"]),
  ...["rm", "rmSync", "rmdir", "rmdirSync", "unlink", "unlinkSync"].map(
    (name): [string, FilesystemOperation] => [name, "remove"],
  ),
  ...["watch", "watchFile", "unwatchFile"].map(
    (name): [string, FilesystemOperation] => [name, "watch"],
  ),
  ...[
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ].map((name): [string, FilesystemOperation] => [name, "spawn"]),
  ["DatabaseSync", "sqlite"],
]);
// Namespace members that are not operations (constants, types, streams).
const IGNORED_MEMBERS = new Set(["constants", "promises", "default"]);

type Binding = Readonly<{ module: string; member: string | null }>;

function isTestSource(source: string): boolean {
  const normalized = source.split(path.sep).join("/");

  return (
    normalized.startsWith("e2e/") ||
    normalized.startsWith("test-support/") ||
    normalized.startsWith("test-fixtures/") ||
    normalized.includes("/__tests__/") ||
    /\.(test|spec|integration\.test)\.[cm]?[jt]sx?$/.test(normalized) ||
    /^(vitest|playwright)[.\w-]*\.(ts|mjs)$/.test(normalized)
  );
}

function listSources(webDir: string): string[] {
  const files: string[] = [];
  const pending: string[] = [];

  for (const directory of WEB_ROOT_DIRECTORIES) {
    const absolute = path.join(webDir, directory);

    if (exists(absolute)) pending.push(absolute);
  }
  const shared = path.resolve(webDir, SHARED_RUNTIME_DIRECTORY);

  if (exists(shared)) pending.push(shared);
  for (const file of WEB_ROOT_FILES) {
    const absolute = path.join(webDir, file);

    if (exists(absolute)) files.push(absolute);
  }
  while (pending.length > 0) {
    const directory = pending.pop() as string;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(absolute);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name))
      ) {
        files.push(absolute);
      }
    }
  }

  return files.map((file) => relativeSource(webDir, file)).sort();
}

function exists(absolute: string): boolean {
  try {
    statSync(absolute);

    return true;
  } catch {
    return false;
  }
}

function relativeSource(webDir: string, absolute: string): string {
  return path.relative(webDir, absolute).split(path.sep).join("/");
}

function scriptKindFor(source: string): ts.ScriptKind {
  const extension = path.extname(source);

  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs")
    return ts.ScriptKind.JS;

  return ts.ScriptKind.TS;
}

function trackedModule(specifier: ts.Expression | undefined): string | null {
  if (!specifier || !ts.isStringLiteralLike(specifier)) return null;

  return TRACKED_MODULES.get(specifier.text) ?? null;
}

function moduleOfRequireLike(
  node: ts.Expression,
  requireLike: ReadonlySet<string>,
): string | null {
  // `require("node:fs")`, `nodeRequire("node:sqlite")`, `await import("fs")`.
  const expression = ts.isAwaitExpression(node) ? node.expression : node;

  if (!ts.isCallExpression(expression)) return null;
  const callee = expression.expression;
  const isRequire =
    (ts.isIdentifier(callee) &&
      (callee.text === "require" || requireLike.has(callee.text))) ||
    callee.kind === ts.SyntaxKind.ImportKeyword;

  if (!isRequire) return null;

  return trackedModule(expression.arguments[0]);
}

function enclosingName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text;
    }
    if (
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      const member = ts.isConstructorDeclaration(current)
        ? "constructor"
        : ts.isIdentifier(current.name) || ts.isStringLiteral(current.name)
          ? current.name.text
          : "<computed>";

      return `${ownerName(current.parent)}.${member}`;
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;

      if (ts.isFunctionExpression(current) && current.name) {
        return current.name.text;
      }
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      if (
        ts.isPropertyAssignment(parent) &&
        (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
      ) {
        return `${ownerName(parent.parent)}.${parent.name.text}`;
      }
      // An anonymous callback belongs to the named function around it.
    }
    current = current.parent;
  }

  return "<module>";
}

function ownerName(node: ts.Node): string {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return node.name?.text ?? "<class>";
  }
  if (ts.isObjectLiteralExpression(node)) {
    const parent = node.parent;

    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) {
      return enclosingName(node);
    }

    return "<object>";
  }

  return "<object>";
}

function isTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isTypeNode(current) || ts.isTypeQueryNode(current)) return true;
    if (ts.isImportTypeNode(current)) return true;
    if (
      ts.isImportSpecifier(current) ||
      ts.isImportClause(current) ||
      ts.isNamespaceImport(current) ||
      ts.isExportSpecifier(current)
    )
      return false;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
    current = current.parent;
  }

  return false;
}

function memberChain(
  node: ts.PropertyAccessExpression,
): { root: ts.Identifier; members: string[] } | null {
  const members: string[] = [];
  let current: ts.Expression = node;

  while (ts.isPropertyAccessExpression(current)) {
    members.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return null;

  return { root: current, members };
}

function resolveMember(
  binding: Binding,
  members: readonly string[],
): {
  callee: string;
  operation: FilesystemOperation | null;
} {
  let moduleName = binding.module;
  const chain = binding.member ? [binding.member, ...members] : [...members];
  // `fs.promises.readFile` is the promises API of `node:fs`.
  const effective = chain.filter((member, index) => {
    if (member === "promises" && moduleName === "node:fs" && index === 0) {
      moduleName = "node:fs/promises";

      return false;
    }

    return true;
  });
  const member = effective[0] ?? null;
  const callee = member ? `${moduleName}.${member}` : moduleName;

  return {
    callee,
    operation: member ? (OPERATIONS.get(member) ?? null) : null,
  };
}

function literalCommand(argument: ts.Expression | undefined): string | null {
  if (!argument) return null;
  if (ts.isStringLiteralLike(argument)) return argument.text;
  // `process.execPath` is Node itself — a fixed, non-literal command.
  if (
    ts.isPropertyAccessExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === "process" &&
    argument.name.text === "execPath"
  )
    return "process.execPath";

  return null;
}

type ModuleFunctions = Readonly<{
  // top-level function name → local functions it calls
  calls: ReadonlyMap<string, ReadonlySet<string>>;
  exported: ReadonlySet<string>;
  // `export { a as b } from "./m"` / `export * from "./m"` (unresolved specifiers)
  reexports: readonly {
    from: string;
    names: ReadonlyMap<string, string> | "*";
  }[];
}>;

function parseSource(source: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    source,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(source),
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

// Top-level functions of a module, which of them are exported, and the local
// calls each makes — enough to close "performs a filesystem effect" over the
// module and name its exported wrappers.
function moduleFunctions(sourceFile: ts.SourceFile): ModuleFunctions {
  const calls = new Map<string, Set<string>>();
  const exported = new Set<string>();
  const reexports: { from: string; names: Map<string, string> | "*" }[] = [];
  const bodies: { name: string; body: ts.Node }[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      bodies.push({ name: statement.name.text, body: statement });
      if (hasExportModifier(statement)) exported.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        ) {
          bodies.push({ name: declaration.name.text, body: declaration });
          if (hasExportModifier(statement)) exported.add(declaration.name.text);
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      const from = statement.moduleSpecifier;

      if (from && ts.isStringLiteralLike(from)) {
        if (
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause)
        ) {
          const names = new Map<string, string>();

          for (const element of statement.exportClause.elements) {
            if (element.isTypeOnly) continue;
            names.set(
              element.name.text,
              (element.propertyName ?? element.name).text,
            );
          }
          reexports.push({ from: from.text, names });
        } else if (!statement.exportClause) {
          reexports.push({ from: from.text, names: "*" });
        }
      } else if (
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          exported.add((element.propertyName ?? element.name).text);
        }
      }
    }
  }
  for (const { name, body } of bodies) {
    const called = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text !== name
      )
        called.add(node.expression.text);
      ts.forEachChild(node, visit);
    };

    visit(body);
    calls.set(name, called);
  }

  return { calls, exported, reexports };
}

function scanSource(
  source: string,
  sourceFile: ts.SourceFile,
): FilesystemCallsite[] {
  const bindings = new Map<string, Binding>();
  const requireLike = new Set<string>();
  const callsites: FilesystemCallsite[] = [];
  const line = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;

  const bindPattern = (name: ts.BindingName, base: Binding): void => {
    if (ts.isIdentifier(name)) {
      bindings.set(name.text, base);

      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        const exported = element.propertyName ?? element.name;
        const member = ts.isIdentifier(exported) ? exported.text : null;

        if (ts.isIdentifier(element.name) && member) {
          bindings.set(element.name.text, {
            module: base.module,
            member: base.member ? `${base.member}.${member}` : member,
          });
        }
      }
    }
  };

  // Pass 1: imports, require-likes and local aliases become bindings.
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = trackedModule(node.moduleSpecifier);
      const clause = node.importClause;

      if (moduleName && clause && !clause.isTypeOnly) {
        if (clause.name)
          bindings.set(clause.name.text, { module: moduleName, member: null });
        const named = clause.namedBindings;

        if (named && ts.isNamespaceImport(named)) {
          bindings.set(named.name.text, { module: moduleName, member: null });
        } else if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            if (element.isTypeOnly) continue;
            bindings.set(element.name.text, {
              module: moduleName,
              member: (element.propertyName ?? element.name).text,
            });
          }
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = node.initializer;

      if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "createRequire" &&
        ts.isIdentifier(node.name)
      ) {
        requireLike.add(node.name.text);
      }
      const requiredModule = moduleOfRequireLike(initializer, requireLike);

      if (requiredModule) {
        bindPattern(node.name, { module: requiredModule, member: null });
      } else if (
        ts.isIdentifier(initializer) &&
        bindings.has(initializer.text)
      ) {
        // `const rf = readFile` / `const { readFile } = fs`
        bindPattern(node.name, bindings.get(initializer.text) as Binding);
      } else if (ts.isPropertyAccessExpression(initializer)) {
        const chain = memberChain(initializer);
        const base = chain ? bindings.get(chain.root.text) : undefined;

        if (chain && base) {
          bindPattern(node.name, {
            module: base.module,
            member: [base.member, ...chain.members]
              .filter((member): member is string => member !== null)
              .join("."),
          });
        }
      } else if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "promisify" &&
        initializer.arguments[0]
      ) {
        // `const execFileAsync = promisify(execFile)` keeps the callee.
        const argument = initializer.arguments[0];
        const alias = ts.isIdentifier(argument)
          ? bindings.get(argument.text)
          : ts.isPropertyAccessExpression(argument)
            ? (() => {
                const chain = memberChain(argument);
                const base = chain ? bindings.get(chain.root.text) : undefined;

                return chain && base
                  ? {
                      module: base.module,
                      member: [base.member, ...chain.members]
                        .filter((member): member is string => member !== null)
                        .join("."),
                    }
                  : undefined;
              })()
            : undefined;

        if (alias) bindPattern(node.name, alias);
      }
    }
    ts.forEachChild(node, collect);
  };

  collect(sourceFile);
  if (bindings.size === 0) return callsites;

  const aliasDeclarations = new Set<ts.Node>();
  const record = (
    node: ts.Node,
    callee: string,
    operation: FilesystemOperation,
    command: string | null,
  ): void => {
    callsites.push({
      source,
      enclosing: enclosingName(node),
      callee,
      operation,
      command,
      line: line(node),
    });
  };
  const isAliasInitializer = (node: ts.Node): boolean => {
    // A binding used to DEFINE another binding (pass 1) is not an operation.
    let current: ts.Node | undefined = node;

    while (current && !ts.isStatement(current)) {
      if (ts.isVariableDeclaration(current) && current.initializer) {
        const initializer = current.initializer;
        const viaPromisify =
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === "promisify";

        return (
          ts.isIdentifier(initializer) ||
          ts.isPropertyAccessExpression(initializer) ||
          viaPromisify
        );
      }
      current = current.parent;
    }

    return false;
  };

  // Pass 2: every reference to a binding is a call, an alias, or unresolved.
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && bindings.has(node.text)) {
      const binding = bindings.get(node.text) as Binding;
      const parent = node.parent;
      const declaresBinding =
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        ts.isBindingElement(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ts.isParameter(parent);

      if (
        !declaresBinding &&
        !isTypePosition(node) &&
        !aliasDeclarations.has(node)
      ) {
        if (ts.isCallExpression(parent) && parent.expression === node) {
          const { callee, operation } = resolveMember(binding, []);

          record(
            node,
            callee,
            operation ?? "unresolved",
            operation === "spawn" ? literalCommand(parent.arguments[0]) : null,
          );
        } else if (ts.isNewExpression(parent) && parent.expression === node) {
          const { callee, operation } = resolveMember(binding, []);

          record(node, callee, operation ?? "unresolved", null);
        } else if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node
        ) {
          // Walk the chain: fs.promises.readFile(...) / fs.constants.R_OK.
          let top: ts.Expression = parent;

          while (
            ts.isPropertyAccessExpression(top.parent) &&
            top.parent.expression === top
          )
            top = top.parent;
          const chain = memberChain(top as ts.PropertyAccessExpression);
          const members = chain ? chain.members : [];
          const leaf = members[members.length - 1];

          if (
            (leaf && IGNORED_MEMBERS.has(leaf) && members.length === 1) ||
            (members[0] === "constants" && binding.member === null)
          ) {
            // fs.constants / fs.promises used as a value, not an operation.
          } else if (
            ts.isCallExpression(top.parent) &&
            top.parent.expression === top
          ) {
            const { callee, operation } = resolveMember(binding, members);

            record(
              node,
              callee,
              operation ?? "unresolved",
              operation === "spawn"
                ? literalCommand(top.parent.arguments[0])
                : null,
            );
          } else if (
            ts.isNewExpression(top.parent) &&
            top.parent.expression === top
          ) {
            const { callee, operation } = resolveMember(binding, members);

            record(node, callee, operation ?? "unresolved", null);
          } else if (!isAliasInitializer(top)) {
            const { callee } = resolveMember(binding, members);

            record(node, callee, "unresolved", null);
          }
        } else if (!isAliasInitializer(node)) {
          const { callee } = resolveMember(binding, []);

          record(node, callee, "unresolved", null);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return callsites;
}

const IMPORT_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
];
const INDEX_FILES = ["/index.ts", "/index.tsx", "/index.js", "/index.mjs"];
const REEXPORT_DEPTH = 4;

// `@/lib/x` → `lib/x.ts`; `./x` relative to the importer; the shared
// `../../../runtime/x` helpers → `../runtime/x.ts`. Only sources the scan
// knows can be targets — package imports resolve to nothing.
function resolveImport(
  from: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | null {
  let base: string;

  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith(".")) {
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(from), specifier),
    );
  } else return null;
  for (const extension of IMPORT_EXTENSIONS) {
    if (known.has(base + extension)) return base + extension;
  }
  for (const index of INDEX_FILES) {
    if (known.has(base + index)) return base + index;
  }

  return null;
}

type WrapperIndex = Readonly<{
  wrappers: ReadonlyMap<string, ReadonlySet<string>>;
  functions: ReadonlyMap<string, ModuleFunctions>;
  known: ReadonlySet<string>;
  pathGeneric: ReadonlySet<string> | undefined;
}>;

// Follow `export { a as b } from` / `export * from` chains to the module that
// defines `name`, and report whether that definition is a wrapper.
function resolveWrapper(
  index: WrapperIndex,
  moduleSource: string,
  name: string,
  depth = 0,
): string | null {
  if (index.wrappers.get(moduleSource)?.has(name))
    return `${moduleSource}#${name}`;
  if (depth >= REEXPORT_DEPTH) return null;
  const functions = index.functions.get(moduleSource);

  if (!functions) return null;
  for (const reexport of functions.reexports) {
    const target = resolveImport(moduleSource, reexport.from, index.known);

    if (!target) continue;
    if (reexport.names === "*") {
      const found = resolveWrapper(index, target, name, depth + 1);

      if (found) return found;
    } else if (reexport.names.has(name)) {
      const found = resolveWrapper(
        index,
        target,
        reexport.names.get(name) as string,
        depth + 1,
      );

      if (found) return found;
    }
  }

  return null;
}

// Depth-1 wrapper use: every call of an imported exported wrapper is a
// filesystem effect of the CALLER, keyed by the wrapper it reached.
function scanWrapperUse(
  source: string,
  sourceFile: ts.SourceFile,
  index: WrapperIndex,
): FilesystemCallsite[] {
  const bindings = new Map<string, string>(); // local name → module#wrapper
  const namespaces = new Map<string, string>(); // local namespace → module
  const callsites: FilesystemCallsite[] = [];
  const line = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;
  const enumerated = (wrapper: string | null): string | null =>
    wrapper &&
    (index.pathGeneric === undefined || index.pathGeneric.has(wrapper))
      ? wrapper
      : null;
  const bindNamed = (
    moduleSource: string,
    local: string,
    imported: string,
  ): void => {
    const wrapper = enumerated(resolveWrapper(index, moduleSource, imported));

    if (wrapper) bindings.set(local, wrapper);
  };

  const collect = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      const target = ts.isStringLiteralLike(node.moduleSpecifier)
        ? resolveImport(source, node.moduleSpecifier.text, index.known)
        : null;
      const named = node.importClause.namedBindings;

      if (target && named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.isTypeOnly) continue;
          bindNamed(
            target,
            element.name.text,
            (element.propertyName ?? element.name).text,
          );
        }
      } else if (target && named && ts.isNamespaceImport(named)) {
        namespaces.set(named.name.text, target);
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      // `const { x } = await import("@/lib/m")` (instrumentation-style).
      const initializer = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;

      if (
        ts.isCallExpression(initializer) &&
        initializer.expression.kind === ts.SyntaxKind.ImportKeyword &&
        initializer.arguments[0] &&
        ts.isStringLiteralLike(initializer.arguments[0])
      ) {
        const target = resolveImport(
          source,
          initializer.arguments[0].text,
          index.known,
        );

        if (target && ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const imported = element.propertyName ?? element.name;

            if (ts.isIdentifier(element.name) && ts.isIdentifier(imported))
              bindNamed(target, element.name.text, imported.text);
          }
        } else if (target && ts.isIdentifier(node.name)) {
          namespaces.set(node.name.text, target);
        }
      }
    }
    ts.forEachChild(node, collect);
  };

  collect(sourceFile);
  if (bindings.size === 0 && namespaces.size === 0) return callsites;

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isTypePosition(node)) {
      const parent = node.parent;
      const declares =
        ts.isImportSpecifier(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isBindingElement(parent) ||
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ts.isParameter(parent);

      if (!declares && bindings.has(node.text)) {
        const wrapper = bindings.get(node.text) as string;

        if (ts.isCallExpression(parent) && parent.expression === node) {
          callsites.push({
            source,
            enclosing: enclosingName(node),
            callee: wrapper,
            operation: "wrapper",
            command: null,
            line: line(node),
          });
        } else {
          callsites.push({
            source,
            enclosing: enclosingName(node),
            callee: wrapper,
            operation: "unresolved",
            command: null,
            line: line(node),
          });
        }
      } else if (
        !declares &&
        namespaces.has(node.text) &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node
      ) {
        const wrapper = enumerated(
          resolveWrapper(
            index,
            namespaces.get(node.text) as string,
            parent.name.text,
          ),
        );

        if (wrapper) {
          const isCall =
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent;

          callsites.push({
            source,
            enclosing: enclosingName(node),
            callee: wrapper,
            operation: isCall ? "wrapper" : "unresolved",
            command: null,
            line: line(node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return callsites;
}

type ParsedModule = Readonly<{
  sourceFile: ts.SourceFile;
  direct: FilesystemCallsite[];
  functions: ModuleFunctions;
}>;

// On-disk sources are parsed once per (size, mtime); a mutation scan that
// overrides one file re-parses only that file.
const parseCache = new Map<
  string,
  { size: number; mtimeMs: number } & ParsedModule
>();

function parseModule(
  source: string,
  absolute: string | null,
  text: string | null,
): ParsedModule {
  if (absolute && text === null) {
    const stat = statSync(absolute);
    const cached = parseCache.get(absolute);

    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs
    ) {
      return cached;
    }
    const sourceFile = parseSource(source, readFileSync(absolute, "utf8"));
    const parsed = {
      sourceFile,
      direct: scanSource(source, sourceFile),
      functions: moduleFunctions(sourceFile),
    };

    parseCache.set(absolute, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...parsed,
    });

    return parsed;
  }
  const sourceFile = parseSource(source, text ?? "");

  return {
    sourceFile,
    direct: scanSource(source, sourceFile),
    functions: moduleFunctions(sourceFile),
  };
}

export function scanFilesystemOwnership(options: ScanOptions): FilesystemScan {
  const overrides = options.overrides ?? new Map<string, string>();
  const sources = new Set(listSources(options.webDir));

  for (const source of overrides.keys()) sources.add(source);
  const roles = new Map<string, SourceRole>();
  const parsed = new Map<string, ts.SourceFile>();
  const direct = new Map<string, FilesystemCallsite[]>();
  const functions = new Map<string, ModuleFunctions>();

  for (const source of [...sources].sort()) {
    const role: SourceRole = isTestSource(source) ? "test" : "production";

    roles.set(source, role);
    if (role === "test") continue;
    const override = overrides.get(source);
    const parsedModule = parseModule(
      source,
      override === undefined ? path.resolve(options.webDir, source) : null,
      override ?? null,
    );

    parsed.set(source, parsedModule.sourceFile);
    direct.set(source, parsedModule.direct);
    functions.set(source, parsedModule.functions);
  }

  // Close "performs a filesystem effect" over each module's local calls; the
  // exported members of that closure are the module's wrappers.
  const wrappers = new Map<string, Set<string>>();

  for (const [source, moduleFn] of functions) {
    const effecting = new Set(
      (direct.get(source) ?? []).map((site) => site.enclosing),
    );
    let grew = true;

    while (grew) {
      grew = false;
      for (const [name, called] of moduleFn.calls) {
        if (effecting.has(name)) continue;
        for (const callee of called) {
          if (effecting.has(callee)) {
            effecting.add(name);
            grew = true;
            break;
          }
        }
      }
    }
    const exportedWrappers = new Set(
      [...effecting].filter((name) => moduleFn.exported.has(name)),
    );

    if (exportedWrappers.size > 0) wrappers.set(source, exportedWrappers);
  }

  const known = new Set(parsed.keys());
  const index: WrapperIndex = {
    wrappers,
    functions,
    known,
    pathGeneric: options.pathGenericWrappers,
  };
  const callsites: FilesystemCallsite[] = [];

  for (const [source, sourceFile] of parsed) {
    callsites.push(...(direct.get(source) ?? []));
    callsites.push(...scanWrapperUse(source, sourceFile, index));
  }

  return { roles, callsites, wrappers };
}

export function callsiteKey(site: FilesystemCallsiteKey): string {
  return [
    site.source,
    site.enclosing,
    site.callee,
    site.operation,
    site.command ?? "",
  ].join(" ");
}
