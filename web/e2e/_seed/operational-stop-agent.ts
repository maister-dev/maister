import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { withE2EDb } from "./db";
import type { ManualTaskLaunchFixture } from "./manual-task-launch";
import { E2E_HOLD_TURN_MARKER } from "./stub-supervisor";

export async function seedOperationalStopAgent(
  fixture: ManualTaskLaunchFixture,
): Promise<string> {
  const packageId = randomUUID();
  const packageName = `owned-stop-${randomUUID().slice(0, 8)}`;
  const agentId = `${packageName}:operation`;
  const installed = path.join(fixture.root, "stop-package");
  const source = path.join(installed, "maister-agents", "operation.md");

  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(
    source,
    `---\nname: Owned worktree operation\ndescription: controlled operational Stop boundary\nkind: operational\ncompletion: {contract: operational_v1}\nworkspace: worktree\nmode: session\ntriggers: [manual]\nrisk_tier: standard\nplatform_mcp: false\n---\nPreserve the source while this controlled operation waits. ${E2E_HOLD_TURN_MARKER}\n`,
  );
  await withE2EDb(async (pool) => {
    await pool.query(
      "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status) VALUES($1,$2,$3,'v1',$4,$5,'fixture',$2,'Installed','trusted')",
      [
        packageId,
        installed,
        packageName,
        "d".repeat(40),
        JSON.stringify({
          spec: {
            schemaVersion: 1,
            name: packageName,
            flows: [],
            compat: { engine_min: "3.10.0" },
          },
          inventory: { skills: [], agents: [], platformAgents: ["operation"] },
        }),
      ],
    );
    await pool.query(
      "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES($1,$2,$3,$4)",
      [randomUUID(), fixture.projectId, packageId, packageName],
    );
    await pool.query(
      "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path,kind,completion_contract) VALUES($1,$2,'v1','git','Owned worktree operation','controlled Stop boundary','worktree','session','[\"manual\"]','standard',$3,'operational','{\"contract\":\"operational_v1\"}')",
      [agentId, packageName, source],
    );
    await pool.query(
      "INSERT INTO agent_project_links(id,project_id,agent_id,runner_override_id) VALUES($1,$2,$3,$4)",
      [randomUUID(), fixture.projectId, agentId, fixture.runnerId],
    );
  });

  return agentId;
}
