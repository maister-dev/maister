import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  materializeAgentReadOnlySettings,
  restoreAgentMaterialization,
} from "@/lib/agents/dirty-watchdog";
import { materializeWithAgentLease } from "@/lib/agents/materialization-manifest";
import {
  capabilitySettingsOperation,
  materializeCapabilitySettings,
  reclaimCapabilitySettings,
  SETTINGS_BACKUP_RELATIVE,
  SETTINGS_MARKER_RELATIVE,
  SETTINGS_OPERATION_RELATIVE,
  SETTINGS_RELATIVE,
} from "@/lib/capabilities/settings-ownership";

let root: string;

beforeEach(async () => {
  // realpath so the macOS /var -> /private/var tmp symlink does not trip the
  // in-worktree path-safety checks (production worktrees are not symlinked).
  root = await realpath(await mkdtemp(path.join(tmpdir(), "settings-ownership-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("settings.local.json ownership", () => {
  it("does not let an L2 run adopt or delete an active capability profile's settings", async () => {
    const settingsPath = path.join(root, SETTINGS_RELATIVE);

    await materializeCapabilitySettings({
      cwd: root,
      runId: "profile-run",
      content: '{"profile":true}\n',
    });

    await expect(
      materializeAgentReadOnlySettings(root, "claude", "agent-run"),
    ).resolves.toEqual({ materialized: false });
    await restoreAgentMaterialization(root, "agent-run");

    await expect(readFile(settingsPath, "utf8")).resolves.toBe(
      '{"profile":true}\n',
    );
    await expect(
      reclaimCapabilitySettings({ cwd: root, runId: "profile-run" }),
    ).resolves.toEqual({ status: "reclaimed" });
  });

  it("rejects a missing-marker foreign settings lease instead of adopting it", async () => {
    const settingsPath = path.join(root, SETTINGS_RELATIVE);
    const markerPath = path.join(root, SETTINGS_MARKER_RELATIVE);

    await materializeWithAgentLease({
      cwd: root,
      runId: "foreign-run",
      materialize: async (_ownedPaths, recordIntent) => {
        await recordIntent([settingsPath, markerPath]);

        return [settingsPath, markerPath];
      },
    });

    await expect(
      materializeAgentReadOnlySettings(root, "claude", "new-run"),
    ).rejects.toThrow(/foreign materialization lease lacks an ownership marker/);
    await expect(readFile(settingsPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores a user settings file without deleting it while releasing capability leases", async () => {
    const settingsPath = path.join(root, SETTINGS_RELATIVE);
    const operationPath = path.join(root, SETTINGS_OPERATION_RELATIVE);

    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{"user":"original"}\n');
    await materializeCapabilitySettings({
      cwd: root,
      runId: "profile-run",
      content: '{"capability":true}\n',
    });
    await expect(readFile(operationPath, "utf8")).resolves.toContain(
      '"phase":"active"',
    );

    await restoreAgentMaterialization(root, "profile-run");

    await expect(readFile(settingsPath, "utf8")).resolves.toBe(
      '{"user":"original"}\n',
    );
  });

  it("rejects a second capability-profile owner in the same working directory", async () => {
    await materializeCapabilitySettings({
      cwd: root,
      runId: "first-run",
      content: '{"first":true}\n',
    });

    await expect(
      materializeCapabilitySettings({
        cwd: root,
        runId: "second-run",
        content: '{"second":true}\n',
      }),
    ).rejects.toThrow(/owned by capability run first-run/);
  });

  // The marker gained its `capability:`/`agent-l2:` kind prefix after the format
  // had already been written to disk as a BARE runId. Those markers live in
  // long-lived run worktrees, so an old run resuming (e.g. a human review
  // approved days later) hands the parser a legacy marker it must still read as
  // ITS OWN — otherwise the run fails `CONFLICT` claiming the settings are
  // "owned by an unknown MAIster writer" while naming the run's own id.
  it("adopts a legacy bare-runId marker written by the same run", async () => {
    const markerPath = path.join(root, SETTINGS_MARKER_RELATIVE);

    // The on-disk shape a pre-prefix claim actually leaves behind: materialized
    // settings, the user's original backed up beside them, and a marker holding
    // nothing but the run id (no `.maister-op` — the operation record postdates
    // these markers too).
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(path.join(root, SETTINGS_RELATIVE), '{"legacy":true}\n');
    await writeFile(path.join(root, SETTINGS_BACKUP_RELATIVE), '{"user":1}\n');
    await writeFile(markerPath, "legacy-run");

    await expect(
      materializeCapabilitySettings({
        cwd: root,
        runId: "legacy-run",
        content: '{"fresh":true}\n',
      }),
    ).resolves.toBe(path.join(root, SETTINGS_RELATIVE));

    // The run owns the file: its content is the freshly materialized profile.
    await expect(
      readFile(path.join(root, SETTINGS_RELATIVE), "utf8"),
    ).resolves.toBe('{"fresh":true}\n');

    // The marker is left in its legacy shape — a re-materialization by the owning
    // run rewrites content only. Pinned so the read-side tolerance is not quietly
    // swapped for an out-of-protocol re-stamp.
    await expect(readFile(markerPath, "utf8")).resolves.toBe("legacy-run");

    // And the legacy owner still releases cleanly through the normal path.
    await expect(
      reclaimCapabilitySettings({ cwd: root, runId: "legacy-run" }),
    ).resolves.toEqual({ status: "reclaimed" });
  });

  it("still refuses a legacy bare-runId marker owned by a DIFFERENT run", async () => {
    const markerPath = path.join(root, SETTINGS_MARKER_RELATIVE);

    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(path.join(root, SETTINGS_RELATIVE), '{"legacy":true}\n');
    await writeFile(markerPath, "someone-else");

    await expect(
      materializeCapabilitySettings({
        cwd: root,
        runId: "legacy-run",
        content: '{"fresh":true}\n',
      }),
    ).rejects.toThrow(/owned by capability run someone-else/);
  });

  it("refuses a symlinked Claude directory without writing outside the worktree", async () => {
    const outside = path.join(root, "outside");

    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, ".claude"));

    await expect(
      materializeCapabilitySettings({
        cwd: root,
        runId: "profile-run",
        content: '{"profile":true}\n',
      }),
    ).rejects.toThrow(/symlinked path component/);
    await expect(
      readFile(path.join(outside, "settings.local.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a capability settings cleanup path becomes symlinked", async () => {
    const outside = path.join(root, "outside");

    await materializeCapabilitySettings({
      cwd: root,
      runId: "profile-run",
      content: '{"profile":true}\n',
    });
    await rm(path.join(root, ".claude"), { recursive: true, force: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, ".claude"));

    await expect(
      restoreAgentMaterialization(root, "profile-run"),
    ).rejects.toThrow(/capability settings cleanup failed/);
    await expect(
      readFile(path.join(outside, "settings.local.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the original settings after a crash between capability write and ownership marker", async () => {
    const settingsPath = path.join(root, SETTINGS_RELATIVE);
    const backupPath = path.join(root, SETTINGS_BACKUP_RELATIVE);
    const operationPath = path.join(root, SETTINGS_OPERATION_RELATIVE);

    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{"user":"original"}\n');
    await writeFile(backupPath, '{"user":"original"}\n');
    await writeFile(settingsPath, '{"capability":true}\n');
    await writeFile(
      operationPath,
      capabilitySettingsOperation("profile-run", true, "settings_written"),
    );

    await expect(
      reclaimCapabilitySettings({ cwd: root, runId: "profile-run" }),
    ).resolves.toEqual({ status: "reclaimed" });
    await expect(readFile(settingsPath, "utf8")).resolves.toBe(
      '{"user":"original"}\n',
    );
    await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(operationPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves an original settings file when a crash happens before its backup", async () => {
    const settingsPath = path.join(root, SETTINGS_RELATIVE);
    const operationPath = path.join(root, SETTINGS_OPERATION_RELATIVE);

    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{"user":"original"}\n');
    await writeFile(operationPath, capabilitySettingsOperation("profile-run", true));

    await expect(
      reclaimCapabilitySettings({ cwd: root, runId: "profile-run" }),
    ).resolves.toEqual({ status: "reclaimed" });
    await expect(readFile(settingsPath, "utf8")).resolves.toBe(
      '{"user":"original"}\n',
    );
    await expect(readFile(operationPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed when a post-backup journal loses the original backup", async () => {
    const settingsPath = path.join(root, SETTINGS_RELATIVE);
    const operationPath = path.join(root, SETTINGS_OPERATION_RELATIVE);

    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{"capability":true}\n');
    await writeFile(
      operationPath,
      capabilitySettingsOperation("profile-run", true, "settings_written"),
    );

    await expect(
      reclaimCapabilitySettings({ cwd: root, runId: "profile-run" }),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(readFile(settingsPath, "utf8")).resolves.toBe(
      '{"capability":true}\n',
    );
    await expect(readFile(operationPath, "utf8")).resolves.toContain(
      '"phase":"settings_written"',
    );
  });

  it("fails closed for a legacy journal whose missing backup is ambiguous", async () => {
    const settingsPath = path.join(root, SETTINGS_RELATIVE);
    const operationPath = path.join(root, SETTINGS_OPERATION_RELATIVE);

    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{"capability":true}\n');
    await writeFile(
      operationPath,
      '{"version":1,"kind":"capability","runId":"profile-run","hadSettings":true}\n',
    );

    await expect(
      reclaimCapabilitySettings({ cwd: root, runId: "profile-run" }),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(readFile(settingsPath, "utf8")).resolves.toBe(
      '{"capability":true}\n',
    );
    await expect(readFile(operationPath, "utf8")).resolves.toContain(
      '"version":1',
    );
  });

  it("preserves a restored original when its cleanup journal outlives the backup", async () => {
    const settingsPath = path.join(root, SETTINGS_RELATIVE);
    const markerPath = path.join(root, SETTINGS_MARKER_RELATIVE);
    const operationPath = path.join(root, SETTINGS_OPERATION_RELATIVE);

    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{"user":"original"}\n');
    await writeFile(markerPath, "capability:profile-run\n");
    await writeFile(
      operationPath,
      capabilitySettingsOperation("profile-run", true, "settings_restored"),
    );

    await expect(
      reclaimCapabilitySettings({ cwd: root, runId: "profile-run" }),
    ).resolves.toEqual({ status: "reclaimed" });
    await expect(readFile(settingsPath, "utf8")).resolves.toBe(
      '{"user":"original"}\n',
    );
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(operationPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes a MAIster-created settings file after an interrupted first write", async () => {
    const settingsPath = path.join(root, SETTINGS_RELATIVE);
    const operationPath = path.join(root, SETTINGS_OPERATION_RELATIVE);

    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{"capability":true}\n');
    await writeFile(
      operationPath,
      capabilitySettingsOperation("profile-run", false, "settings_written"),
    );

    await expect(
      reclaimCapabilitySettings({ cwd: root, runId: "profile-run" }),
    ).resolves.toEqual({ status: "reclaimed" });
    await expect(readFile(settingsPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains a corrupt backup without deleting the capability settings it protects", async () => {
    const settingsPath = path.join(root, SETTINGS_RELATIVE);
    const markerPath = path.join(root, SETTINGS_MARKER_RELATIVE);

    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{"user":"original"}\n');
    await materializeCapabilitySettings({
      cwd: root,
      runId: "profile-run",
      content: '{"capability":true}\n',
    });
    await rm(markerPath, { force: true });

    await expect(
      reclaimCapabilitySettings({ cwd: root, runId: "profile-run" }),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(readFile(settingsPath, "utf8")).resolves.toBe(
      '{"capability":true}\n',
    );
    await expect(
      readFile(path.join(root, SETTINGS_BACKUP_RELATIVE), "utf8"),
    ).resolves.toBe('{"user":"original"}\n');
  });

  it("fails closed when an active operation loses its marker before a retry", async () => {
    const settingsPath = path.join(root, SETTINGS_RELATIVE);
    const markerPath = path.join(root, SETTINGS_MARKER_RELATIVE);
    const operationPath = path.join(root, SETTINGS_OPERATION_RELATIVE);

    await materializeCapabilitySettings({
      cwd: root,
      runId: "profile-run",
      content: '{"capability":true}\n',
    });
    await rm(markerPath, { force: true });

    await expect(
      materializeCapabilitySettings({
        cwd: root,
        runId: "profile-run",
        content: '{"replacement":true}\n',
      }),
    ).rejects.toThrow(/active operation is missing its ownership marker/);
    await expect(readFile(settingsPath, "utf8")).resolves.toBe(
      '{"capability":true}\n',
    );
    await expect(readFile(operationPath, "utf8")).resolves.toContain(
      '"phase":"active"',
    );
  });

  it("does not let a home-only adapter run retain its artifacts behind foreign capability settings", async () => {
    const homeRunId = "home-run";
    const homePath = path.join(
      root,
      ".maister/capabilities/home-run/codex-session",
    );

    await materializeCapabilitySettings({
      cwd: root,
      runId: "profile-run",
      content: '{"profile":true}\n',
    });
    await materializeWithAgentLease({
      cwd: root,
      runId: homeRunId,
      materialize: async (_ownedPaths, recordIntent) => {
        await recordIntent([homePath]);
        await mkdir(homePath, { recursive: true });

        return [homePath];
      },
    });

    await restoreAgentMaterialization(root, homeRunId);

    await expect(readFile(path.join(root, SETTINGS_RELATIVE), "utf8")).resolves.toBe(
      '{"profile":true}\n',
    );
    await expect(stat(homePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
