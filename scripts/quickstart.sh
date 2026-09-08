#!/usr/bin/env bash
#
# MAIster quickstart: from an empty directory to a migrated local install.
#
#   curl -fsSL https://imaister.dev/quickstart.sh | bash
#
# or, inside a checkout:
#
#   ./scripts/quickstart.sh
#
# Steps, in order (every one is safe to repeat):
#   1. preflight: git, Node >=24.15.0 <25 (the qualified runtime), pnpm >= 10,
#      Docker Compose v2
#   2. clone https://github.com/maister-dev/maister into ./maister
#      (skipped when the current directory already is a checkout)
#   3. pnpm install --frozen-lockfile for the three runtime workspaces
#      (web, supervisor, mcp; the Claude and Codex ACP adapters come with
#      the supervisor). The site and docs workspaces are not needed to run
#      MAIster and pull in a headless Chrome download, so they are skipped.
#   4. create .env, web/.env.local and supervisor/.env from their templates
#      and generate AUTH_SECRET; existing files are left untouched
#   5. start Postgres (pgvector) with Docker Compose and wait until healthy
#   6. apply both migration lineages and verify nothing is pending
#   7. build the MCP facade bundle that platform agents talk to
#   8. print what is left to do by hand: pnpm dev, sign-in, ACP runner, project
#
# Environment knobs:
#   MAISTER_DIR   clone target (default: ./maister)
#   MAISTER_REPO  git URL to clone (default: https://github.com/maister-dev/maister.git)
#   MAISTER_REF   branch or tag to check out (default: master)
#   DB_URL        use this pgvector-enabled Postgres and skip Docker entirely
#
# Only Postgres runs in Docker. The web tier and the supervisor run on this
# host because they spawn coding-agent CLIs and operate on local git repos.
# Linux and macOS only: Flows run CLI steps through bash, package installs
# create symlinks, and the supervisor parses colon-separated roots. On Windows
# run this inside WSL2 (Ubuntu) with Docker Desktop's WSL integration.
# Everything lives in functions and `main` is the last line, so a download that
# is cut short executes nothing.

# -E: functions inherit the ERR trap below.
set -Eeuo pipefail

MAISTER_REPO="${MAISTER_REPO:-https://github.com/maister-dev/maister.git}"
MAISTER_REF="${MAISTER_REF:-master}"
MAISTER_DIR="${MAISTER_DIR:-maister}"
# Mirrors ARG PNPM_VERSION in the root Dockerfile.
PNPM_VERSION="11.3.0"
# Mirrors SUPPORTED_NODE_RANGE in runtime/node-version.ts and the engines field
# of the application manifests; scripts/runtime-contract.test.mjs keeps them in sync.
NODE_RANGE=">=24.15.0 <25"
POSTGRES_PORT=5432
REPO_DIR=""

if [ -t 1 ]; then
  BOLD=$'\033[1m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RED=$'\033[31m' RESET=$'\033[0m'
else
  BOLD="" GREEN="" YELLOW="" RED="" RESET=""
fi

step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '%s  ok%s  %s\n' "$GREEN" "$RESET" "$*"; }
skip() { printf '  --  %s\n' "$*"; }
warn() { printf '%s  !!%s  %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%s  xx%s  %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

trap 'printf "\n%s  quickstart stopped.%s Fix the error above and run it again; every step is safe to repeat.\n" "$RED" "$RESET" >&2' ERR

check_platform() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      die "MAIster runs on Linux and macOS. On Windows, install WSL2 (Ubuntu), enable Docker Desktop's WSL integration, and run this same command inside the WSL shell."
      ;;
  esac
  ok "$(uname -s) $(uname -m)"
}

check_git() {
  have git || die "git is required: https://git-scm.com/downloads"
  ok "git $(git --version | awk '{ print $3 }')"
}

check_node() {
  have node || die "Node.js ${NODE_RANGE} is required (24.19.0 is the qualified current patch): https://nodejs.org"
  # Same predicate as assertSupportedNode() in runtime/node-version.ts: only
  # Node 24 from 24.15.0 is qualified and the web/supervisor boot guards refuse
  # every other major, so fail here before installing anything.
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major === 24 && minor >= 15 ? 0 : 1);
  ' || die "Node $(node --version) is outside the supported range ${NODE_RANGE}; install Node 24 (e.g. nvm install 24.19.0) and run this again"
  ok "node $(node --version)"
}

