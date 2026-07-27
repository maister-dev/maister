import "server-only";

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import { atomicWriteText } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";
import { agentMemoryMaxChars } from "@/lib/instance-config";
import { runtimeRoot } from "@/lib/runtime-root";

const log = pino({
  name: "agent-memory-store",
  level: process.env.LOG_LEVEL ?? "info",
});

const MEMORY_FILE = "memory.md";
const SAFE_COMPONENT_BYTE = /^[A-Za-z0-9._-]$/;

// ADR-152 D10. Keeps `[A-Za-z0-9._-]` verbatim and rewrites every other BYTE as
// `%XX` uppercase. Because an encoded component can never itself contain `/` or
// `:`, the (packageName, stem) -> path map is INJECTIVE — two distinct ids
// cannot land on one file. That is strictly stronger than the
// collision-RESISTANCE a truncated-hash suffix would buy. Encoding bytes rather
// than code points keeps the map total over non-ASCII ids.
function enc(component: string): string {
  let out = "";

  for (const byte of Buffer.from(component, "utf8")) {
    const char = String.fromCharCode(byte);

    out += SAFE_COMPONENT_BYTE.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  return out;
}

// `.` and `..` survive the encoder verbatim (both are made of safe bytes) and
// would resolve to the current/parent directory, so they are refused rather
// than encoded — the one case where a safe-looking component is not safe.
function assertUsableComponent(component: string, agentId: string): string {
  const encoded = enc(component);

  if (encoded.length === 0 || encoded === "." || encoded === "..") {
    throw new MaisterError(
      "CONFIG",
      `agent memory: agent "${agentId}" has an unusable path component "${component}"`,
    );
  }

  return encoded;
}

export function agentMemoryPath(projectSlug: string, agentId: string): string {
  const separator = agentId.indexOf(":");

  // A bare stem must NOT fall back to a single level: two agents from different
  // packages share a stem, so the fallback would silently merge their memories.
  if (separator <= 0) {
    throw new MaisterError(
      "CONFIG",
      `agent memory: "${agentId}" is not a qualified <packageName>:<stem> id`,
    );
  }

  const packageName = assertUsableComponent(
    agentId.slice(0, separator),
    agentId,
  );
  const stem = assertUsableComponent(agentId.slice(separator + 1), agentId);

  return path.join(
    runtimeRoot(),
    ".maister",
    projectSlug,
    "agents",
    packageName,
    stem,
    MEMORY_FILE,
  );
}

export function hashAgentMemory(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function readAgentMemory(
  projectSlug: string,
  agentId: string,
): Promise<{ content: string; hash: string; sizeChars: number } | null> {
  const filePath = agentMemoryPath(projectSlug, agentId);
  let content: string;

  try {
    // A directory (or any non-regular entry) in the file's place must degrade,
    // not throw EISDIR into a launch.
    const stats = await stat(filePath);

    if (!stats.isFile()) {
      log.warn(
        { agentId, projectSlug, reason: "unreadable" },
        "[agents.memory] memory path is not a regular file",
      );

      return null;
    }

    content = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code;

    // Absent is the normal first-run state and stays quiet; anything else is a
    // broken read and MUST be distinguishable from a healthy empty one.
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      log.warn(
        { agentId, code, projectSlug, reason: "unreadable" },
        "[agents.memory] memory file could not be read",
      );
    }

    return null;
  }

  const max = agentMemoryMaxChars();

  if (content.length > max) {
    log.warn(
      {
        agentId,
        max,
        projectSlug,
        reason: "over_cap",
        sizeChars: content.length,
      },
      "[agents.memory] memory file exceeds the cap — degrading to no memory",
    );

    return null;
  }

  const hash = hashAgentMemory(content);

  log.debug(
    { agentId, hash, projectSlug, sizeChars: content.length },
    "[agents.memory] read",
  );

  return { content, hash, sizeChars: content.length };
}

export async function writeAgentMemory(
  projectSlug: string,
  agentId: string,
  content: string,
): Promise<{ hash: string }> {
  const max = agentMemoryMaxChars();

  if (content.length > max) {
    throw new MaisterError(
      "CONFIG",
      `agent memory: content is ${content.length} characters, over the ${max}-character cap`,
    );
  }

  const filePath = agentMemoryPath(projectSlug, agentId);

  await atomicWriteText(filePath, content);

  const hash = hashAgentMemory(content);

  log.debug(
    { agentId, hash, projectSlug, sizeChars: content.length },
    "[agents.memory] written",
  );

  return { hash };
}
