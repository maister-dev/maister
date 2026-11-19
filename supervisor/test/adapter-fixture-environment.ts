const fixtureNames: ReadonlySet<string> = new Set([
  "MAISTER_RUNTIME_ROOT",
  "MAISTER_SMOKE_CHILD_PID_PATH",
  "MAISTER_SMOKE_CHILD_TERM_PATH",
  "MAISTER_TEST_CASE_NAME",
  "MAISTER_TEST_PROCESS_LEDGER",
  "MAISTER_TEST_PROCESS_OWNER",
  "MAISTER_TEST_PROCESS_PARENT",
  "MAISTER_TEST_WORKTREE_INVOCATION_ID",
]);

export function adapterFixtureAssignments(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    typeof value === "string" &&
    (fixtureNames.has(name) || /^MOCK_ACP_[A-Z0-9_]+$/.test(name))
      ? [`${name}=${value}`]
      : [],
  );
}

export function adapterFixtureShellCommand(
  env: NodeJS.ProcessEnv,
  fixture: string,
  args: readonly string[],
): string {
  const argv = [
    "/usr/bin/env",
    ...adapterFixtureAssignments(env),
    process.execPath,
    fixture,
    ...args,
  ];

  return `exec ${argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")} "$@"`;
}
