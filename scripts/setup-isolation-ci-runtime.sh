#!/usr/bin/env bash
set -euo pipefail

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
export PATH="$runtime_dir/bin:$PATH"
printf '%s\n' "$runtime_dir/bin" >> "$GITHUB_PATH"
printf 'COLIMA_HOME=%s\n' "$COLIMA_HOME" >> "$GITHUB_ENV"

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
colima --profile maister-s52 start \
  --runtime docker --vm-type vz --mount-type virtiofs \
  --cpu 3 --memory 6 --disk 20
export DOCKER_HOST="unix://$COLIMA_HOME/maister-s52/docker.sock"
test -S "$COLIMA_HOME/maister-s52/docker.sock"
printf 'DOCKER_HOST=%s\n' "$DOCKER_HOST" >> "$GITHUB_ENV"
printf '%s\n' 'TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock' >> "$GITHUB_ENV"
docker version
docker info --format '{{json .DriverStatus}}'
