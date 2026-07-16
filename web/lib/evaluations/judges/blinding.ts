// Client-safe (pure): deterministic blind labels + randomized presentation order
// (ADR-142 D12). Both are SNAPSHOT fields — derived from the execution's
// randomization seed so the exact blinding is reproducible and auditable. A judge
// never sees real participant ids; the order is shuffled but stable for a seed.

// 32-bit FNV-1a hash of the seed string → a numeric PRNG seed.
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;

  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return h >>> 0;
}

// mulberry32: a small, fast, fully-deterministic PRNG (no Math.random) so the
// same seed always yields the same permutation.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic Fisher-Yates shuffle keyed by the seed. Pure — input array is
// not mutated.
export function seededShuffle<T>(items: T[], seed: string): T[] {
  const rng = mulberry32(hashSeed(seed));
  const out = [...items];

  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));

    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
}

function blindLabel(index: number): string {
  // Candidate A, B, ..., Z, AA, AB, ... — unbounded, no participant identity.
  let n = index;
  let label = "";

  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);

  return `Candidate ${label}`;
}

export interface BlindAssignment {
  // Presentation order (shuffled participant ids) — a snapshot field.
  order: string[];
  // participantId -> blind label (stable for a seed).
  labels: Record<string, string>;
}

// Assign deterministic blind labels + presentation order for a participant set.
// With `blind=false` the labels are still assigned (for a consistent scoreboard)
// but the caller may reveal real ids; with `randomize=false` the input order is
// preserved.
export function assignBlindLabels(
  participantIds: string[],
  seed: string,
  opts?: { randomize?: boolean },
): BlindAssignment {
  const randomize = opts?.randomize ?? true;
  const order = randomize
    ? seededShuffle(participantIds, seed)
    : [...participantIds];
  const labels: Record<string, string> = {};

  order.forEach((id, index) => {
    labels[id] = blindLabel(index);
  });

  return { order, labels };
}
