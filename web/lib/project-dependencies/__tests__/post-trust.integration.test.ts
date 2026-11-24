import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { resubmitDependency } from "../commands";
import { readProjectDeclarations } from "../read";
import { serviceDependency } from "../worker";

import { trustExecutable } from "@/lib/flows/exec-trust";
import { installFlowPlugin } from "@/lib/flows";
import {
  attachPackage,
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import {
  projectDependencyAttempts as attempts,
  projectDependencyDeclarations as declarations,
  projects,
  users,
} from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
const actor = randomUUID();
const savedHome = process.env.HOME;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "post_trust_recovery",
  });
  root = await mkdtemp(join(tmpdir(), "maister-post-trust-"));
  process.env.HOME = root;
  await database.db.insert(users).values({
    id: actor,
    email: actor + "@test.invalid",
    role: "admin",
    accountStatus: "active",
  });
}, 180_000);
afterAll(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

it.each(["failed", "interrupted"] as const)(
  "can repair a %s post-trust package setup using the settings read model",
  async (kind) => {
    const db = database.db;
    const projectId = randomUUID();
    const repo = join(root, projectId);
    const source = join(repo, "source");
    const member = join(source, "bundle");
    const ready = join(repo, "ready"),
      effects = join(repo, "effects");

    await mkdir(member, { recursive: true });
    await writeFile(
      join(source, "maister-package.yaml"),
      "schemaVersion: 1\nname: package-" +
        kind +
        "\ncapabilities:\n  - { id: bundle-" +
        kind +
        ", path: bundle }\n",
    );
    await writeFile(
      join(member, "setup.sh"),
      "echo called >> '" +
        effects +
        "'\nif [ ! -e '" +
        ready +
        "' ]; then " +
        (kind === "failed" ? "exit 1" : "exec sleep 45") +
        "; fi\n",
    );
    await db.insert(projects).values({
      id: projectId,
      name: kind,
      slug: "project-" + kind,
      repoPath: repo,
      taskKey: kind.toUpperCase(),
    });
    const install = await installPackageRevision({
      source,
      version: "local",
      trustStatus: "untrusted",
      db,
    });

    await attachPackage({
      projectId,
      projectSlug: "project-" + kind,
      packageInstallId: install.id,
      workspaceRoot: repo,
      db,
    });
    const [head] = await db
      .select()
      .from(declarations)
      .where(eq(declarations.projectId, projectId));

    // Cover both an observed successful install and a migrated actor-less head.
    if (kind === "interrupted")
      await db.insert(attempts).values({
        projectId,
        declarationId: head.id,
        generation: 1,
        attemptNo: 1,
        desired: head.desired,
        actorUserId: actor,
        status: "succeeded",
        resolvedRevision: install.resolvedRevision,
      });
    const controller = new AbortController();
    const trust = trustPackageRevision({
      packageInstallId: install.id,
      db,
      actorUserId: actor,
      signal: controller.signal,
    }).then(
      () => null,
      (error) => error,
    );

    if (kind === "interrupted") {
      try {
        await vi.waitFor(() => access(effects), { timeout: 8000 });
        expect(
          await readProjectDeclarations(db, projectId, true),
        ).toMatchObject([{ readiness: "setup_pending" }]);
      } finally {
        controller.abort();
      }
    }
    expect(await trust).toMatchObject({
      code: kind === "failed" ? "FLOW_INSTALL" : "CONFLICT",
      details: {
        trustAccepted: true,
        projectSlug: "project-" + kind,
        declarationId: head.id,
      },
    });
    const [view] = await readProjectDeclarations(db, projectId, true);

    expect(view).toMatchObject({
      state: kind === "failed" ? "failed" : "recovery_required",
      stage: "setup",
      effectiveRevision: install.resolvedRevision,
      resolvedRevision: install.resolvedRevision,
      actions: {
        retry: kind === "failed",
        recoverSetup: kind === "interrupted",
      },
    });
    await expect(
      trustPackageRevision({
        packageInstallId: install.id,
        db,
        actorUserId: actor,
      }),
    ).rejects.toMatchObject({
      details: { trustAccepted: true, declarationId: head.id },
    });
    expect(await readFile(effects, "utf8")).toBe("called\n");
    await writeFile(ready, "ready");
    const expected = {
      expectedGeneration: view.generation,
      expectedAttempt: view.attempt!,
    };
    const request =
      kind === "failed"
        ? expected
        : {
            ...expected,
            action: "rerun_setup" as const,
            memberRef: view.memberRef!,
            resolvedRevision: view.resolvedRevision!,
          };
    const target = { projectId, declarationId: head.id, actorUserId: actor };
    const accepted = await resubmitDependency(db, target, request);

    expect(await resubmitDependency(db, target, request)).toEqual(accepted);
    expect(await serviceDependency(db, new AbortController().signal)).toBe(
      true,
    );
    expect(await readProjectDeclarations(db, projectId, true)).toMatchObject([
      {
        state: "succeeded",
        readiness: "installed",
        effectiveRevision: install.resolvedRevision,
      },
    ]);
    expect(await readFile(effects, "utf8")).toBe("called\ncalled\n");
  },
  20000,
);

it("retries an exact trusted standalone Flow revision after a settings-visible setup failure", async () => {
  const db = database.db;
  const projectId = randomUUID();
  const repo = join(root, projectId),
    source = join(repo, "source"),
    ready = join(repo, "ready");

  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "flow.yaml"),
    "schemaVersion: 1\nname: recover-flow\ncompat: {engine_min: 3.0.0}\nnodes:\n  - id: step\n    type: cli\n    action: {command: echo ok}\n    transitions: {success: done}\n",
  );
  await writeFile(join(source, "setup.sh"), "test -e '" + ready + "'\n");
  await db.insert(projects).values({
    id: projectId,
    name: "Flow",
    slug: "standalone-flow",
    repoPath: repo,
    taskKey: "SFL",
  });
  const flow = await installFlowPlugin({
    db,
    projectId,
    projectSlug: "standalone-flow",
    workspaceRoot: repo,
    source,
    version: "local",
    flowId: "recover-flow",
    execTrustOverride: "untrusted",
  });
  const [head] = await db
    .insert(declarations)
    .values({
      projectId,
      kind: "flow",
      logicalId: "recover-flow",
      ordinal: 0,
      desired: { source, version: "local" },
      effectiveGeneration: 1,
      effectiveRevision: flow.revision,
    })
    .returning();

  await expect(
    trustExecutable({
      db,
      projectId,
      flowId: flow.flowRowId,
      actorUserId: actor,
    }),
  ).rejects.toMatchObject({
    code: "FLOW_INSTALL",
    details: {
      trustAccepted: true,
      projectSlug: "standalone-flow",
      declarationId: head.id,
    },
  });
  const [view] = await readProjectDeclarations(db, projectId, true);

  expect(view).toMatchObject({
    state: "failed",
    stage: "setup",
    resolvedRevision: flow.revision,
    actions: { retry: true },
  });
  await writeFile(ready, "ready");
  await resubmitDependency(
    db,
    { projectId, declarationId: head.id, actorUserId: actor },
    { expectedGeneration: view.generation, expectedAttempt: view.attempt! },
  );
  expect(await serviceDependency(db, new AbortController().signal)).toBe(true);
  expect(await readProjectDeclarations(db, projectId, true)).toMatchObject([
    {
      state: "succeeded",
      readiness: "installed",
      effectiveRevision: flow.revision,
    },
  ]);
});
