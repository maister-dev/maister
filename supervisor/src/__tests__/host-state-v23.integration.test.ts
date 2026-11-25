// IDX-12 (docs/supervisor.md §Host state) — host-state SQLite v23 adds the
// unconditional `session_process_run_idx (run_id, registered_at, command_id)`
// index so `sessionProcessesForRun` avoids scanning all obligations on every
// run command.
import type { Logger } from "pino";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HOST_STATE_FILE, openHostState } from "../host-state";

const dirs: string[] = [];

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "host-state-v23-"));

  dirs.push(dir);

  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("host-state v23 session_process_run_idx (IDX-12)", () => {
  it("IDX-12a fresh store creates session_process_run_idx with (run_id, registered_at, command_id)", async () => {
    const stateDir = await tempStateDir();
    const state = openHostState({ stateDir });

    state.close();

    const db = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 23,
      });
      const indexRow = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_process_run_idx'",
        )
        .get() as { name: string } | undefined;

      expect(indexRow?.name).toBe("session_process_run_idx");
      const cols = db
        .prepare("PRAGMA index_info('session_process_run_idx')")
        .all() as Array<{ name: string }>;

      expect(cols.map((c) => c.name)).toEqual([
        "run_id",
        "registered_at",
        "command_id",
      ]);
    } finally {
      db.close();
    }
  });

  it("IDX-12b upgrades a v22 store to user_version 23 and creates session_process_run_idx", async () => {
    const stateDir = await tempStateDir();
    const initial = openHostState({ stateDir });

    initial.close();

    // Rewind the store to exact v22 shape (without the v23 index).
    const prior = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

    try {
      prior.exec(
        "DROP INDEX IF EXISTS session_process_run_idx; PRAGMA user_version = 22;",
      );
      expect(prior.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 22,
      });
    } finally {
      prior.close();
    }

    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const upgraded = openHostState({
      stateDir,
      logger: { child: () => log } as unknown as Logger,
    });

    upgraded.close();

    // One upgrade line, and it reports the store's real version.
    const UPGRADE_MESSAGES = [
      "host state schema upgraded",
      "host-state-schema-migrated",
    ];

    expect(
      log.info.mock.calls.filter(([, message]) =>
        UPGRADE_MESSAGES.includes(String(message)),
      ),
    ).toEqual([[{ from: 22, to: 23 }, "host state schema upgraded"]]);

    const db = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 23,
      });
      const indexRow = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_process_run_idx'",
        )
        .get() as { name: string } | undefined;

      expect(indexRow?.name).toBe("session_process_run_idx");
    } finally {
      db.close();
    }
  });

  it("IDX-12c EXPLAIN QUERY PLAN for sessionProcessesForRun uses session_process_run_idx", async () => {
    const stateDir = await tempStateDir();
    const state = openHostState({ stateDir });
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");

    let readerSql: string | undefined;

    try {
      state.sessionProcessesForRun("run-1");
      // The reader's own statement, not a copy of it: the plan must follow the code.
      readerSql = prepare.mock.calls
        .map(([sql]) => String(sql))
        .find(
          (sql) =>
            sql.includes("FROM session_process_obligations") &&
            sql.includes("WHERE run_id=?"),
        );
    } finally {
      state.close();
      prepare.mockRestore();
    }

    expect(readerSql).toBeDefined();

    const db = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

    try {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${readerSql}`)
        .all("run-1") as Array<{ detail: string }>;

      const details = plan.map((row) => row.detail).join("\n");

      expect(details).toContain("USING INDEX session_process_run_idx");
      expect(details).not.toContain("USE TEMP B-TREE");
    } finally {
      db.close();
    }
  });
});
