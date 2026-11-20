import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const loopback = "127.0.0.1";
const sandbox = "/usr/bin/sandbox-exec";
const sample = "fixture";
const descriptorCheck = `
function hasFixtureDescriptor(fd, device, inode) {
  try {
    const stat = require("node:fs").fstatSync(Number(fd), { bigint: true });
    return stat.dev === BigInt(device) && stat.ino === BigInt(inode);
  } catch (error) {
    if (error.code !== "EBADF") throw error;
    return false;
  }
}
`;
const fixtureProgram = String.raw`
${descriptorCheck}
const { execFileSync } = require("node:child_process");
const { readFileSync, renameSync } = require("node:fs");
const { join } = require("node:path");
const { createConnection } = require("node:net");

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    return error.code;
  }
}

function connect(endpoint) {
  return new Promise((resolve) => {
    const client = createConnection(endpoint);
    const chunks = [];

    client.on("data", (data) => chunks.push(data));
    client.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    client.once("error", (error) => resolve(error.code));
    client.setTimeout(1_000, () => client.destroy(new Error("fixture timed out")));
  });
}

function renameAndRestore(source, destination) {
  try {
    renameSync(source, destination);
  } catch (error) {
    return error.code;
  }
  renameSync(destination, source);
  return "ok";
}

function signalSibling(pid) {
  try {
    process.kill(Number(pid), "SIGUSR2");
    return "ok";
  } catch (error) {
    return error.code;
  }
}

const [allowed, sibling, allowedPort, siblingPort, socket, siblingSocket, workspace, inspect, fd, device, inode, pid] = process.argv.slice(1);
const inheritedDescriptor = hasFixtureDescriptor(fd, device, inode);
const endpoints = [
  { host: "127.0.0.1", port: Number(allowedPort) },
  { host: "127.0.0.1", port: Number(siblingPort) },
  { host: "::1", port: Number(allowedPort) },
  { path: socket },
  { path: siblingSocket },
];
Promise.all(endpoints.map(connect)).then(([ipv4, siblingPort, ipv6, allowedIpc, siblingIpc]) => {
  const descendant = execFileSync(process.execPath, [
    "-e",
    'try { process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8")); } catch (error) { process.stdout.write(error.code); }',
    sibling,
  ], { timeout: 2_000, encoding: "utf8" });

  console.log(JSON.stringify({
    files: [read(allowed), read(sibling)],
    ports: [ipv4, siblingPort, ipv6],
    ipc: [allowedIpc, siblingIpc],
    descendant,
    inheritedDescriptor,
    processInfo: execFileSync(inspect, [pid], {
      timeout: 2_000, encoding: "utf8",
    }).trim(),
    rename: [
      renameAndRestore(join(workspace, "edit"), join(workspace, "edited")),
      renameAndRestore(workspace, workspace + "-moved"),
      renameAndRestore(sibling, sibling + "-moved"),
    ],
    signal: signalSibling(pid),
  }));
});
`;

async function startListener(options) {
  const listener = createServer((socket) => socket.end(sample));

  listener.listen(options);
  await once(listener, "listening");
  return listener;
}

function tcpPort(listener) {
  const address = listener.address();

  assert(address && typeof address !== "string");
  return address.port;
}

