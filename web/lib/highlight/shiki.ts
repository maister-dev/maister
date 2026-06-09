import "server-only";

import pino from "pino";
import {
  type BundledLanguage,
  type Highlighter,
  bundledLanguages,
  createHighlighter,
} from "shiki";

// The hast `Root` Shiki returns from `codeToHast`. Derived from Shiki's own
// declared return type so we don't take a direct `@types/hast` dependency
// (it is only present transitively under pnpm).
export type HastRoot = ReturnType<Highlighter["codeToHast"]>;

const log = pino({
  name: "highlight",
  level: process.env.LOG_LEVEL ?? "info",
});

const LIGHT_THEME = "github-light";
const DARK_THEME = "github-dark";
const PLAINTEXT = "plaintext";

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  css: "css",
  scss: "scss",
  html: "html",
  sql: "sql",
};

export function langFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  if (dot <= 0) return PLAINTEXT;

  const ext = base.slice(dot + 1).toLowerCase();

  return LANG_BY_EXT[ext] ?? PLAINTEXT;
}

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterSync: Highlighter | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise === null) {
    highlighterPromise = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: [],
    })
      .then((h) => {
        highlighterSync = h;

        return h;
      })
      .catch((err: unknown) => {
        // Reset so a transient init failure (e.g. a slow wasm fetch) can retry on
        // the next call instead of poisoning the cached promise permanently.
        highlighterPromise = null;
        log.warn({ err }, "shiki highlighter init failed");
        throw err;
      });
  }

  return highlighterPromise;
}

const warnedLangs = new Set<string>();

function warnUnknownLangOnce(lang: string): void {
  if (warnedLangs.has(lang)) return;
  warnedLangs.add(lang);
  log.warn({ lang }, "unknown highlight lang — falling back to plaintext");
}

async function resolveLang(
  highlighter: Highlighter,
  lang: string,
): Promise<string> {
  if (lang === PLAINTEXT) return PLAINTEXT;
  if (highlighter.getLoadedLanguages().includes(lang)) return lang;

  if (!(lang in bundledLanguages)) {
    warnUnknownLangOnce(lang);

    return PLAINTEXT;
  }

  try {
    await highlighter.loadLanguage(lang as BundledLanguage);

    return lang;
  } catch (err) {
    warnUnknownLangOnce(lang);
    log.warn({ lang, err }, "shiki loadLanguage failed — using plaintext");

    return PLAINTEXT;
  }
}

export async function highlightToHtml(
  code: string,
  lang: string,
): Promise<string> {
  const highlighter = await getHighlighter();
  const effective = await resolveLang(highlighter, lang);

  return highlighter.codeToHtml(code, {
    lang: effective,
    themes: { light: LIGHT_THEME, dark: DARK_THEME },
    defaultColor: false,
  });
}

export async function preloadDiffLangs(
  langs: readonly string[],
): Promise<void> {
  const highlighter = await getHighlighter();

  await Promise.all(langs.map((lang) => resolveLang(highlighter, lang)));
}

export function isDiffLangReady(lang: string): boolean {
  if (lang === PLAINTEXT) return true;
  if (highlighterSync === null) return false;

  return highlighterSync.getLoadedLanguages().includes(lang);
}

// Emits DUAL-theme hast (`defaultColor:false`) so each token's inline `style`
// carries `--shiki-light` / `--shiki-dark` CSS vars instead of a concrete
// `color:#...`. The diff syntax bundle is built ONCE (theme-independent) and
// recolored on light/dark toggle via CSS — matching `highlightToHtml`. The
// `theme` param is vestigial (the bundle is no longer single-theme) but kept so
// the `DiffFileHighlighter.getAST(raw, fileName, lang, theme)` shape is honored.
export function codeToHastSync(
  code: string,
  lang: string,
  _theme: "light" | "dark",
): HastRoot {
  if (highlighterSync === null) {
    throw new Error(
      "codeToHastSync called before preloadDiffLangs resolved the highlighter",
    );
  }

  const effective =
    lang !== PLAINTEXT && highlighterSync.getLoadedLanguages().includes(lang)
      ? lang
      : PLAINTEXT;

  if (effective === PLAINTEXT && lang !== PLAINTEXT) warnUnknownLangOnce(lang);

  return highlighterSync.codeToHast(code, {
    lang: effective,
    themes: { light: LIGHT_THEME, dark: DARK_THEME },
    defaultColor: false,
  });
}
