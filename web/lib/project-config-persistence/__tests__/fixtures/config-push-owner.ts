import { requireProjectActionForUser } from "@/lib/authz";
import { closeDb, getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { confirmConfigurationPush } from "@/lib/project-config-persistence/push";

const [id, projectId, actorUserId, pushPreviewId] = process.argv.slice(2);

if (!id || !projectId || !actorUserId || !pushPreviewId)
  throw new Error("Missing operation fixture identity");

try {
  const receipt = await confirmConfigurationPush(
    getDb(),
    { id, projectId, actorUserId },
    pushPreviewId,
    async () => {
      await requireProjectActionForUser(actorUserId, projectId, "editSettings");
      await requireProjectActionForUser(
        actorUserId,
        projectId,
        "readRepoFiles",
      );
    },
  );

  process.stdout.write(
    JSON.stringify({
      recorded: "config-operation",
      state: receipt.state,
      sha: receipt.commitSha,
    }) + "\n",
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      recorded: "config-operation-error",
      code: error instanceof MaisterError ? error.code : "UNKNOWN",
      reason: error instanceof MaisterError ? error.details?.reason : undefined,
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
