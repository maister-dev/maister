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

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { resubmitDependency } from "../commands";
import { readProjectDeclarations } from "../read";
import { serviceDependency } from "../worker";

import { enableRevision } from "@/lib/flows/lifecycle";
import { trustExecutable } from "@/lib/flows/exec-trust";
import { readProjectCapabilityRefs } from "@/lib/flows/project-capability-refs";
import { installFlowPlugin } from "@/lib/flows";
import {
  attachPackage,
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import {
  projectDependencyAttempts as attempts,
  projectDependencyDeclarations as declarations,
  flows,
  flowRevisions,
  packageInstalls,
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
    for (const [bundle, skills] of [
      ["bundle", ["shared", "blocked-only"]],
      ["ready-bundle", ["shared", "ready-only"]],
    ] as const) {
      for (const skill of skills) {
        const directory = join(source, bundle, "skills", skill);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), skill);
      }
    }
    await writeFile(
      join(source, "maister-package.yaml"),
      "schemaVersion: 1\nname: package-" +
        kind +
        "\ncapabilities:\n  - { id: bundle-" +
        kind +
        ", path: bundle }\n  - { id: ready-bundle, path: ready-bundle }\n",
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
    const availableSkills = async () => {
      const refs = await readProjectCapabilityRefs(db, [projectId]);
      return ["blocked-only", "ready-only", "shared"].filter((skill) =>
        refs.get(projectId)?.skill.has(skill),
      );
    };
    expect(await availableSkills()).toEqual([]);
    if (kind === "failed") {
      // Simulate an existing package whose verified inventory lists skill IDs without their providers.
      await db
        .update(packageInstalls)
        .set({ manifest: sql`manifest #- '{inventory,skillsByCapability}'` })
        .where(eq(packageInstalls.id, install.id));
    }
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
    expect.soft(await availableSkills()).toEqual(["ready-only", "shared"]);

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
    expect(await availableSkills()).toEqual([
      "blocked-only",
      "ready-only",
      "shared",
    ]);
  },
  20000,
);

async function pendingFlow(label: string) {
  const db = database.db;
  const projectId = randomUUID();
  const slug = "standalone-" + label;
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
    slug: slug,
    repoPath: repo,
    taskKey: label.toUpperCase(),
  });
  const flow = await installFlowPlugin({
    db,
    projectId,
    projectSlug: slug,
    workspaceRoot: repo,
    source,
    version: "local",
    flowId: label,
    execTrustOverride: "untrusted",
  });
  const [head] = await db
    .insert(declarations)
    .values({
      projectId,
      kind: "flow",
      logicalId: label,
      ordinal: 0,
      desired: { source, version: "local" },
      effectiveGeneration: 1,
      effectiveRevision: flow.revision,
    })
    .returning();

  return { db, projectId, flow, ready, head, slug };
}

it("retries an exact trusted standalone Flow revision after a settings-visible setup failure", async () => {
  const { db, projectId, flow, ready, head, slug } =
    await pendingFlow("recover");
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
      projectSlug: slug,
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

it("reports a repairable failure when a pending Flow script disappears before trust", async () => {
  const { db, projectId, flow, head } = await pendingFlow("missing");
  await rm(join(flow.installedPath, "setup.sh"));
  await expect(
    trustExecutable({
      db,
      projectId,
      flowId: flow.flowRowId,
      actorUserId: actor,
    }),
  ).rejects.toMatchObject({
    details: {
      trustAccepted: true,
      declarationId: head.id,
      reason: "setup_material_changed",
      memberRef: "flow:missing",
    },
  });
  const [rev] = await db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, flow.revisionId));
  expect(rev.setupStatus).toBe("pending");
});

