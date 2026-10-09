#!/usr/bin/env bash
set -euo pipefail
set -x

# The hosted runner recipe is Intel-only. Local ARM qualification uses its own
# container runtime and never invokes this script.
if test "$(uname -s)" != Darwin || test "$(uname -m)" != x86_64; then
  printf 'Hosted isolation runtime requires Darwin/x86_64; got %s/%s. Local ARM uses its existing runtime.\n' "$(uname -s)" "$(uname -m)" >&2
  exit 1
fi
: "${RUNNER_TEMP:?GitHub runner temporary directory is required}"
: "${GITHUB_ENV:?GitHub environment file is required}"
: "${GITHUB_PATH:?GitHub path file is required}"

runtime_dir="$RUNNER_TEMP/maister-isolation-runtime"
mkdir -p "$runtime_dir/bin"
export COLIMA_HOME="$runtime_dir/colima"
export LIMA_HOME="$runtime_dir/lima"
# Colima 0.10.3 honors COLIMA_HOME only when it already exists, and honors an
# ambient LIMA_HOME independently. Own both locations before its first call.
mkdir -p "$COLIMA_HOME" "$LIMA_HOME"
# Lima 2.2.0 checks the resolved home plus its longest SSH socket name and
# rejects paths of 104 bytes or more on Darwin. Check before any downloads.
node -e '
  const { realpathSync } = require("node:fs");
  const { join } = require("node:path");
  const socket = join(realpathSync(process.argv[1]), "colima-maister-s52", "ssh.sock.1234567890123456");
  const bytes = Buffer.byteLength(socket);
  if (bytes >= 104) {
    process.stderr.write(`Lima 2.2.0 SSH socket path must be shorter than 104 bytes: received ${bytes} bytes at ${socket}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`colima_profile=maister-s52 lima_longest_socket=${socket} socket_path_bytes=${bytes} maximum_exclusive_bytes=104\n`);
  }
' "$LIMA_HOME"
export PATH="$runtime_dir/bin:$PATH"
printf '%s\n' "$runtime_dir/bin" >> "$GITHUB_PATH"
printf 'COLIMA_HOME=%s\n' "$COLIMA_HOME" >> "$GITHUB_ENV"
printf 'LIMA_HOME=%s\n' "$LIMA_HOME" >> "$GITHUB_ENV"

curl --fail --location --retry 3 \
  https://github.com/abiosoft/colima/releases/download/v0.10.3/colima-Darwin-x86_64 \
  --output "$runtime_dir/bin/colima"
printf '%s  %s\n' \
  3082737fe8a98afda11cba7d9a20b6e56fe80c6153464beda04bec630758770b \
  "$runtime_dir/bin/colima" | shasum -a 256 --check
chmod +x "$runtime_dir/bin/colima"
curl --fail --location --retry 3 \
  https://github.com/lima-vm/lima/releases/download/v2.2.0/lima-2.2.0-Darwin-x86_64.tar.gz \
  --output "$runtime_dir/lima.tar.gz"
printf '%s  %s\n' \
  0d6f99c19f6e4bc3c92730c4c29d929e6927f0cb0a0ba1a84383367135a8ff31 \
  "$runtime_dir/lima.tar.gz" | shasum -a 256 --check
tar -xzf "$runtime_dir/lima.tar.gz" -C "$runtime_dir"
# Colima and Lima are checksum-pinned above; these two are NOT, deliberately.
# The Docker CLI and coreutils have no upstream formula whose version Homebrew
# can pin, and the isolation lane depends only on their stable surfaces (the
# `docker` client protocol and `gtimeout`). The resolved versions are echoed
# below so a hosted failure can be attributed to a version bump; pin them by
# direct download if that ever happens.
brew install docker coreutils
colima version
limactl --version
docker --version
gtimeout --version
printf 'profile=maister-s52\n' > "$runtime_dir/maister-s52.start-attempted"
colima --profile maister-s52 start \
  --runtime docker --vm-type vz --mount-type virtiofs \
  --cpu 3 --memory 6 --disk 20 --dns 1.1.1.1
status_json="$(colima --profile maister-s52 status --json)"
printf 'colima_status=%s\n' "$status_json"
socket_path="$(node -e '
  const { realpathSync } = require("node:fs");
  const { isAbsolute, join } = require("node:path");
  try {
    const status = JSON.parse(process.argv[1]);
    const uri = new URL(status.docker_socket);
    if (uri.protocol !== "unix:" || uri.hostname || !isAbsolute(uri.pathname))
      throw new Error("docker_socket must be an absolute unix URI");
    const socket = realpathSync(decodeURIComponent(uri.pathname));
    const expectedSocket = join(realpathSync(process.argv[2]), "maister-s52", "docker.sock");
    if (socket !== expectedSocket)
      throw new Error(`docker_socket must resolve to the job-owned profile socket: expected ${expectedSocket}, received ${socket}`);
    process.stdout.write(socket);
  } catch (error) {
    process.stderr.write(`Colima status has no usable docker_socket URI: ${error.message}\n`);
    process.exitCode = 1;
  }
' "$status_json" "$COLIMA_HOME")"
printf 'colima_profile=maister-s52 resolved_host_socket=%s vm_socket=/var/run/docker.sock\n' "$socket_path"
if ! test -S "$socket_path"; then
  printf 'Colima profile maister-s52 is ready but its reported Docker socket is missing: %s\n' "$socket_path" >&2
  exit 1
fi
printf 'colima_profile=maister-s52 guest_dns_file=/etc/resolv.conf\n'
colima --profile maister-s52 ssh -- cat /etc/resolv.conf
printf 'colima_profile=maister-s52 guest_dns_file=/etc/dnsmasq.d/01-colima.conf\n'
colima --profile maister-s52 ssh -- cat /etc/dnsmasq.d/01-colima.conf
export DOCKER_HOST="unix://$socket_path"
printf 'DOCKER_HOST=%s\n' "$DOCKER_HOST" >> "$GITHUB_ENV"
printf '%s\n' 'TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock' >> "$GITHUB_ENV"
docker version
docker info --format '{{json .DriverStatus}}'
