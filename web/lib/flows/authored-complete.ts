import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";

import { autocompletion } from "@codemirror/autocomplete";

export const FLOW_STEP_TYPES = ["cli", "agent", "guard", "human"] as const;

const FLOW_YAML_KEYS = [
  "schemaVersion",
  "name",
  "steps",
  "nodes",
  "runner_profiles",
  "setup",
  "compat",
  "capabilities",
  "gates",
  "artifacts",
  "external_ops",
  "presentation",
] as const;

const RUNNER_NAMES = ["claude-code", "codex", "claude", "glm"] as const;

const FRONTMATTER_KEYS = [
  "description",
  "tools",
  "model",
  "color",
  "allowed-tools",
] as const;

const VOCAB: readonly string[] = Array.from(
  new Set<string>([
    ...FLOW_STEP_TYPES,
    ...FLOW_YAML_KEYS,
    ...RUNNER_NAMES,
    ...FRONTMATTER_KEYS,
  ]),
);

export function flowYamlCompletions(prefix: string): string[] {
  if (prefix.length === 0) {
    return [...VOCAB];
  }

  const needle = prefix.toLowerCase();

  return VOCAB.filter((option) => option.toLowerCase().startsWith(needle));
}

export function authoredFlowCompletionSource(): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w-]*/);

    if (!word || (word.from === word.to && !context.explicit)) {
      return null;
    }

    const options: Completion[] = flowYamlCompletions(word.text).map(
      (label) => ({ label, type: "keyword" }),
    );

    if (options.length === 0) {
      return null;
    }

    return { from: word.from, options };
  };
}

export function authoredFlowAutocomplete(): Extension {
  return autocompletion({ override: [authoredFlowCompletionSource()] });
}
