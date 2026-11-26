import type {
  WorkspaceAssignmentOwner,
  WorkspaceInputObject,
} from "../../runtime/workspace-prepare";
import type { HostState } from "./host-state";
import type { RuntimeEventPublisher } from "./runtime-event-publisher";
import type { RuntimeObjectRegistry } from "./runtime-objects";

import { createHash, randomUUID } from "node:crypto";

/** Seal bounded bytes under their workspace assignment and announce catalogue evidence. */
export async function sealWorkspaceOutput(
  services: Readonly<{
    objects: RuntimeObjectRegistry;
    events: RuntimeEventPublisher;
    state: HostState;
  }>,
  owner: Pick<
    WorkspaceAssignmentOwner,
    "runId" | "assignmentId" | "assignmentEpoch"
  >,
  output: Readonly<{
    logicalName: string;
    mimeType: string;
    bytes: Buffer;
    source:
      | { workspaceWorkloadCommandId: string }
      | {
          workspaceGitDiff: {
            handle: string;
            generation: number;
            base: string;
            head: string | null;
            format?: "review";
          };
        }
      | {
          workspaceGitLog: {
            handle: string;
            generation: number;
            head: string;
            base?: string;
          };
        };
  }>,
): Promise<WorkspaceInputObject> {
  const objectId = randomUUID();
  const generation = 1;
  const { bytes, logicalName, mimeType } = output;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await services.objects.reserve({
    ...owner,
    payload: {
      objectId,
      kind: "diagnostic",
      logicalName,
      mimeType,
      retentionClass: "run",
      generation,
      sizeBytes: bytes.byteLength,
      sha256,
    },
  });
  const metadata = await services.objects.upload({
    objectId,
    assignmentId: owner.assignmentId,
    assignmentEpoch: owner.assignmentEpoch,
    generation,
    sha256,
    sizeBytes: bytes.byteLength,
    chunks: (async function* () {
      yield bytes;
    })(),
  });
  const event = services.events.runtimeObjectInput({ ...owner, metadata });
  services.state.appendRuntimeEvent({
    ...event,
    draft: {
      ...event.draft,
      payload: { ...event.draft.payload, ...output.source },
    },
  });

  return { objectId, sha256 };
}
