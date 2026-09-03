import type { AdapterId } from "@/lib/acp-runners/adapter-support";

// i18n key (relative to the `settings` namespace) for the per-adapter setup
// hint shown when an adapter is not available/ready (ADR-094). Research-derived:
// codex uses `wire_api = responses` for OpenAI-compatible providers; the
// opencode package is `opencode-ai`; gemini is Google-only
// natively (non-Google needs a translating gateway); mimo is a native OpenCode
// fork. The actionable setup is the adapter binary plus provider credentials,
// where needed.
const SETUP_HINT_KEY_BY_ADAPTER: Record<AdapterId, string> = {
  claude: "setupHint.claude",
  codex: "setupHint.codex",
  gemini: "setupHint.gemini",
  opencode: "setupHint.opencode",
  mimo: "setupHint.mimo",
};

export function adapterSetupHint(adapter: AdapterId): string {
  return SETUP_HINT_KEY_BY_ADAPTER[adapter];
}
