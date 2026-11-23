import type {
  MaterializedWorkspaceInputs,
  WorkspaceInputObject,
  WorkspaceMaterializeRequest,
} from "../../runtime/workspace-prepare";
import type { HostState, HostRuntimeObjectRow } from "./host-state";
import type { RuntimeObjectRegistry } from "./runtime-objects";

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

import {
  hasWorkspaceInputPathCollision,
  isWorkspaceInputPath,
  WORKSPACE_INPUT_MANIFEST_MAX_BYTES,
  WORKSPACE_INPUT_MANIFEST_NAME,
  WORKSPACE_INPUT_MAX_BYTES,
  WORKSPACE_INPUT_MAX_FILES,
} from "../../runtime/workspace-input-policy";

import { withSqliteFileLock } from "./sqlite-file-lock";
import { SupervisorError } from "./types";

const digest = z.string().regex(/^[a-f0-9]{64}$/);

const manifestSchema = z
  .object({
    version: z.literal(1),
    workspaceInputDigest: digest,
    files: z
      .array(
        z
          .object({
            path: z.string().refine(isWorkspaceInputPath),
            objectId: z.string().uuid(),
            sha256: digest,
          })
          .strict(),
      )
      .max(WORKSPACE_INPUT_MAX_FILES),
  })
  .strict();

type InputManifest = z.infer<typeof manifestSchema>;

function rejectInput(message: string): SupervisorError {
  return new SupervisorError("PRECONDITION", message, {
    details: { reason: "workspace_rejected" },
  });
}

function checkedObject(
  state: HostState,
  request: WorkspaceMaterializeRequest,
  reference: WorkspaceInputObject,
): HostRuntimeObjectRow & { sizeBytes: number } {
  const object = state.getRuntimeObject(reference.objectId);
  const owner = request.owner;
  if (
    !object ||
    object.runId !== owner.runId ||
    object.assignmentId !== owner.assignmentId ||
    object.assignmentEpoch !== owner.assignmentEpoch ||
    object.state !== "available" ||
    object.sha256 !== reference.sha256 ||
    object.sizeBytes === null ||
    ![
      "capability_profile",
      "capability_instructions",
      "agent_memory_snapshot",
      "attachment",
    ].includes(object.kind)
  )
    throw rejectInput(
      "sealed workspace input is missing or belongs to a different assignment",
    );

  return { ...object, sizeBytes: object.sizeBytes };
}

async function readManifest(
  registry: RuntimeObjectRegistry,
  object: HostRuntimeObjectRow & { sizeBytes: number },
): Promise<Readonly<{ manifest: InputManifest; bytes: Buffer }>> {
  if (
    object.kind !== "capability_profile" ||
    object.mimeType !== "application/json" ||
    object.sizeBytes > WORKSPACE_INPUT_MANIFEST_MAX_BYTES
  )
    throw rejectInput("invalid workspace input manifest object");
  const verified = await registry.read(object.id);
  const buffers: Buffer[] = [];
  for await (const bytes of verified.stream) buffers.push(Buffer.from(bytes));
  const bytes = Buffer.concat(buffers);

  return { bytes, manifest: parseManifest(bytes) };
}

function parseManifest(bytes: Buffer): InputManifest {
  let content: unknown;
  try {
    content = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw rejectInput("workspace input manifest is not JSON");
  }
  const parsed = manifestSchema.safeParse(content);
  if (!parsed.success)
    throw rejectInput("workspace input manifest has an invalid schema");
  if (hasWorkspaceInputPathCollision(parsed.data.files.map(({ path }) => path)))
    throw rejectInput("workspace input paths collide");

  return parsed.data;
}

async function retainedInputManifest(
  directory: string,
  manifestDigest: string,
): Promise<InputManifest> {
  const path = join(directory, WORKSPACE_INPUT_MANIFEST_NAME);
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    (stat.mode & 0o222) !== 0 ||
    stat.size > WORKSPACE_INPUT_MANIFEST_MAX_BYTES ||
    (await realpath(path)) !== path
  )
    throw rejectInput("retained workspace input manifest is invalid");
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== manifestDigest)
    throw rejectInput("retained workspace input manifest is invalid");

  return parseManifest(bytes);
}

/** Apply the same generation verification at the final local side-effect boundary. */
export async function verifyWorkspaceSessionInputs(
  state: HostState,
  handle: string,
  runtimeRoot: string,
): Promise<void> {
  const retained = state.getWorkspaceExecutionState(handle);

  if (!retained?.inputDigest) return;
  if (!retained.materializationGeneration || !retained.materializationDigest)
    throw new SupervisorError(
      "PRECONDITION",
      "Host workspace inputs must be materialized before session creation",
      {
        details: { reason: "workspace_preparation_pending" },
      },
    );
  try {
    const workspace = state.getWorkspace(handle);
    if (!workspace) throw rejectInput("workspace input owner disappeared");
    const directory = join(
      await realpath(runtimeRoot),
      ".maister",
      workspace.projectSlug,
      "runs",
      workspace.runId,
      "inputs",
      retained.materializationDigest,
    );

    await canonicalDirectory(directory);
    const manifest = await retainedInputManifest(
      directory,
      retained.materializationDigest,
    );
    if (manifest.workspaceInputDigest !== retained.inputDigest)
      throw rejectInput(
        "retained workspace input manifest no longer matches its prepared input identity",
      );
    await verifyPublishedInputs(directory, manifest);
  } catch (cause) {
    throw new SupervisorError(
      "PRECONDITION",
      "Host workspace input generation failed its integrity check",
      {
        cause,
        details: { reason: "workspace_input_changed" },
      },
    );
  }
}