async function checkDescriptorControl(node, root, descriptor, stat) {
  const explicit = spawn(
    node,
    [
      "-e",
      descriptorCheck +
        'require("node:assert/strict")(hasFixtureDescriptor(...process.argv.slice(1)));',
      "3",
      String(stat.dev),
      String(stat.ino),
    ],
    {
      cwd: root,
      env: { HOME: root, PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["ignore", "ignore", "inherit", descriptor.fd],
      timeout: 5_000,
    },
  );

  assert.deepEqual(await once(explicit, "close"), [0, null]);
}

async function withSibling(node, root, probe) {
  const sibling = spawn(
    node,
    [
      "-e",
      'process.once("SIGUSR2", () => process.exit(0)); process.stdout.write("ready"); process.stdin.resume();',
    ],
    {
      cwd: root,
      env: { HOME: root, PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "inherit"],
      timeout: 10_000,
    },
  );
  const exited = once(sibling, "close");

  try {
    await Promise.race([
      once(sibling.stdout, "data", { signal: AbortSignal.timeout(5_000) }),
      exited.then(() => {
        throw new Error("Sibling fixture exited before readiness");
      }),
    ]);
    assert(sibling.pid);
    return await probe(sibling.pid, exited);
  } finally {
    sibling.stdin.end();
    await exited;
  }
}

async function runProbe(node, root, args, profile) {
  const command =
    profile === undefined
      ? [node, "-e", fixtureProgram, ...args]
      : [sandbox, "-p", profile, node, "-e", fixtureProgram, ...args];
  const [program, ...argv] = command;
  const result = await execute(program, argv, {
    cwd: root,
    env: { HOME: root, PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 5_000,
  });

  return JSON.parse(result.stdout);
}

assert.equal(process.platform, "darwin", "Use a native macOS host");
const root = await realpath(await mkdtemp(join(tmpdir(), "maister-seatbelt-")));
const listeners = [];
let descriptor;

try {
  const allowed = join(root, "allowed");
  const sibling = join(root, "sibling");
  const node = await realpath(process.execPath);
  const workspace = join(root, "workspace");
  const socket = join(root, "s.sock");
  const siblingSocket = join(root, "t.sock");
  const inspect = join(root, "inspect-process");

  await execute(
    "/usr/bin/xcrun",
    [
      "clang",
      "-Wall",
      "-Wextra",
      "-Werror",
      fileURLToPath(new URL("qualify-macos-process.c", import.meta.url)),
      "-o",
      inspect,
    ],
    { timeout: 20_000 },
  );

  await mkdir(workspace, { mode: 0o700 });
  for (const path of [allowed, sibling, join(workspace, "edit")]) {
    await writeFile(path, sample, { mode: 0o600, flag: "wx" });
  }
  descriptor = await open(sibling, "r");
  const stat = await descriptor.stat({ bigint: true });
  await checkDescriptorControl(node, root, descriptor, stat);

  listeners.push(await startListener({ host: loopback, port: 0 }));
  listeners.push(await startListener({ host: loopback, port: 0 }));
  const [allowedListener, siblingListener] = listeners;
  const allowedPort = tcpPort(allowedListener);

  listeners.push(
    await startListener({ host: "::1", port: allowedPort, ipv6Only: true }),
  );
  listeners.push(await startListener({ path: socket }));
  listeners.push(await startListener({ path: siblingSocket }));
  const args = [
    allowed,
    sibling,
    allowedPort,
    tcpPort(siblingListener),
    socket,
    siblingSocket,
    workspace,
    inspect,
    descriptor.fd,
    String(stat.dev),
    String(stat.ino),
  ];
  const outside = await withSibling(node, root, async (pid, exited) => {
    const result = await runProbe(node, root, [...args, pid]);

    assert.equal(result.signal, "ok");
    assert.deepEqual(await exited, [0, null]);
    return result;
  });

  assert.deepEqual(outside, {
    files: [sample, sample],
    ports: [sample, sample, sample],
    ipc: [sample, sample],
    descendant: sample,
    inheritedDescriptor: false,
    processInfo: "ok",
    rename: ["ok", "ok", "ok"],
    signal: "ok",
  });
  const profile = `
    (version 1)
    (deny default)
    (deny process-info*)
    (allow process-fork)
    (allow process-exec
      (literal ${JSON.stringify(node)})
      (literal ${JSON.stringify(inspect)}))
    (allow sysctl-read)
    (allow file-ioctl)
    (allow file-read-metadata)
    (allow file-read* file-test-existence file-map-executable
      (literal "/")
      (literal ${JSON.stringify(node)})
      (literal ${JSON.stringify(inspect)})
      (subpath "/usr/lib")
      (subpath "/System/Library")
      (literal ${JSON.stringify(allowed)}))
    (allow file-write*
      (require-all
        (subpath ${JSON.stringify(workspace)})
        (require-not (literal ${JSON.stringify(workspace)}))))
    (allow network-outbound
      (remote unix-socket (path-literal ${JSON.stringify(socket)})))
  `;
  const runConfined = (policy) =>
    withSibling(node, root, (pid) =>
      runProbe(node, root, [...args, pid], policy),
    );
  const inside = await runConfined(profile);

  assert.deepEqual(inside, {
    files: [sample, "EPERM"],
    ports: ["EPERM", "EPERM", "EPERM"],
    ipc: [sample, "EPERM"],
    descendant: "EPERM",
    inheritedDescriptor: false,
    processInfo: "EPERM",
    rename: ["ok", "EPERM", "EPERM"],
    signal: "EPERM",
  });
  const loopbackProfile =
    profile +
    `
    (allow network-outbound (remote tcp "localhost:${allowedPort}"))
  `;
  const withLoopback = await runConfined(loopbackProfile);

  // This rule grants the port in both address families on the qualified build.
  assert.deepEqual(withLoopback, {
    ...inside,
    ports: [sample, "EPERM", sample],
  });
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      kernel: release(),
      node: process.version,
      file: "authorized-only",
      loopback: "same-port-both-address-families",
      unixSocket: "exact-path-with-tcp-denied",
      descendant: "filesystem-policy-inherited",
      descriptor: "unmapped-closed",
      siblingProcessInfo: "denied",
      siblingSignal: "denied",
      rename: "workspace-content-only",
    }),
  );
} finally {
  await descriptor?.close();
  await Promise.all(
    listeners.map(
      (listener) => new Promise((resolve) => listener.close(resolve)),
    ),
  );
  await rm(root, { recursive: true, force: true });
}
