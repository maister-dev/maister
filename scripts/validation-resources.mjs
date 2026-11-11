/** @param {string | undefined} value @param {string} name @returns {number | undefined} */
function configuredWorkers(value, name) {
  if (value === undefined) return undefined;
  const workers = Number(value);

  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(workers)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }

  return workers;
}

/**
 * Optional test worker ceiling for a shared host; unset preserves local defaults.
 * @param {Readonly<NodeJS.ProcessEnv>} environment
 * @returns {number | undefined}
 */
export function testMaxWorkers(environment) {
  return configuredWorkers(
    environment.MAISTER_TEST_MAX_WORKERS,
    "MAISTER_TEST_MAX_WORKERS",
  );
}

/**
 * Optional Next page-data/prerender worker count; does not limit Turbopack threads.
 * @param {Readonly<NodeJS.ProcessEnv>} environment
 * @returns {number | undefined}
 */
export function buildMaxWorkers(environment) {
  return configuredWorkers(
    environment.MAISTER_BUILD_MAX_WORKERS,
    "MAISTER_BUILD_MAX_WORKERS",
  );
}