async function canonicalDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path)
    throw rejectInput("workspace input directory is not canonical");
}

async function verifyPublishedInputs(
  path: string,
  manifest: InputManifest,
): Promise<void> {
  await canonicalDirectory(path);
  for (const input of manifest.files) {
    const candidate = join(path, input.path);
    const stat = await lstat(candidate);
    if (
      !stat.isFile() ||
      (stat.mode & 0o222) !== 0 ||
      (await realpath(candidate)) !== candidate
    )
      throw rejectInput(
        "retained workspace input is no longer a read-only file",
      );
    const sha256 = createHash("sha256");
    for await (const bytes of createReadStream(candidate)) sha256.update(bytes);
    if (sha256.digest("hex") !== input.sha256)
      throw rejectInput("retained workspace input content changed");
  }
}

export async function materializeWorkspaceInputs(args: {
  handle: string;
  request: WorkspaceMaterializeRequest;
  state: HostState;
  objects: RuntimeObjectRegistry;
  runtimeRoot: string;
  assertOwner: () => void;
}): Promise<MaterializedWorkspaceInputs> {
  const { handle, request, state, objects, runtimeRoot, assertOwner } = args;
  const { generation, manifestDigest, objects: references } = request.payload;
  const workspace = state.getWorkspace(handle);
  const retained = state.getWorkspaceExecutionState(handle);
  if (
    workspace?.runId !== request.owner.runId ||
    workspace.releasedAt ||
    retained?.generation !== generation ||
    !retained.inputDigest
  )
    throw new SupervisorError(
      "FENCED",
      "Workspace input materialization lost its generation",
      {
        details: { reason: "stale_workspace_generation" },
      },
    );
  if (
    retained.materializationDigest &&
    retained.materializationDigest !== manifestDigest
  )
    throw rejectInput(
      "a different input manifest already owns the workspace generation",
    );

  const [manifestReference, ...fileReferences] = references;
  if (!manifestReference || manifestReference.sha256 !== manifestDigest)
    throw rejectInput(
      "workspace materialization requires its exact manifest digest",
    );
  const { bytes: manifestBytes, manifest } = await readManifest(
    objects,
    checkedObject(state, request, manifestReference),
  );
  if (manifest.workspaceInputDigest !== retained.inputDigest)
    throw rejectInput(
      "workspace input manifest does not match the prepared input identity",
    );

  const allowed = new Map(
    fileReferences.map((reference) => [
      reference.objectId,
      checkedObject(state, request, reference),
    ]),
  );
  const contentIds = new Set(manifest.files.map(({ objectId }) => objectId));
  if (
    allowed.size !== fileReferences.length ||
    allowed.has(manifestReference.objectId) ||
    allowed.size !== contentIds.size ||
    manifest.files.some(
      (file) => allowed.get(file.objectId)?.sha256 !== file.sha256,
    )
  )
    throw rejectInput(
      "workspace input manifest and sealed object set disagree",
    );
  if (
    [...allowed.values()].reduce((sum, object) => sum + object.sizeBytes, 0) >
    WORKSPACE_INPUT_MAX_BYTES
  )
    throw rejectInput("workspace input generation exceeds its byte budget");

  const canonicalRoot = await realpath(runtimeRoot);
  const runDir = join(
    canonicalRoot,
    ".maister",
    workspace.projectSlug,
    "runs",
    request.owner.runId,
  );
  const inputs = join(runDir, "inputs");
  await mkdir(inputs, { recursive: true, mode: 0o700 });
  await canonicalDirectory(inputs);
  const destination = join(inputs, manifestDigest);
  return withSqliteFileLock(join(inputs, "generation"), async () => {
    assertOwner();
    const current = state.getWorkspaceExecutionState(handle);
    if (
      current?.materializationDigest &&
      current.materializationDigest !== manifestDigest
    )
      throw rejectInput(
        "a different input manifest already owns the workspace generation",
      );
    let published = true;
    try {
      await retainedInputManifest(destination, manifestDigest);
      await verifyPublishedInputs(destination, manifest);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        current?.materializationDigest
      )
        throw error;
      published = false;
    }
    if (!published) {
      const staging = await mkdtemp(join(inputs, ".staging-"));
      try {
        await writeFile(
          join(staging, WORKSPACE_INPUT_MANIFEST_NAME),
          manifestBytes,
          { flag: "wx", mode: 0o444 },
        );
        for (const file of manifest.files) {
          const target = join(staging, file.path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          const verified = await objects.read(file.objectId);
          await pipeline(
            verified.stream,
            createWriteStream(target, { flags: "wx", mode: 0o444 }),
          );
          await chmod(target, 0o444);
        }
        assertOwner();
        await rename(staging, destination);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      await verifyPublishedInputs(destination, manifest);
    }
    assertOwner();
    state.recordWorkspaceMaterialization(handle, generation, manifestDigest);

    return { generation, inputGeneration: 1, manifestDigest };
  });
}
