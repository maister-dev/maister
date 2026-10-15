#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'Linux isolation prerequisite failed: %s\n' "$1" >&2
  exit 1
}

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail 'qualification requires Ubuntu 24.04 amd64'
[[ "$EUID" -ne 0 ]] || fail 'run the harness as an ordinary non-root user; sudo is provisioning only'
# OS metadata is a distribution-owned shell assignment file.
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail 'qualification requires Ubuntu 24.04'
node_version=$(node --print 'process.versions.node')
[[ "$node_version" == 24.15.0 || "$node_version" == 24.19.0 ]] || fail 'use exactly Node 24.15.0 or 24.19.0'
[[ -z "${NODE_OPTIONS-}" && -z "${LD_PRELOAD-}" && -z "${LD_LIBRARY_PATH-}" ]] || fail 'ambient Node/loader authority is forbidden during capability setup'
[[ -r /proc/sys/kernel/yama/ptrace_scope ]] || fail 'existing Yama ptrace_scope 1–3 is required; do not change host sysctls'
ptrace_scope=$(cat /proc/sys/kernel/yama/ptrace_scope)
[[ "$ptrace_scope" == 1 || "$ptrace_scope" == 2 || "$ptrace_scope" == 3 ]] || fail 'existing Yama ptrace_scope 1–3 is required; do not change host sysctls'
node --disable-sigusr1 --eval '' || fail 'Node lacks required SIGUSR1 inspector disablement'
printf 'ptrace_scope=%s\n' "$ptrace_scope"

bwrap_revision=0.9.0-1ubuntu0.3
installed_revision=$(dpkg-query -W -f='${Version}' bubblewrap 2>/dev/null || true)
if [[ "$installed_revision" != "$bwrap_revision" ]] || ! command -v cc >/dev/null || ! command -v apparmor_parser >/dev/null; then
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends "bubblewrap=$bwrap_revision" build-essential apparmor ca-certificates
fi
[[ "$(dpkg-query -W -f='${Version}' bubblewrap)" == "$bwrap_revision" ]] || fail 'the inspected Bubblewrap revision is unavailable'
[[ ! -u /usr/bin/bwrap && ! -g /usr/bin/bwrap ]] || fail 'rootless Bubblewrap must not have setuid/setgid bits'

script_directory=$(dirname -- "${BASH_SOURCE[0]}")
script_directory=$(realpath -- "$script_directory")
profile_source="$script_directory/isolation-linux-bwrap.apparmor"
profile_destination=/etc/apparmor.d/maister-test-bwrap
[[ -f "$profile_source" ]] || fail 'the versioned Bubblewrap AppArmor profile is missing'
if [[ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns && "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == 1 && ! -e /etc/apparmor.d/bwrap ]]; then
  if [[ -e "$profile_destination" ]]; then
    cmp --silent "$profile_source" "$profile_destination" || fail 'an existing test profile differs; reconcile it explicitly'
  else
    sudo -n apparmor_parser --skip-kernel-load "$profile_source"
    sudo -n install -m 0644 "$profile_source" "$profile_destination"
  fi
  sudo -n apparmor_parser --replace "$profile_destination"
fi

help=$(/usr/bin/bwrap --help)
for option in --unshare-user --unshare-pid --die-with-parent --disable-userns --assert-userns-disabled --cap-drop --json-status-fd --remount-ro; do
  [[ "$help" == *"$option"* ]] || fail "Bubblewrap lacks required option $option"
done
node_binary=$(command -v node)
node_binary=$(realpath -- "$node_binary")
libraries=$(ldd "$node_binary")
[[ "$libraries" != *'not found'* ]] || fail 'Node ELF dependency is unavailable'
arguments=(--unshare-user --unshare-pid --die-with-parent --disable-userns --assert-userns-disabled --cap-drop ALL --proc /proc --dev /dev --tmpfs /tmp --ro-bind "$node_binary" "$node_binary")
while IFS= read -r library; do
  [[ -f "$library" ]] || fail 'an enumerated Node ELF dependency is absent'
  arguments+=(--ro-bind "$library" "$library")
done < <(printf '%s\n' "$libraries" | awk '{for (i=1;i<=NF;i++) if ($i ~ /^\//) print $i}')
arguments+=(--remount-ro / --chdir / -- "$node_binary" --eval)
/usr/bin/bwrap "${arguments[@]}" 'const fs=require("node:fs"); const status=fs.readFileSync("/proc/self/status","utf8"); if(!/^NoNewPrivs:\s+1$/m.test(status)||!["CapEff","CapPrm","CapAmb"].every(key=>new RegExp("^"+key+":\\s+0+$","m").test(status))) throw new Error("namespace privileges are not dropped"); fs.statSync("/proc/1"); console.log(JSON.stringify({stage:"linux-namespace-capability",outcome:"passed",node:process.versions.node,platform:process.platform,arch:process.arch}));'
printf 'bubblewrap_revision=%s\n' "$bwrap_revision"
sha256sum /usr/bin/bwrap "$profile_source"
docker version