check_pnpm() {
  if ! have pnpm; then
    have corepack || die "pnpm is required: npm install -g pnpm@${PNPM_VERSION}  (https://pnpm.io/installation)"
    warn "pnpm is not installed; enabling pnpm@${PNPM_VERSION} through corepack"
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack enable pnpm \
      && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare "pnpm@${PNPM_VERSION}" --activate \
      || die "corepack could not enable pnpm; install it with: npm install -g pnpm@${PNPM_VERSION}"
    hash -r
    have pnpm || die "pnpm is still not on PATH; open a new shell or run: npm install -g pnpm@${PNPM_VERSION}"
  fi
  local version major
  version="$(pnpm --version)"
  major="${version%%.*}"
  [ "$major" -ge 10 ] || die "pnpm ${version} is too old: 10+ is required (npm install -g pnpm@${PNPM_VERSION})"
  ok "pnpm ${version}"
}

check_docker() {
  if [ -n "${DB_URL:-}" ]; then
    skip "DB_URL is set; Docker is not needed (that Postgres must have the pgvector extension available)"
    return
  fi
  have docker || die "Docker is required for the bundled Postgres: https://docs.docker.com/get-docker/  (or export DB_URL to use a pgvector-enabled Postgres you already run)"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' subcommand)"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running; start Docker and run this again"
  ok "docker $(docker version --format '{{.Server.Version}}'), compose $(docker compose version --short)"
}

is_checkout() {
  [ -f "$1/pnpm-workspace.yaml" ] && [ -f "$1/web/package.json" ] && [ -f "$1/supervisor/package.json" ]
}

locate_checkout() {
  local script_path="${BASH_SOURCE[0]:-}" script_root=""
  if [ -n "$script_path" ] && [ -f "$script_path" ]; then
    script_root="$(cd "$(dirname "$script_path")/.." && pwd)"
  fi

  if is_checkout "$PWD"; then
    REPO_DIR="$PWD"
    ok "using the checkout in ${REPO_DIR}"
  elif [ -n "$script_root" ] && is_checkout "$script_root"; then
    REPO_DIR="$script_root"
    ok "using the checkout in ${REPO_DIR}"
  elif [ -e "$MAISTER_DIR" ]; then
    is_checkout "$MAISTER_DIR" || die "${MAISTER_DIR} exists but is not a MAIster checkout; set MAISTER_DIR to another path"
    REPO_DIR="$(cd "$MAISTER_DIR" && pwd)"
    ok "using the checkout in ${REPO_DIR}"
  else
    git clone --branch "$MAISTER_REF" "$MAISTER_REPO" "$MAISTER_DIR"
    REPO_DIR="$(cd "$MAISTER_DIR" && pwd)"
    ok "cloned ${MAISTER_REPO} (${MAISTER_REF}) into ${REPO_DIR}"
  fi
}

# env_value FILE KEY -> the first `KEY=value` line's value, or nothing
env_value() {
  sed -n "s/^$2=//p" "$1" | head -n 1
}

# set_env_value FILE KEY VALUE -> replaces the `KEY=` line, appends when absent
set_env_value() {
  node -e '
    const fs = require("node:fs");
    const [file, key, value] = process.argv.slice(1);
    const source = fs.readFileSync(file, "utf8");
    const pattern = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    const separator = source === "" || source.endsWith("\n") ? "" : "\n";
    const next = pattern.test(source)
      ? source.replace(pattern, () => line)
      : `${source}${separator}${line}\n`;
    fs.writeFileSync(file, next);
  ' "$1" "$2" "$3"
}

copy_template() {
  if [ -f "$2" ]; then
    skip "$2 exists; leaving it as is"
  else
    cp "$1" "$2"
    ok "created $2 from $1"
  fi
}

