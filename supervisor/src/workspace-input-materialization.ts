import type {
  MaterializedWorkspaceInputs,
  WorkspaceInputObject,
  WorkspaceMaterializeRequest,
} from "../../runtime/workspace-prepare";
import type { HostState, HostRuntimeObjectRow } from "./host-state";
import type { RuntimeObjectRegistry } from "./runtime-objects";
import type { ContextMount } from "./types";

import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
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
  WORKSPACE_FLOW_ASSET_DIRECTORY,
  WORKSPACE_INPUT_MANIFEST_MAX_BYTES,
  WORKSPACE_INPUT_MANIFEST_NAME,
  WORKSPACE_INPUT_MAX_BYTES,
  WORKSPACE_INPUT_MAX_FILES,
} from "../../runtime/workspace-input-policy";

import { withSqliteFileLock } from "./sqlite-file-lock";
import { SupervisorError } from "./types";
import {
  loadWorkspaceContextMounts,
  materializeWorkspaceContextInputs,
  readWorkspaceContextInputs,
} from "./workspace-context-inputs";

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
            executable: z.literal(true).optional(),
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
  if (
    parsed.data.files.some(
      ({ path, executable }) =>
        executable && !path.startsWith(WORKSPACE_FLOW_ASSET_DIRECTORY + "/"),
    )
  )
    throw rejectInput("only captured Flow package assets may be executable");

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

/** Verify the bytes handed to a side effect, with no verification/read gap. */
export async function readRetainedWorkspaceInput(
  directory: string,
  manifestDigest: string,
  name: string,
  maxBytes: number,
): Promise<Buffer | null> {
  await canonicalDirectory(directory);
  const manifest = await retainedInputManifest(directory, manifestDigest);
  const reference = manifest.files.find((file) => file.path === name);
  if (!reference) return null;

  return readVerifiedInputFile(directory, reference, maxBytes);
}

async function readVerifiedInputFile(
  directory: string,
  reference: InputManifest["files"][number],
  maxBytes: number,
): Promise<Buffer> {
  const path = join(directory, reference.path);
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    (stat.mode & 0o222) !== 0 ||
    (stat.mode & 0o111) !== (reference.executable ? 0o111 : 0) ||
    stat.size > maxBytes ||
    (await realpath(path)) !== path
  )
    throw rejectInput(
      "Retained declared workspace input has invalid file metadata",
    );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
  let length = 0;
  try {
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
  } finally {
    await file.close();
  }
  const bytes = buffer.subarray(0, length);
  if (
    bytes.byteLength !== stat.size ||
    createHash("sha256").update(bytes).digest("hex") !== reference.sha256
  )
    throw rejectInput(
      "Retained declared workspace input failed digest verification",
    );

  return bytes;
}

/** Build a command-local directory from only the files in the sealed Flow capture. */
export async function materializeWorkspaceFlowAssets(input: {
  inputDirectory: string;
  manifestDigest: string;
  commandDirectory: string;
}): Promise<string> {
  const { inputDirectory, manifestDigest, commandDirectory } = input;
  await canonicalDirectory(inputDirectory);
  const manifest = await retainedInputManifest(inputDirectory, manifestDigest);
  const prefix = WORKSPACE_FLOW_ASSET_DIRECTORY + "/";
  const assets = manifest.files.filter(({ path }) => path.startsWith(prefix));
  if (!assets.length)
    throw rejectInput("the command has no verified Flow package assets");
  let remaining = WORKSPACE_INPUT_MAX_BYTES;
  for (const asset of assets) {
    const bytes = await readVerifiedInputFile(inputDirectory, asset, remaining);
    remaining -= bytes.length;
    const destination = join(commandDirectory, asset.path);
    const mode = asset.executable ? 0o555 : 0o444;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode });
    await chmod(destination, mode);
  }

  return join(commandDirectory, WORKSPACE_FLOW_ASSET_DIRECTORY);
}

/** Apply the same generation verification at the final local side-effect boundary. */
type WorkspaceSessionInputs = Readonly<{
  ownershipKind: "host_owned";
  contextMounts: ContextMount[];
  packageInstructions?: string;
}>;

function packagedSkillInstructions(
  directory: string,
  files: InputManifest["files"],
): string | undefined {
  const packageSkills = files
    .flatMap(({ path }) => {
      const match =
        /^bundles\/(\d+)\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/.exec(
          path,
        );

      return match ? [{ order: Number(match[1]), slug: match[2], path }] : [];
    })
    .sort((left, right) => left.order - right.order);
  const selected = new Map<string, string>();

  for (const { slug, path } of packageSkills)
    if (!selected.has(slug)) selected.set(slug, path);
  if (selected.size === 0) return undefined;

  return [
    "## Packaged skills",
    `Read packaged instructions from the verified input root ${JSON.stringify(directory)}. Resolve companion files relative to each SKILL.md.`,
    ...Array.from(selected, ([slug, path]) => `- ${slug}: \`${path}\``),
  ].join("\n");
}

export async function verifyWorkspaceSessionInputs(
  state: HostState,
  handle: string,
  runtimeRoot: string,
  stepId: string,
): Promise<WorkspaceSessionInputs | undefined> {
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
    const runDir = join(
      await realpath(runtimeRoot),
      ".maister",
      workspace.projectSlug,
      "runs",
      workspace.runId,
    );
    const directory = join(runDir, "inputs", retained.materializationDigest);

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

    const contextMounts = await loadWorkspaceContextMounts({
      runDir,
      manifestDigest: retained.materializationDigest,
      contexts: await readWorkspaceContextInputs(directory, manifest.files),
      stepId,
    });

    return {
      ownershipKind: "host_owned",
      contextMounts,
      packageInstructions: packagedSkillInstructions(directory, manifest.files),
    };
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
      (stat.mode & 0o111) !== (input.executable ? 0o111 : 0) ||
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
  sources: ReadonlyMap<string, string>;
  assertOwner: () => void;
}): Promise<MaterializedWorkspaceInputs> {
  const { handle, request, state, objects, runtimeRoot, sources, assertOwner } =
    args;
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
          const mode = file.executable ? 0o555 : 0o444;
          await pipeline(
            verified.stream,
            createWriteStream(target, { flags: "wx", mode }),
          );
          await chmod(target, mode);
        }
        assertOwner();
        await rename(staging, destination);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      await verifyPublishedInputs(destination, manifest);
    }
    await materializeWorkspaceContextInputs({
      runDir,
      runtimeRoot: canonicalRoot,
      manifestDigest,
      contexts: await readWorkspaceContextInputs(destination, manifest.files),
      sources,
      assertOwner,
    });
    assertOwner();
    state.recordWorkspaceMaterialization(handle, generation, manifestDigest);

    return { generation, inputGeneration: 1, manifestDigest };
  });
}
