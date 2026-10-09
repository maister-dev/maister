import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import YAML from "yaml";

const workflowPath = fileURLToPath(
  new URL("../.github/workflows/ci.yml", import.meta.url),
);
const workflow = YAML.parse(readFileSync(workflowPath, "utf8"));
const setupPath = fileURLToPath(
  new URL("./setup-isolation-ci-runtime.sh", import.meta.url),
);
const cleanup = workflow.jobs["execution-isolation"].steps.find(
  (step) => step.name === "Stop the job-owned container runtime",
);

assert(cleanup, "isolation workflow must retain its cleanup step");

test("isolation compile cache proves real inherited compilation before publishing a fresh private path and refuses disabled or missing capabilities", (context) => {
  const steps = workflow.jobs["execution-isolation"].steps;
  const index = steps.findIndex(
    (step) => step.name === "Prepare private Node compile cache",
  );
  const cacheSetup = fileURLToPath(
    new URL("./setup-isolation-ci-compile-cache.mjs", import.meta.url),
  );
  const runtimeModule = new URL("../runtime/node-version.ts", import.meta.url)
    .href;
  const root = mkdtempSync(join(tmpdir(), "maister-ci-cache-"));
  const runnerTemp = join(root, "job-temp");
  const linkedTemp = join(root, "linked-temp");
  const githubEnv = join(root, "github.env");
  const evidence = join(runnerTemp, "maister-isolation-evidence");
  const baseEnv = {
    ...process.env,
    RUNNER_TEMP: linkedTemp,
    GITHUB_ENV: githubEnv,
    NODE_COMPILE_CACHE: join(root, "foreign-cache"),
    MAISTER_TEST_EVIDENCE_DIR: evidence,
  };

  delete baseEnv.NODE_DISABLE_COMPILE_CACHE;
  function run(env) {
    const result = spawnSync(process.execPath, [cacheSetup], {
      encoding: "utf8",
      timeout: 15_000,
      env,
    });

    assert.ifError(result.error);

    return result;
  }
  function persistedFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const item = join(directory, entry.name);

      return entry.isDirectory() ? persistedFiles(item) : [item];
    });
  }

  try {
    assert(index > 0);
    assert.equal(
      steps[index].run,
      "node scripts/setup-isolation-ci-compile-cache.mjs",
    );
    assert.equal(steps[index - 1].run, "pnpm runtime:check");
    assert.equal(
      steps[index + 1].name,
      "Provision pinned isolated container runtime",
    );
    mkdirSync(runnerTemp);
    mkdirSync(evidence);
    symlinkSync(runnerTemp, linkedTemp);
    const ready = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      writeFileSync(githubEnv, "");
      const result = run(baseEnv);

      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);

      assert.equal(receipt.event, "isolation-node-compile-cache-ready");
      assert.equal(receipt.node, process.versions.node);
      assert.equal(receipt.cacheStatus, "ALREADY_ENABLED");
      assert.equal(receipt.runtimeModule, runtimeModule);
      assert.equal(dirname(receipt.cacheRoot), realpathSync(runnerTemp));
      assert.equal(realpathSync(receipt.cacheRoot), receipt.cacheRoot);
      assert.equal(statSync(receipt.cacheRoot).mode & 0o777, 0o700);
      assert(receipt.cacheDirectory.startsWith(`${receipt.cacheRoot}/`));
      assert(!receipt.cacheRoot.startsWith(`${realpathSync(evidence)}/`));
      const files = persistedFiles(receipt.cacheDirectory);

      assert(files.length > 0);
      assert.equal(receipt.cacheFiles, files.length);
      assert.equal(
        receipt.cacheBytes,
        files.reduce((total, file) => total + statSync(file).size, 0),
      );
      assert(receipt.cacheBytes > 0);
      assert.equal(
        readFileSync(githubEnv, "utf8"),
        `NODE_COMPILE_CACHE=${receipt.cacheRoot}\n`,
      );
      ready.push(receipt);
    }
    assert.notEqual(ready[0].cacheRoot, ready[1].cacheRoot);
    const refusals = [];
    const unpublished = "OWNER_ENTRY=untouched\n";

    for (const disabled of ["1", "0"]) {
      writeFileSync(githubEnv, unpublished);
      const result = run({ ...baseEnv, NODE_DISABLE_COMPILE_CACHE: disabled });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /compile cache witness failed/u);
      assert.match(
        result.stderr,
        /initial compile cache directory is unavailable/u,
      );
      assert.equal(readFileSync(githubEnv, "utf8"), unpublished);
      refusals.push({ disabled, status: result.status, stderr: result.stderr });
    }
    for (const missing of ["RUNNER_TEMP", "GITHUB_ENV"]) {
      writeFileSync(githubEnv, unpublished);
      const env = { ...baseEnv };

      delete env[missing];
      const result = run(env);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`${missing} is required`, "u"));
      assert.equal(readFileSync(githubEnv, "utf8"), unpublished);
    }
    for (const key of ["RUNNER_TEMP", "GITHUB_ENV"]) {
      writeFileSync(githubEnv, unpublished);
      const result = run({
        ...baseEnv,
        [key]: `${baseEnv[key]}\nforeign-export`,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must not contain CR or LF/u);
      assert.equal(readFileSync(githubEnv, "utf8"), unpublished);
    }
    context.diagnostic(
      JSON.stringify({
        event: "compile-cache-real-control",
        node: process.versions.node,
        ready,
        refusals,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function installCommand(binDir, name, body) {
  const path = join(binDir, name);

  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

async function runSetup(reportedSocket, maxSocketBytes) {
  // The owning Unix socket fixture must fit Lima's path bound on both Darwin
  // and Linux; RUNNER_TEMP is padded below to exercise its exact byte limit.
  const root = mkdtempSync("/tmp/ci-");
  const shortestSocket = join(
    realpathSync(root),
    "maister-isolation-runtime",
    "lima",
    "colima-maister-s52",
    "ssh.sock.1234567890123456",
  );
  const paddingBytes = maxSocketBytes - Buffer.byteLength(shortestSocket) - 1;

  assert(paddingBytes >= 3, "fixture root must fit the Lima socket boundary");
  const runnerTemp = join(root, `界${"p".repeat(paddingBytes - 3)}`);
  const binDir = join(root, "commands");
  const eventsPath = join(root, "events.jsonl");
  const sourceSocket = join(root, "fixture.sock");
  const githubEnv = join(root, "github.env");
  const colimaFixture = join(root, "colima-fixture");
  const server = createServer();

  try {
    mkdirSync(binDir);
    mkdirSync(runnerTemp);
    writeFileSync(githubEnv, "");
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sourceSocket, resolve);
    });
    installCommand(
      binDir,
      "uname",
      '#!/bin/sh\ncase "$1" in -s) printf "Darwin\\n";; -m) printf "x86_64\\n";; *) exit 1;; esac\n',
    );
    installCommand(
      binDir,
      "curl",
      '#!/bin/sh\nprintf \'{"command":"curl"}\\n\' >> "$EVENTS_PATH"\nwhile test "$#" -gt 0; do if test "$1" = --output; then cp "$COLIMA_FIXTURE" "$2"; exit; fi; shift; done\nexit 1\n',
    );
    installCommand(binDir, "shasum", "#!/bin/sh\ncat >/dev/null\n");
    for (const name of ["tar", "brew", "limactl", "gtimeout"]) {
      installCommand(binDir, name, "#!/bin/sh\nexit 0\n");
    }
    // These commands model the pinned CLI's home-selection contract. The real
    // setup shell, Node URI/path validation and Unix socket checks still run.
    writeFileSync(
      colimaFixture,
      `#!${process.execPath}\n` +
        String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const home = process.env.COLIMA_HOME;
appendFileSync(process.env.EVENTS_PATH, JSON.stringify({ command: "colima", args, home, homeExists: existsSync(home), limaHome: process.env.LIMA_HOME }) + "\n");
if (args.includes("start")) {
  const longestSocket = join(realpathSync(process.env.LIMA_HOME), "colima-maister-s52", "ssh.sock.1234567890123456");
  if (Buffer.byteLength(longestSocket) >= 104) throw new Error("Pinned Lima rejects an overlong SSH socket: " + longestSocket);
  const selectedHome = existsSync(home) ? home : process.env.FIXTURE_DEFAULT_HOME;
  mkdirSync(selectedHome, { recursive: true });
  const profileDir = join(selectedHome, "maister-s52");
  const foreignDir = join(process.env.RUNNER_TEMP, "foreign");
  const owned = process.env.REPORTED_SOCKET === "owned";
  const linked = process.env.REPORTED_SOCKET === "linked-foreign";
  const socket = join(owned ? profileDir : foreignDir, "docker.sock");
  mkdirSync(dirname(socket), { recursive: true });
  renameSync(process.env.SOURCE_SOCKET, socket);
  if (linked) symlinkSync(foreignDir, profileDir);
  writeFileSync(process.env.STATUS_SOCKET, linked ? join(profileDir, "docker.sock") : socket);
} else if (args.includes("status")) {
  process.stdout.write(JSON.stringify({ docker_socket: "unix://" + readFileSync(process.env.STATUS_SOCKET, "utf8") }));
} else if (args.includes("ssh")) {
  process.stdout.write(args.at(-1) === "/etc/resolv.conf" ? "nameserver 192.168.5.1\n" : "server=1.1.1.1\n");
} else if (!args.includes("version")) {
  throw new Error("Unexpected Colima command: " + JSON.stringify(args));
}
`,
    );
    installCommand(
      binDir,
      "docker",
      `#!${process.execPath}\n` +
        String.raw`
import { appendFileSync } from "node:fs";
appendFileSync(process.env.EVENTS_PATH, JSON.stringify({ command: "docker", args: process.argv.slice(2), host: process.env.DOCKER_HOST }) + "\n");
`,
    );
    const result = spawnSync("bash", [setupPath], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        FIXTURE_DEFAULT_HOME: join(root, "fixture-home", ".colima"),
        PATH: `${binDir}:${dirname(process.execPath)}:${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        GITHUB_ENV: githubEnv,
        GITHUB_PATH: join(root, "github.path"),
        LIMA_HOME: join(root, "foreign-lima"),
        EVENTS_PATH: eventsPath,
        COLIMA_FIXTURE: colimaFixture,
        SOURCE_SOCKET: sourceSocket,
        STATUS_SOCKET: join(root, "status.socket"),
        REPORTED_SOCKET: reportedSocket,
      },
    });

    assert.ifError(result.error);

    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      home: join(runnerTemp, "maister-isolation-runtime", "colima"),
      limaHome: join(runnerTemp, "maister-isolation-runtime", "lima"),
      ownedSocket: join(
        realpathSync(runnerTemp),
        "maister-isolation-runtime",
        "colima",
        "maister-s52",
        "docker.sock",
      ),
      events: existsSync(eventsPath)
        ? readFileSync(eventsPath, "utf8").trim().split("\n").map(JSON.parse)
        : [],
      githubEnv: readFileSync(githubEnv, "utf8"),
    };
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("isolation setup creates its job home before Colima and declares the guest DNS boundary", async () => {
  const result = await runSetup("owned", 103);
  const colima = result.events.filter((event) => event.command === "colima");
  const start = colima.filter((event) => event.args.includes("start"));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(colima[0].homeExists, true);
  assert.equal(colima[0].home, result.home);
  assert.equal(colima[0].limaHome, result.limaHome);
  assert.equal(start.length, 1);
  assert.deepEqual(start[0].args, [
    "--profile",
    "maister-s52",
    "start",
    "--runtime",
    "docker",
    "--vm-type",
    "vz",
    "--mount-type",
    "virtiofs",
    "--cpu",
    "3",
    "--memory",
    "6",
    "--disk",
    "20",
    "--dns",
    "1.1.1.1",
  ]);
  assert.deepEqual(
    colima
      .filter((event) => event.args.includes("ssh"))
      .map((event) => event.args),
    [
      ["--profile", "maister-s52", "ssh", "--", "cat", "/etc/resolv.conf"],
      [
        "--profile",
        "maister-s52",
        "ssh",
        "--",
        "cat",
        "/etc/dnsmasq.d/01-colima.conf",
      ],
    ],
  );
  assert.match(result.stdout, /nameserver 192\.168\.5\.1/u);
  assert.match(result.stdout, /server=1\.1\.1\.1/u);
  assert(
    result.githubEnv.includes(`DOCKER_HOST=unix://${result.ownedSocket}\n`),
  );
  assert(result.githubEnv.includes(`LIMA_HOME=${result.limaHome}\n`));
  assert(
    result.events
      .filter(
        (event) => event.command === "docker" && event.args[0] !== "--version",
      )
      .every((event) => event.host === `unix://${result.ownedSocket}`),
  );
  assert.deepEqual(
    result.events
      .filter((event) => event.command === "docker")
      .map((event) => event.args),
    [
      ["--version"],
      ["version"],
      ["info", "--format", "{{json .DriverStatus}}"],
    ],
  );
});

test("isolation setup refuses foreign Docker sockets before daemon contact or export", async (context) => {
  for (const socket of ["foreign", "linked-foreign"]) {
    await context.test(socket, async () => {
      const result = await runSetup(socket, 103);

      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /docker_socket must resolve to the job-owned profile socket/u,
      );
      assert.doesNotMatch(
        result.githubEnv,
        /DOCKER_HOST=|TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/u,
      );
      assert.deepEqual(
        result.events
          .filter((event) => event.command === "docker")
          .map((event) => event.args),
        [["--version"]],
      );
    });
  }
});

test("isolation setup rejects Lima's 104-byte socket path before downloading or contacting a runtime", async () => {
  const result = await runSetup("owned", 104);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Lima 2\.2\.0 SSH socket path must be shorter than 104 bytes: received 104 bytes/u,
  );
  assert.deepEqual(result.events, []);
  assert.equal(result.githubEnv, "");
});

