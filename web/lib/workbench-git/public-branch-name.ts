import { MaisterError } from "@/lib/errors-core";
import { branchNameSchema } from "@/lib/git-ref-names";

// ADR-181 D4: the PUBLIC name a run branch is published under. The internal
// branch stays the run's identity; only the remote-side name is rendered here.
// Pure and client-safe: the manifest schema validates templates with it.

export const DEFAULT_PUBLIC_BRANCH_TEMPLATE = "feature/{task_key}-{slug}";

const PUBLIC_BRANCH_PLACEHOLDERS = ["task_key", "slug", "attempt"] as const;

type Placeholder = (typeof PUBLIC_BRANCH_PLACEHOLDERS)[number];

const SLUG_MAX = 40;

// Fixed table (ADR-181): every other non-ASCII code point is dropped.
const CYRILLIC: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

const SEPARATORS = new Set(["-", "_", "/", "."]);

export type PublicBranchVars = {
  // `<projects.task_key>-<tasks.number>`, or null for a task-less run.
  taskKey: string | null;
  title: string | null;
  attempt: number;
  runId: string;
};

function refuse(message: string): MaisterError {
  return new MaisterError("CONFIG", message, {
    details: { reason: "public_branch_template_invalid" },
  });
}

export function transliterate(text: string): string {
  let out = "";

  for (const ch of text) {
    const lower = ch.toLowerCase();
    const mapped = CYRILLIC[lower];

    if (mapped !== undefined) {
      out +=
        ch !== lower && mapped.length > 0
          ? mapped[0].toUpperCase() + mapped.slice(1)
          : mapped;
    } else if (ch.charCodeAt(0) < 128) {
      out += ch;
    }
  }

  return out;
}

export function slugifyTitle(title: string | null): string {
  if (!title) return "";

  const collapsed = transliterate(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return collapsed.slice(0, SLUG_MAX).replace(/-+$/g, "");
}

// A flow branch ends `attempt-N`; agent and scratch branches carry none (= 1).
export function attemptFromBranch(branch: string): number {
  const match = /attempt-(\d+)$/.exec(branch);

  return match ? Number(match[1]) : 1;
}

function placeholdersIn(template: string): string[] {
  return Array.from(template.matchAll(/\{([^{}]*)\}/g), (m) => m[1]);
}

// An empty placeholder takes ONE adjacent separator with it — the one after it
// when there is one, else the one before — so `feature/{task_key}-{slug}` with
// an empty slug is `feature/ABC-12`, not `feature/ABC-12-`.
function render(template: string, values: Record<Placeholder, string>): string {
  const parts = template.split(/(\{[^{}]*\})/g);
  let out = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const name = /^\{([^{}]*)\}$/.exec(part)?.[1];

    if (name === undefined) {
      out += part;
      continue;
    }

    const value = values[name as Placeholder];

    if (value !== "") {
      out += value;
      continue;
    }

    const next = parts[i + 1];

    if (next && SEPARATORS.has(next[0])) {
      parts[i + 1] = next.slice(1);
    } else if (out.length > 0 && SEPARATORS.has(out[out.length - 1])) {
      out = out.slice(0, -1);
    }
  }

  return out;
}

export function renderPublicBranchName(
  template: string,
  vars: PublicBranchVars,
): string {
  const unknown = placeholdersIn(template).filter(
    (p) => !(PUBLIC_BRANCH_PLACEHOLDERS as readonly string[]).includes(p),
  );

  if (unknown.length > 0) {
    throw refuse(
      `public branch template uses unknown placeholder(s): ${unknown.join(", ")}`,
    );
  }

  const name = render(template, {
    task_key: vars.taskKey ?? `run-${vars.runId.slice(0, 8)}`,
    slug: slugifyTitle(vars.title),
    attempt: String(vars.attempt),
  });
  const parsed = branchNameSchema.safeParse(name);

  if (!parsed.success) {
    throw refuse(
      `public branch template rendered an invalid branch name "${name}": ${parsed.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    );
  }

  return parsed.data;
}

// Validation on the ACTION path's inputs: known placeholders only, at least one,
// no stray brace, and a sample render must be a valid branch name.
export function validatePublicBranchTemplate(template: string): void {
  const names = placeholdersIn(template);

  if (names.length === 0) {
    throw refuse("public branch template must use at least one placeholder");
  }
  if (template.replace(/\{[^{}]*\}/g, "").match(/[{}]/)) {
    throw refuse("public branch template has an unbalanced brace");
  }

  renderPublicBranchName(template, {
    taskKey: "ABC-1",
    title: "sample title",
    attempt: 1,
    runId: "00000000-0000-4000-8000-000000000000",
  });
}
