import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type FlowFixtureKind =
  | "valid"
  | "invalid-manifest"
  | "with-setup-ok"
  | "with-setup-fail";

const VALID_FLOW_YAML_V1 = `schemaVersion: 1
name: Test Flow
runner_profiles:
  claude-default:
    capability_agent: claude
    adapter: claude
    model: claude-sonnet-4-6
    provider:
      kind: anthropic
steps:
  - id: plan
    type: agent
    mode: new-session
    prompt: "/plan {{ task.prompt }}"
`;

const VALID_FLOW_YAML_V11 = `schemaVersion: 1
name: Test Flow v1.1
runner_profiles:
  claude-glm:
    capability_agent: claude
    adapter: claude
    model: glm-5.1
    provider:
      kind: anthropic_compatible
      requires_auth_token: true
steps:
  - id: plan
    type: agent
    mode: new-session
    prompt: "/plan {{ task.prompt }}"
`;

const INVALID_FLOW_YAML = `schemaVersion: 99
name: Broken Flow
steps:
  - id: plan
    type: agent
    mode: new-session
    prompt: "/plan {{ task.prompt }}"
`;

async function gitRun(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

async function initRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await gitRun(repoDir, ["init", "-q"]);
  await gitRun(repoDir, ["checkout", "-q", "-b", "main"]);
}

export async function buildFlowFixture(
  parentDir: string,
  kind: FlowFixtureKind,
  nameSuffix = "",
): Promise<string> {
  const repoDir = join(
    parentDir,
    `flow-${kind}${nameSuffix ? `-${nameSuffix}` : ""}`,
  );

  await initRepo(repoDir);

  if (kind === "valid") {
    await writeFile(join(repoDir, "flow.yaml"), VALID_FLOW_YAML_V1);
    await gitRun(repoDir, ["add", "."]);
    await gitRun(repoDir, ["commit", "-q", "-m", "init v1.0.0"]);
    await gitRun(repoDir, ["tag", "v1.0.0"]);

    await writeFile(join(repoDir, "flow.yaml"), VALID_FLOW_YAML_V11);
    await gitRun(repoDir, ["add", "."]);
    await gitRun(repoDir, ["commit", "-q", "-m", "bump v1.1.0"]);
    await gitRun(repoDir, ["tag", "v1.1.0"]);
  } else if (kind === "invalid-manifest") {
    await writeFile(join(repoDir, "flow.yaml"), INVALID_FLOW_YAML);
    await gitRun(repoDir, ["add", "."]);
    await gitRun(repoDir, ["commit", "-q", "-m", "init v1.0.0"]);
    await gitRun(repoDir, ["tag", "v1.0.0"]);
  } else {
    const exitCode = kind === "with-setup-ok" ? 0 : 1;

    await writeFile(join(repoDir, "flow.yaml"), VALID_FLOW_YAML_V1);
    await writeFile(
      join(repoDir, "setup.sh"),
      `#!/usr/bin/env bash\necho "setup.sh ran"\nexit ${exitCode}\n`,
    );
    await chmod(join(repoDir, "setup.sh"), 0o755);
    await gitRun(repoDir, ["add", "."]);
    await gitRun(repoDir, ["commit", "-q", "-m", "init v1.0.0"]);
    await gitRun(repoDir, ["tag", "v1.0.0"]);
  }

  return repoDir;
}
