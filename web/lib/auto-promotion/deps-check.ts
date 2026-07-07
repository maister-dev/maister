// ADR-126 §4.3 (D-11 / R4): the deps-lane content gate. A `package.json` /
// lockfile diff is executable input, not text — so we gate the specifier SHAPE
// (registry range allow-list, reject protocol/path) AND require manifest
// evidence for any lockfile change. Pure: the caller reads base/branch contents
// at refs and passes them in. Never throws — any parse failure disqualifies.

export type DepsCheckResult = { ok: true } | { ok: false; detail: string };

export type DepsFile = {
  path: string;
  status: string;
  base: string | null;
  branch: string | null;
};

const DEP_BLOCKS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

const LOCKFILE_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
]);

// Protocol/alias prefixes that are never a bare registry version.
const NON_REGISTRY_PREFIX =
  /^(file:|link:|portal:|git\+|git:|github:|gitlab:|bitbucket:|ssh:|https?:|workspace:|npm:)/i;

// A single semver comparator: optional operator + numeric/x/* segments +
// optional prerelease/build. Deliberately strict — a token we don't recognize
// (dist-tag, url, path) fails, sending the diff to manual (fail-closed).
const COMPARATOR =
  /^(\^|~|>=|<=|>|<|=|v)?(\d+|[xX*])(\.(\d+|[xX*])){0,2}(-[0-9A-Za-z][0-9A-Za-z.-]*)?(\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

function isComparator(tok: string): boolean {
  return tok === "*" || tok === "x" || tok === "X" || COMPARATOR.test(tok);
}

// Accept bare semver + the range grammar (caret/tilde/comparators/hyphen-ranges/
// x-ranges/`*`/`||`/exact pins). Reject anything carrying a protocol or path —
// the protocol-swap defense.
export function isRegistryVersionSpecifier(spec: unknown): boolean {
  if (typeof spec !== "string") return false;

  const s = spec.trim();

  if (s.length === 0) return false;
  if (NON_REGISTRY_PREFIX.test(s)) return false;
  if (/[/\\]/.test(s)) return false; // paths (`./` `../` `/`) + `owner/repo` shorthand

  for (const alt of s.split("||")) {
    const a = alt.trim();

    if (a.length === 0) return false;

    const hyphen = a.split(/\s+-\s+/);

    if (hyphen.length === 2) {
      if (!isComparator(hyphen[0].trim()) || !isComparator(hyphen[1].trim())) {
        return false;
      }

      continue;
    }

    if (!a.split(/\s+/).every(isComparator)) return false;
  }

  return true;
}

function basename(p: string): string {
  const parts = p.split("/");

  return parts[parts.length - 1] ?? p;
}

function isManifest(p: string): boolean {
  return basename(p) === "package.json";
}

function isLockfile(p: string): boolean {
  return LOCKFILE_BASENAMES.has(basename(p));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function truncate(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function checkDepBlock(
  baseBlock: unknown,
  branchBlock: unknown,
  block: string,
  path: string,
): DepsCheckResult {
  const b = baseBlock ?? {};
  const br = branchBlock ?? {};

  if (!isPlainObject(b) || !isPlainObject(br)) {
    return { ok: false, detail: `${block} is not an object (${path})` };
  }

  const keys = new Set([...Object.keys(b), ...Object.keys(br)]);

  for (const k of keys) {
    const has0 = k in b;
    const has1 = k in br;

    if (has0 !== has1) {
      return {
        ok: false,
        detail: `dependency ${has1 ? "added" : "removed"}: ${block}.${k} (${path})`,
      };
    }

    if (b[k] === br[k]) continue;

    if (
      !isRegistryVersionSpecifier(b[k]) ||
      !isRegistryVersionSpecifier(br[k])
    ) {
      return {
        ok: false,
        detail: `non-registry specifier: ${block}.${k} ${JSON.stringify(b[k])} → ${JSON.stringify(br[k])} (${path})`,
      };
    }
  }

  return { ok: true };
}

function checkManifest(f: DepsFile): DepsCheckResult {
  // Only a pure modification with both sides present can auto-eligible; add /
  // delete / rename / copy / type-change all need human eyes.
  if (!f.status.startsWith("M")) {
    return {
      ok: false,
      detail: `manifest change type ${f.status} needs review (${f.path})`,
    };
  }

  if (f.base == null || f.branch == null) {
    return { ok: false, detail: `manifest missing a side (${f.path})` };
  }

  const base = parseJson(f.base);
  const branch = parseJson(f.branch);

  if (!base.ok || !branch.ok) {
    return { ok: false, detail: `manifest parse failure (${f.path})` };
  }

  if (!isPlainObject(base.value) || !isPlainObject(branch.value)) {
    return { ok: false, detail: `manifest is not an object (${f.path})` };
  }

  const topKeys = new Set([
    ...Object.keys(base.value),
    ...Object.keys(branch.value),
  ]);

  for (const key of topKeys) {
    if (DEP_BLOCKS.has(key)) {
      const r = checkDepBlock(base.value[key], branch.value[key], key, f.path);

      if (!r.ok) return r;

      continue;
    }

    if (JSON.stringify(base.value[key]) !== JSON.stringify(branch.value[key])) {
      return {
        ok: false,
        detail: `change outside dependency blocks: ${key} (${f.path})`,
      };
    }
  }

  return { ok: true };
}

const REGISTRY_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);
const NON_REGISTRY_LINE = /(git\+|git:\/\/|file:|link:|portal:|ssh:\/\/)/;

// Best-effort textual scan (NOT a full per-format consequence-proof — R4): any
// resolution line introduced on the branch side that points at a non-registry
// source disqualifies.
function scanLockfile(f: DepsFile): DepsCheckResult {
  if (f.branch == null) return { ok: true };

  const baseLines = new Set((f.base ?? "").split("\n").map((l) => l.trim()));
  const introduced = f.branch
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !baseLines.has(l));

  for (const line of introduced) {
    if (NON_REGISTRY_LINE.test(line)) {
      return {
        ok: false,
        detail: `lockfile introduces non-registry source: ${truncate(line)} (${f.path})`,
      };
    }

    const m = line.match(/https?:\/\/([^/\s"']+)/);

    if (m && !REGISTRY_HOSTS.has(m[1])) {
      return {
        ok: false,
        detail: `lockfile introduces off-registry host: ${m[1]} (${f.path})`,
      };
    }
  }

  return { ok: true };
}

// The deps-lane content gate over the full deps diff (all files already
// path-classified as `deps`). Caller has read base/branch contents per file.
export function checkDepsDiff(files: DepsFile[]): DepsCheckResult {
  const manifests = files.filter((f) => isManifest(f.path));
  const lockfiles = files.filter((f) => isLockfile(f.path));

  // A lockfile change with NO manifest change ships a mutated dependency graph
  // that no manifest explains — disqualify (no unattended graph shipping).
  if (lockfiles.length > 0 && manifests.length === 0) {
    return { ok: false, detail: "lockfile change without manifest evidence" };
  }

  for (const m of manifests) {
    const r = checkManifest(m);

    if (!r.ok) return r;
  }

  for (const l of lockfiles) {
    const r = scanLockfile(l);

    if (!r.ok) return r;
  }

  return { ok: true };
}
