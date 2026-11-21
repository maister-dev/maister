import type { StartedPostgresTestDb } from "./pg-container";

/** Seed the fixture's platform singleton without replacing an existing runner. */
export async function seedWorkspaceIntegritySettings(
  database: StartedPostgresTestDb,
): Promise<void> {
  await database.pool.query(`
    INSERT INTO platform_acp_runners (id, adapter, capability_agent, model, provider, enabled)
    VALUES ('test-integrity-default', 'codex', 'codex', 'test', '{}', false)
    ON CONFLICT DO NOTHING;
    INSERT INTO platform_runtime_settings (id, default_runner_id)
    VALUES ('singleton', 'test-integrity-default')
    ON CONFLICT DO NOTHING
  `);
}
