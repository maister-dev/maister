import "server-only";

import { MaisterError } from "@/lib/errors";

export async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json" ||
    !request.body
  )
    throw new MaisterError("CONFIG", "An application/json body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) {
        complete = true;
        break;
      }
      length += next.value.byteLength;
      if (length > maxBytes)
        throw new MaisterError("CONFIG", "JSON body exceeds its byte limit", {
          details: { reason: "json_body_too_large" },
        });
      chunks.push(next.value);
    }
  } finally {
    if (!complete) await reader.cancel();
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new MaisterError("CONFIG", "Body must be valid UTF-8 JSON");
    throw error;
  }
}
