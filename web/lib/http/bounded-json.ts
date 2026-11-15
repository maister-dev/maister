import "server-only";

import { MaisterError } from "@/lib/errors";

/** Caller-facing refusal copy; `tooLargeReason` maps the overflow to 413. */
export type BoundedJsonMessages = Readonly<{
  contentType: string;
  missing: string;
  tooLarge: string;
  tooLargeReason: string;
  invalid: string;
}>;

const defaultMessages: BoundedJsonMessages = {
  contentType: "An application/json body is required",
  missing: "An application/json body is required",
  tooLarge: "JSON body exceeds its byte limit",
  tooLargeReason: "json_body_too_large",
  invalid: "Body must be valid UTF-8 JSON",
};

/** Reads at most `maxBytes` of strict UTF-8 JSON, refusing other content types. */
export async function readBoundedJson(
  request: Request,
  maxBytes: number,
  messages: BoundedJsonMessages = defaultMessages,
): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    throw new MaisterError("CONFIG", messages.contentType);
  if (!request.body) throw new MaisterError("CONFIG", messages.missing);
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
        throw new MaisterError("CONFIG", messages.tooLarge, {
          details: { reason: messages.tooLargeReason },
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
      throw new MaisterError("CONFIG", messages.invalid);
    throw error;
  }
}
