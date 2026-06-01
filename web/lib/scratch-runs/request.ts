import "server-only";

import type { NextRequest } from "next/server";
import type { z, ZodTypeAny } from "zod";
import type { ScratchUploadedFileInput } from "@/lib/scratch-runs/types";

import { MaisterError } from "@/lib/errors";

const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;

export type ParsedScratchRequest<T> = {
  body: T;
  uploadedFiles: ScratchUploadedFileInput[];
  contentType: "application/json" | "multipart/form-data";
};

function mediaType(req: NextRequest): string {
  return req.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
}

async function parseJsonPayload<T>(
  payload: unknown,
  schema: ZodTypeAny,
): Promise<T> {
  try {
    return schema.parse(payload) as T;
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid POST body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function uploadedFileInput(
  file: File,
): Promise<ScratchUploadedFileInput> {
  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    throw new MaisterError(
      "PRECONDITION",
      `uploaded file is too large: ${file.name} (${file.size} bytes)`,
    );
  }

  return {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    byteSize: file.size,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

export async function parseScratchRequest<TSchema extends ZodTypeAny>(
  req: NextRequest,
  schema: TSchema,
): Promise<ParsedScratchRequest<z.infer<TSchema>>> {
  const type = mediaType(req);

  if (type === "" || type === "application/json" || type === "text/plain") {
    let payload: unknown;

    try {
      payload = await req.json();
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `malformed JSON body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      body: await parseJsonPayload(payload, schema),
      uploadedFiles: [],
      contentType: "application/json",
    };
  }

  if (type !== "multipart/form-data") {
    throw new MaisterError("CONFIG", `unsupported content type: ${type}`);
  }

  let formData: FormData;

  try {
    formData = await req.formData();
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `malformed multipart body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const payloadEntry = formData.get("payload");

  if (typeof payloadEntry !== "string") {
    throw new MaisterError("CONFIG", "multipart payload field is required");
  }

  let payload: unknown;

  try {
    payload = JSON.parse(payloadEntry);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `malformed multipart payload JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fileEntries = formData
    .getAll("files")
    .filter((entry): entry is File => entry instanceof File);

  if (fileEntries.length > MAX_UPLOAD_FILES) {
    throw new MaisterError(
      "PRECONDITION",
      `too many uploaded files: ${fileEntries.length}`,
    );
  }

  const totalBytes = fileEntries.reduce((sum, file) => sum + file.size, 0);

  if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
    throw new MaisterError(
      "PRECONDITION",
      `uploaded files are too large in total: ${totalBytes} bytes`,
    );
  }

  return {
    body: await parseJsonPayload(payload, schema),
    uploadedFiles: await Promise.all(fileEntries.map(uploadedFileInput)),
    contentType: "multipart/form-data",
  };
}