function runCleanup({ timingWritable, deleteStatus }) {
  const root = mkdtempSync(join(tmpdir(), "maister-ci-cleanup-"));
  const evidenceDir = join(root, "evidence");
  const runtimeDir = join(root, "maister-isolation-runtime");
  const binDir = join(runtimeDir, "bin");
  const deleteLog = join(root, "delete.log");

  try {
    mkdirSync(evidenceDir);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(runtimeDir, "maister-s52.start-attempted"), "1\n");
    const colima = join(binDir, "colima");

    writeFileSync(
      colima,
      '#!/bin/sh\nprintf \'deleted\\n\' >> "$DELETE_LOG"\nexit "$DELETE_STATUS"\n',
    );
    chmodSync(colima, 0o755);
    if (!timingWritable) mkdirSync(join(evidenceDir, "timing.txt"));
    const script = cleanup.run.replaceAll(
      "${{ steps.isolation_reports.outcome }}",
      "success",
    );
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        MAISTER_TEST_EVIDENCE_DIR: evidenceDir,
        S52_JOB_STARTED_AT: String(Math.floor(Date.now() / 1000)),
        DELETE_LOG: deleteLog,
        DELETE_STATUS: String(deleteStatus),
      },
    });

    return {
      status: result.status,
      stderr: result.stderr,
      deleted: existsSync(deleteLog) ? readFileSync(deleteLog, "utf8") : null,
      timing: timingWritable
        ? readFileSync(join(evidenceDir, "timing.txt"), "utf8")
        : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("isolation cleanup deletes the owned profile even when timing cannot be written", () => {
  const result = runCleanup({ timingWritable: false, deleteStatus: 0 });

  assert.equal(result.deleted, "deleted\n");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Failed to record container runtime cleanup outcome/u,
  );
});

test("isolation cleanup preserves a Colima deletion failure in its timing and exit code", () => {
  const result = runCleanup({ timingWritable: true, deleteStatus: 42 });

  assert.equal(result.deleted, "deleted\n");
  assert.equal(result.status, 42);
  assert.match(result.timing, /reports_upload_outcome=success/u);
  assert.match(result.timing, /runtime_cleanup_exit_code=42/u);
});
