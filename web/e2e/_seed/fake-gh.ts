import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

// ADR-181 T4.1: where the fake `gh` lives and records. The Playwright config
// prepends the bin dir to the dev server's PATH, the seed clears the state, and
// the workbench-git spec reads back what the provider was asked to do.
export const FAKE_GH_BIN_DIR = path.resolve("e2e/_seed/bin");
export const FAKE_GH_STATE = path.resolve("e2e/.runtime/fake-gh-state.json");

export type FakeGhState = {
  prs: {
    number: number;
    url: string;
    head: string;
    base: string;
    title: string;
    draft: boolean;
    open: boolean;
    repoPath: string;
  }[];
  creates: { head: string; base: string; title: string; draft: boolean }[];
  // Every `gh pr view`, by PR number.
  views: number[];
};

export function resetFakeGhState(): void {
  rmSync(FAKE_GH_STATE, { force: true });
}

export function readFakeGhState(): FakeGhState {
  return existsSync(FAKE_GH_STATE)
    ? (JSON.parse(readFileSync(FAKE_GH_STATE, "utf8")) as FakeGhState)
    : { prs: [], creates: [], views: [] };
}
