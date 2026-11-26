import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const localPullRequestUrl = "https://github.com/stage-c-fixture/repo/pull/7";

function shellLiteral(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

/** Route the provider fixture to a real, disposable Git repository without network access. */
export async function installLocalPullRequestProvider(root: string, repository: string) {
  const bin = join(root, "bin");
  const created = join(root, "pr-created");
  await mkdir(bin);
  await writeFile(join(bin, "ssh"), `#!/bin/sh
for last do :; done
case "$last" in
  "git-upload-pack '/stage-c-fixture/repo.git'") exec git-upload-pack ${shellLiteral(repository)} ;;
  "git-receive-pack '/stage-c-fixture/repo.git'") exec git-receive-pack ${shellLiteral(repository)} ;;
  *) exit 87 ;;
esac
`, { mode: 0o755 });
  await writeFile(join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
  '--version ') printf 'gh fixture\\n' ;;
  'auth token') printf 'fixture-only\\n' ;;
  'pr list')
    if test -f ${shellLiteral(created)}; then
      printf '%s\\n' '[{"url":"${localPullRequestUrl}","number":7,"baseRefName":"main"}]'
    else
      printf '[]\\n'
    fi ;;
  'pr view')
    test "$3" = "7" && test "$4" = "--repo" && test "$5" = "github.com/stage-c-fixture/repo" || exit 85
    exec cat ${shellLiteral(join(root, "pr-state.json"))} ;;
  'pr create')
    test "$3" = "--repo" && test "$4" = "github.com/stage-c-fixture/repo" || exit 86
    printf 'created\\n' >> ${shellLiteral(created)}
    printf '%s\\n' '${localPullRequestUrl}' ;;
  *) exit 88 ;;
esac
`, { mode: 0o755 });
  return {
    source: "ssh://git@github.com/stage-c-fixture/repo.git",
    path: `${bin}:${process.env.PATH}`,
    created,
  };
}
