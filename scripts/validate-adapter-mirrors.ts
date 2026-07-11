import assert from "node:assert/strict";

import { listAdapterRuntimes } from "../supervisor/src/adapter-registry.ts";
import { ADAPTER_SUPPORT } from "../web/lib/acp-runners/adapter-support.ts";

type SharedAdapterContract = {
  readonly id: string;
  readonly readOnlyCapable: boolean;
  readonly readOnlySessionSmoke: "required" | "not_required";
  readonly readOnlyMaterializer: "claude-settings" | "none";
  readonly modelChannel: "settings_local" | "set_session_model" | "advisory";
  readonly resumeStrategy:
    | "session_resume"
    | "load_session_pending_smoke"
    | "session_resume_pending_smoke";
};

function sharedContract(adapter: SharedAdapterContract): SharedAdapterContract {
  return {
    id: adapter.id,
    readOnlyCapable: adapter.readOnlyCapable,
    readOnlySessionSmoke: adapter.readOnlySessionSmoke,
    readOnlyMaterializer: adapter.readOnlyMaterializer,
    modelChannel: adapter.modelChannel,
    resumeStrategy: adapter.resumeStrategy,
  };
}

const webContracts = ADAPTER_SUPPORT.map(sharedContract);
const supervisorContracts = listAdapterRuntimes().map(sharedContract);

assert.deepStrictEqual(
  webContracts,
  supervisorContracts,
  "web and supervisor adapter descriptor mirrors differ",
);

process.stdout.write(
  `validate-adapter-mirrors: ${webContracts.length} adapter contract(s) aligned\n`,
);
