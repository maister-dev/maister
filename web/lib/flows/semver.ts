// The single semver comparison used for engine-compat decisions. Lives in its
// own client-safe module (no `server-only`) because the Studio authoring
// validators run in the browser and must apply the same engine floors as the
// server. `engine-version.ts` re-exports `semverGte` — callers must not
// hand-roll their own comparison.

type SemverTuple = [number, number, number];

function parseSemver(value: string): SemverTuple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());

  if (!m) return null;

  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: SemverTuple, b: SemverTuple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }

  return 0;
}

// Returns true when `value` is a valid X.Y.Z semver >= reference `ref`.
// Returns false for any unparseable input.
export function semverGte(value: string, ref: string): boolean {
  const v = parseSemver(value);
  const r = parseSemver(ref);

  if (!v || !r) return false;

  return compareSemver(v, r) >= 0;
}

export { parseSemver };
export type { SemverTuple };
