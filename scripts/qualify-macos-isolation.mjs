import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, release } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const loopback = "127.0.0.1";
const sandbox = "/usr/bin/sandbox-exec";
const sample = "fixture";
const fixtureProgram = `
const { readFileSync } = require("node:fs");
const { createConnection } = require("node:net");

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    return error.code;
  }
}

function connect(port) {
  return new Promise((resolve) => {
    const client = createConnection({ host: "127.0.0.1", port });
    const chunks = [];

    client.on("data", (data) => chunks.push(data));
    client.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    client.once("error", (error) => resolve(error.code));
    client.setTimeout(1_000, () => client.destroy(new Error("fixture timed out")));
  });
}

const [allowed, sibling, ...ports] = process.argv.slice(1);
Promise.all(ports.map((port) => connect(Number(port)))).then((ports) => {
  console.log(JSON.stringify({ files: [read(allowed), read(sibling)], ports }));
});
`;

async function startListener() {
  const listener = createServer((socket) => socket.end(sample));

  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, loopback, resolve);
  });
  const address = listener.address();

  assert(address && typeof address !== "string");
  return { listener, port: address.port };
}

async function runProbe(root, args, profile) {
  const node = await realpath(process.execPath);
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

try {
  const allowed = join(root, "allowed");
  const sibling = join(root, "sibling");
  const node = await realpath(process.execPath);

  for (const path of [allowed, sibling]) {
    await writeFile(path, sample, { mode: 0o600, flag: "wx" });
  }
  listeners.push(await startListener());
  listeners.push(await startListener());
  const [allowedListener, siblingListener] = listeners;
  const outside = await runProbe(root, [
    allowed,
    sibling,
    allowedListener.port,
    siblingListener.port,
  ]);

  assert.deepEqual(outside, {
    files: [sample, sample],
    ports: [sample, sample],
  });
  const profile = `
    (version 1)
    (deny default)
    (allow process-exec (literal ${JSON.stringify(node)}))
    (allow sysctl-read)
    (allow process-info*)
    (allow file-ioctl)
    (allow file-read-metadata)
    (allow file-read* file-test-existence file-map-executable
      (literal "/")
      (literal ${JSON.stringify(node)})
      (subpath "/usr/lib")
      (subpath "/System/Library")
      (literal ${JSON.stringify(allowed)}))
    (allow network-outbound (remote tcp "localhost:${allowedListener.port}"))
  `;
  const inside = await runProbe(
    root,
    [allowed, sibling, allowedListener.port, siblingListener.port],
    profile,
  );

  assert.deepEqual(inside, {
    files: [sample, "EPERM"],
    ports: [sample, "EPERM"],
  });
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      kernel: release(),
      node: process.version,
      file: "authorized-only",
      loopback: "authorized-port-only",
    }),
  );
} finally {
  await Promise.all(
    listeners.map(
      ({ listener }) => new Promise((resolve) => listener.close(resolve)),
    ),
  );
  await rm(root, { recursive: true, force: true });
}
