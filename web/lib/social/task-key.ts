export const TASK_KEY_REGEX = /^[A-Z][A-Z0-9]{1,9}$/;

export function validateTaskKey(value: string): boolean {
  return TASK_KEY_REGEX.test(value);
}

function lettersOf(value: string): string {
  return value.replace(/[^A-Za-z]/g, "");
}

// Letter pool used by both derivation and uniquify. Mirrors the migration
// 0040 backfill DO block exactly — keep the two in sync (parity-tested).
function letterPool(name: string, slug: string): string {
  let letters = lettersOf(name);

  if (letters.length < 2) {
    letters += lettersOf(slug);
  }
  if (letters.length < 2) {
    letters += "XX";
  }

  return letters;
}

export function deriveTaskKey(name: string, slug = ""): string {
  return letterPool(name, slug).slice(0, 3).toUpperCase();
}

export function uniquifyTaskKey(
  name: string,
  slug: string,
  isTaken: (candidate: string) => boolean,
): string {
  const letters = letterPool(name, slug);
  const base = letters.slice(0, 3).toUpperCase();
  let candidate = base;

  if (isTaken(candidate)) {
    candidate = letters.slice(0, 4).toUpperCase();
  }

  let suffix = 2;

  while (isTaken(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }

  return candidate;
}
