const HOST_POSIX_ROOTS =
  "Users|home|var|tmp|private|opt|etc|usr|app|repos|maister|\\.maister|dev|proc|sys|run|srv|mnt|media|Library|System|Volumes|cores|sbin|bin";

/**
 * Matches host/POSIX absolute filesystem roots or multi-segment rooted paths
 * while avoiding false positives on code comments (`//`, `/*`), JSX closing
 * tags (`/>`), arithmetic (`a / b`), URLs (`https://...`), and single-segment
 * route tokens (`/api`, `/login`).
 */
export const HOST_ABSOLUTE_PATH_PATTERN = new RegExp(
  `(?:^|[\\s"'(=])\\/(?:(?:${HOST_POSIX_ROOTS})(?:\\/|[\\s"')\\]}]|$)|[A-Za-z0-9._-]+\\/[A-Za-z0-9._-]+)`,
);

export const FILE_URI_PATTERN = /(?:^|[\s"'(=])file:\/\//i;

export function containsHostFilesystemPath(value: string): boolean {
  return FILE_URI_PATTERN.test(value) || HOST_ABSOLUTE_PATH_PATTERN.test(value);
}