it.each(["trust", "enable"] as const)(
  "refuses a stale Flow pointer during %s without running setup",
  async (action) => {
    const { db, projectId, flow, ready } = await pendingFlow(action);
    await writeFile(ready, "ready");
    let operation: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .for("update");
      await tx
        .select()
        .from(flowRevisions)
        .where(eq(flowRevisions.id, flow.revisionId))
        .for("update");
      const [{ pid }] = (
        await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
      ).rows;
      operation = (
        action === "trust"
          ? trustExecutable({
              db,
              projectId,
              flowId: flow.flowRowId,
              actorUserId: actor,
            })
          : enableRevision({
              db,
              projectId,
              flowRefId: action,
              revisionId: flow.revisionId,
              authorizeExecution: async () => ({ id: actor }),
            })
      ).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(async () => {
        const { rows } = await db.execute(
          sql`select 1 from pg_stat_activity where ${pid}::int=any(pg_blocking_pids(pid))`,
        );
        expect(rows).toHaveLength(1);
      });
      await tx.delete(flows).where(eq(flows.id, flow.flowRowId));
    });
    expect(await operation).toMatchObject({
      code: "CONFLICT",
      details: { reason: "stale_generation" },
    });
    const [rev] = await db
      .select()
      .from(flowRevisions)
      .where(eq(flowRevisions.id, flow.revisionId));
    expect(rev).toMatchObject({
      setupStatus: "pending",
      execTrust: "untrusted",
    });
    await expect(
      access(join(flow.installedPath, ".maister-setup-done")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["platform", "mixed", "ready"] as const)(
  "scopes %s package trust setup to current attached declarations",
  async (mode) => {
    const db = database.db,
      name = "fanout-" + mode,
      source = join(root, name),
      member = join(source, "flow");
    const effect = join(root, name + ".effect");
    await mkdir(join(source, "bundle"), { recursive: true });
    await writeFile(join(source, "bundle", "instructions.md"), "static");
    await mkdir(member, { recursive: true });
    await writeFile(
      join(source, "maister-package.yaml"),
      "schemaVersion: 1\nname: " +
        name +
        "\nflows:\n  - {id: " +
        name +
        ", path: flow}\ncapabilities:\n  - {id: static-bundle, path: bundle}\n",
    );
    await writeFile(
      join(member, "flow.yaml"),
      "schemaVersion: 1\nname: " +
        name +
        "\ncompat: {engine_min: 3.0.0}\nnodes:\n  - id: step\n    type: cli\n    action: {command: echo ok}\n    transitions: {success: done}\n",
    );
    if (mode !== "ready")
      await writeFile(
        join(member, "setup.sh"),
        "echo ran >> '" + effect + "'\n",
      );
    const install = await installPackageRevision({
      db,
      source,
      version: "local",
      trustStatus: "untrusted",
    });
    const headIds: string[] = [];
    if (mode !== "platform") {
      for (const label of mode === "mixed"
        ? ["replacing", "current"]
        : ["ready"]) {
        const slug = name + "-" + label,
          projectId = randomUUID(),
          repo = join(root, slug);
        await mkdir(repo);
        await db.insert(projects).values({
          id: projectId,
          slug,
          name: slug,
          taskKey: label.toUpperCase(),
          repoPath: repo,
        });
        await attachPackage({
          db,
          projectId,
          projectSlug: slug,
          workspaceRoot: repo,
          packageInstallId: install.id,
        });
        const [head] = await db
          .select()
          .from(declarations)
          .where(eq(declarations.projectId, projectId));
        headIds.push(head.id);
        if (label === "replacing")
          await db
            .update(declarations)
            .set({
              generation: 2,
              desired: { ...head.desired, version: "next" },
            })
            .where(eq(declarations.id, head.id));
      }
    }
    await expect(
      trustPackageRevision({
        db,
        packageInstallId: install.id,
        actorUserId: actor,
      }),
    ).resolves.toEqual({ trusted: true });
    if (mode === "platform")
      await expect(access(effect)).rejects.toMatchObject({ code: "ENOENT" });
    else if (mode === "ready") {
      const enabled = await db.execute(
        sql`select capability_ref_id from capability_records c join projects p on p.id=c.project_id where p.slug=${name + "-ready"} and c.capability_ref_id='static-bundle' and c.selectable and c.disabled_at is null`,
      );
      expect(enabled.rows).toHaveLength(1);
      expect(
        await db
          .select()
          .from(attempts)
          .where(eq(attempts.declarationId, headIds[0])),
      ).toEqual([]);
    } else {
      expect(await readFile(effect, "utf8")).toBe("ran\n");
      expect(
        await db
          .select()
          .from(attempts)
          .where(eq(attempts.declarationId, headIds[0])),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(attempts)
          .where(eq(attempts.declarationId, headIds[1])),
      ).toMatchObject([
        { status: "succeeded", checkpoint: { postTrust: { id: install.id } } },
      ]);
    }
  },
);
