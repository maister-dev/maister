import "server-only";

import { isIPv6 } from "node:net";

import { MaisterError } from "@/lib/errors";

const controls = /[\x00-\x1f\x7f-\x9f]/u;
const network =
  /^(?:https?|ssh):\/\/(?:([A-Za-z0-9._-]+)@)?(\[[0-9A-Fa-f:.]+\]|[^/@:\[\]%<>|^]+)(?::([0-9]+))?(?:\/.*)?$/u;
const localFile = /^file:\/\/(?:localhost)?(\/.*)$/u;
const scp = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*@[A-Za-z0-9_.][A-Za-z0-9_.-]*:.+$/u;

function validHost(host: string): boolean {
  if (host.startsWith("[")) return isIPv6(host.slice(1, -1));
  // Dotted numeric literals must resolve as IPv4. Git also supports ordinary
  // host aliases, including names without a dot.
  if (/^[0-9.]+$/.test(host) && host.includes(".")) {
    const parts = host.replace(/\.$/, "").split(".");

    return (
      parts.length <= 4 &&
      parts.every((part, i) => {
        if (!/^\d+$/.test(part)) return false;
        const radix = part.length > 1 && part.startsWith("0") ? 8 : 10;

        if (radix === 8 && /[89]/.test(part)) return false;

        return (
          parseInt(part, radix) <
          256 ** (i === parts.length - 1 ? 5 - parts.length : 1)
        );
      })
    );
  }

  return true;
}

/** This grammar is also enforced by project_dependency_safe_source on persisted pins. */
export function assertDependencySource(source: string): void {
  const invalid = () =>
    new MaisterError(
      "CONFIG",
      "Use an absolute local path or supported Git URL without credentials, query parameters or fragments.",
      { details: { field: "source" } },
    );

  if (!source || [...source].length > 4096 || controls.test(source))
    throw invalid();
  if (source.startsWith("/")) return;
  if (/[\s\\?#]/u.test(source)) throw invalid();
  const file = localFile.exec(source);

  if (file) {
    try {
      if (/%(?:2f|00)/i.test(file[1])) throw invalid();
      decodeURIComponent(file[1]);
    } catch {
      throw invalid();
    }

    return;
  }
  if (scp.test(source) && !source.includes("::")) return;
  const parts = network.exec(source);

  if (
    !parts ||
    (parts[1] && !source.startsWith("ssh://")) ||
    !validHost(parts[2]) ||
    (parts[3] !== undefined && Number(parts[3]) > 65535)
  )
    throw invalid();
}
