/** A recorded Git object ID always addresses the original object. */
export const GIT_EXACT_OBJECT_ENV = { GIT_NO_REPLACE_OBJECTS: "1" } as const;

/** Git reads use the selected directory and a separately supplied scratch index. */
export function gitInspectionEnvironment(
  indexFile?: string,
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH,
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    GIT_ALLOW_PROTOCOL: "",
    GIT_NO_LAZY_FETCH: "1",
    ...GIT_EXACT_OBJECT_ENV,
    GIT_OPTIONAL_LOCKS: "0",
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
  };
}
