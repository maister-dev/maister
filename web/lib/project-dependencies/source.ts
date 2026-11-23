import "server-only";

import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { MaisterError } from "@/lib/errors";
import { validateUrl } from "@/lib/repo-source";

/** Validate coordinates without contacting the remote or exposing them in errors. */
export function assertDependencySource(source: string): void {
  const invalid = () =>
    new MaisterError(
      "CONFIG",
      "Use an absolute local path or supported Git URL without credentials, query parameters or fragments.",
    );

  if (!source || source.length > 4096 || /[\x00-\x1f\x7f]/u.test(source))
    throw invalid();
  if (isAbsolute(source)) return;
  if (source.includes("?") || source.includes("#")) throw invalid();

  try {
    validateUrl(source);
    if (source.includes("://")) {
      const url = new URL(source);

      if (url.password || (url.username && url.protocol !== "ssh:"))
        throw invalid();
      if (url.protocol === "file:") fileURLToPath(url);
    } else if (
      !/^[A-Za-z0-9_.][A-Za-z0-9_.-]*@[A-Za-z0-9_.][A-Za-z0-9_.-]*:.+$/.test(
        source,
      )
    ) {
      throw invalid();
    }
  } catch {
    throw invalid();
  }
}
