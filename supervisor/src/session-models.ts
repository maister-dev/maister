import type * as acp from "@agentclientprotocol/sdk";

// ACP 1.x replaced the pre-1.0 `models` (SessionModelState) field of the
// session/new and session/resume responses with `configOptions`, a "model"
// select. codex-acp still sends `models` as an untyped extension (ids suffixed
// `[<effort>]`), and the mock fixtures speak the old shape, so both are read;
// configOptions win. The wire is unvalidated here on purpose (a malformed
// payload must never fail a session spawn) — every read is guarded.
export type LegacyModelInfo = {
  modelId: string;
  name?: string | null;
  description?: string | null;
};

export type SessionModelView = {
  // The "model" select option id when the adapter exposes one — the only
  // channel through which a model can be applied (session/set_config_option).
  configId: string | null;
  currentModelId: string | null;
  availableModels: LegacyModelInfo[];
};

const EMPTY: SessionModelView = {
  configId: null,
  currentModelId: null,
  availableModels: [],
};

type SessionResponseLike = {
  configOptions?: acp.SessionConfigOption[] | null;
  models?: {
    availableModels?: unknown;
    currentModelId?: unknown;
  } | null;
};

export function readSessionModels(response: unknown): SessionModelView {
  if (!response || typeof response !== "object") return EMPTY;
  const { configOptions, models } = response as SessionResponseLike;

  const option = Array.isArray(configOptions)
    ? configOptions.find(
        (candidate) =>
          candidate &&
          typeof candidate === "object" &&
          candidate.type === "select" &&
          candidate.category === "model",
      )
    : undefined;

  if (option && option.type === "select") {
    const flat: LegacyModelInfo[] = [];

    for (const entry of Array.isArray(option.options) ? option.options : []) {
      const items = "group" in entry ? entry.options : [entry];

      for (const item of items) {
        if (typeof item?.value === "string")
          flat.push({ modelId: item.value, name: item.name });
      }
    }

    return {
      configId: typeof option.id === "string" ? option.id : null,
      currentModelId:
        typeof option.currentValue === "string" ? option.currentValue : null,
      availableModels: flat,
    };
  }

  const legacy = Array.isArray(models?.availableModels)
    ? (models.availableModels as unknown[]).flatMap((item) =>
        item &&
        typeof item === "object" &&
        typeof (item as LegacyModelInfo).modelId === "string"
          ? [item as LegacyModelInfo]
          : [],
      )
    : [];

  return {
    configId: null,
    currentModelId:
      typeof models?.currentModelId === "string" ? models.currentModelId : null,
    availableModels: legacy,
  };
}
