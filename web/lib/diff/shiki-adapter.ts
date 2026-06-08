import "server-only";

import {
  type DiffAST,
  type DiffFileHighlighter,
  processAST,
} from "@git-diff-view/core";
import pino from "pino";

import {
  codeToHastSync,
  isDiffLangReady,
  langFromPath,
} from "@/lib/highlight/shiki";

const log = pino({
  name: "diff-shiki-adapter",
  level: process.env.LOG_LEVEL ?? "info",
});

let maxLineToIgnoreSyntax = 2000;
let ignoreSyntaxHighlightList: (string | RegExp)[] = [];

const warnedLangs = new Set<string>();

function warnUnsupportedLangOnce(lang: string): void {
  if (warnedLangs.has(lang)) return;
  warnedLangs.add(lang);
  log.warn(
    { lang },
    "unsupported diff highlight lang — falling back to plaintext",
  );
}

// git-diff-view calls `getAST(raw, fileName, lang, theme)`. The `theme` arg is
// ignored: `codeToHastSync` now emits DUAL-theme hast (CSS-var tokens), so the
// bundle is theme-independent and recolors via CSS on the light/dark toggle.
function getAST(raw: string, fileName?: string, lang?: string): DiffAST {
  const effectiveLang = lang ?? langFromPath(fileName ?? "");

  return codeToHastSync(raw, effectiveLang, "light");
}

function hasRegisteredCurrentLang(lang: string): boolean {
  const ready = isDiffLangReady(lang);

  if (!ready) warnUnsupportedLangOnce(lang);

  return ready;
}

export const shikiDiffHighlighter: DiffFileHighlighter = {
  name: "shiki",
  type: "style",
  get maxLineToIgnoreSyntax() {
    return maxLineToIgnoreSyntax;
  },
  setMaxLineToIgnoreSyntax: (v: number) => {
    maxLineToIgnoreSyntax = v;
  },
  get ignoreSyntaxHighlightList() {
    return ignoreSyntaxHighlightList;
  },
  setIgnoreSyntaxHighlightList: (v: (string | RegExp)[]) => {
    ignoreSyntaxHighlightList = v;
  },
  getAST,
  processAST,
  hasRegisteredCurrentLang,
};