prepare_env() {
  copy_template .env.example .env
  copy_template web/.env.sample web/.env.local
  copy_template supervisor/.env.sample supervisor/.env

  if [ -z "$(env_value web/.env.local AUTH_SECRET)" ]; then
    set_env_value web/.env.local AUTH_SECRET \
      "$(node -e 'console.log(require("node:crypto").randomBytes(33).toString("base64"))')"
    ok "generated AUTH_SECRET in web/.env.local"
  fi

  if [ -n "${DB_URL:-}" ]; then
    set_env_value web/.env.local DB_URL "$DB_URL"
    ok "wrote DB_URL to web/.env.local"
  fi
}

# bash opens TCP sockets itself, so this needs no nc/lsof; refused == free
port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

start_postgres() {
  if [ -n "${DB_URL:-}" ]; then
    skip "using the Postgres from DB_URL"
    return
  fi
  if [ -z "$(docker compose ps -q postgres 2>/dev/null)" ] && port_in_use "$POSTGRES_PORT"; then
    die "port ${POSTGRES_PORT} is already taken on this host; stop that Postgres, or export DB_URL to use it (it needs pgvector) and run this again"
  fi
  docker compose up -d --wait postgres
  ok "postgres is healthy on 127.0.0.1:${POSTGRES_PORT} (compose service 'postgres', named volume postgres_data)"
}

migrate() {
  pnpm --filter maister-web db:migrate
  pnpm --filter maister-web db:migrate:brain
  pnpm --filter maister-web db:check
  ok "schema is current (main + brain lineages)"
}

build_mcp() {
  pnpm --filter @maister/mcp build
  ok "mcp/dist/main.js is ready"
}

report_agents() {
  local agent found=0
  for agent in claude codex gemini opencode mimo; do
    if have "$agent"; then
      ok "${agent}: $(command -v "$agent")"
      found=1
    else
      skip "${agent}: not on PATH"
    fi
  done
  if [ -x supervisor/node_modules/.bin/claude-agent-acp ]; then
    ok "claude-agent-acp adapter installed by pnpm"
  fi
  if [ -x supervisor/node_modules/.bin/codex-acp ]; then
    ok "codex-acp adapter installed by pnpm"
  fi
  if [ "$found" -eq 0 ]; then
    warn "no coding-agent CLI is on PATH; a Flow cannot start until an agent is signed in on this host (step 3 below)"
  fi
}

print_next_steps() {
  printf '\n%sMAIster is installed in %s%s\n' "$BOLD" "$REPO_DIR" "$RESET"
  cat <<EOF

  1. Start both host processes (supervisor on :7777, web on :3000):

       cd ${REPO_DIR}
       pnpm dev

  2. Sign in at http://localhost:3000/login
       email:     admin@maister.local
       password:  maister-admin        (you will be asked to change it)

  3. Sign a coding agent in under this OS account, if you have not yet:
       Codex:                          pnpm --filter @maister/supervisor exec codex-acp login
       Claude Code / Gemini / others:  the agent's own login command
     or put provider keys into supervisor/.env (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).

  4. In the app: Settings -> ACP runners. On a fresh install the first visit registers
     a native runner per adapter found on this host (e.g. claude-code); wait for Ready.
  5. Projects -> Add project -> absolute path of a git repository on this host.
  6. Create a task on the project board and launch it.

  Full guide: https://docs.imaister.dev/quickstart
EOF
}

main() {
  step "Checking prerequisites"
  check_platform
  check_git
  check_node
  check_pnpm
  check_docker

  step "Locating MAIster"
  locate_checkout
  cd "$REPO_DIR"

  step "Installing dependencies (web, supervisor, mcp)"
  pnpm install --frozen-lockfile \
    --filter maister-web --filter @maister/supervisor --filter @maister/mcp

  step "Preparing environment files"
  prepare_env

  step "Starting Postgres"
  start_postgres

  step "Applying database migrations"
  migrate

  step "Building the MCP facade"
  build_mcp

  step "Coding agents on this host"
  report_agents

  print_next_steps
}

main "$@"
