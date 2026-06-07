import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveOutputResultSchema } from "@/lib/config";
import { MaisterError } from "@/lib/errors";

const validSchemaDoc = {
  schemaVersion: 1,
  fields: [
    { name: "ok", type: "boolean", required: true },
    {
      name: "result",
      type: "object",
      fields: [{ name: "score", type: "number" }],
    },
  ],
};

let flowInstallPath: string;
let outsideDir: string;

beforeAll(async () => {
  flowInstallPath = await mkdtemp(path.join(tmpdir(), "m26-output-schema-"));
  outsideDir = await mkdtemp(path.join(tmpdir(), "m26-output-outside-"));
  await mkdir(path.join(flowInstallPath, "schemas"), { recursive: true });
  await writeFile(
    path.join(flowInstallPath, "schemas", "review.json"),
    JSON.stringify(validSchemaDoc),
    "utf8",
  );
  await writeFile(
    path.join(flowInstallPath, "schemas", "bad.json"),
    "{ not valid json",
    "utf8",
  );
  await writeFile(
    path.join(flowInstallPath, "schemas", "wrong-shape.json"),
    JSON.stringify({
      schemaVersion: 1,
      fields: [{ name: "n", type: "tuple" }],
    }),
    "utf8",
  );

  // A symlink inside the install dir whose real target escapes it: the prefix
  // check on the joined path passes, but the realpath resolution must reject it.
  await writeFile(
    path.join(outsideDir, "secret.json"),
    JSON.stringify(validSchemaDoc),
    "utf8",
  );
  await symlink(
    path.join(outsideDir, "secret.json"),
    path.join(flowInstallPath, "schemas", "escape.json"),
  );
});

afterAll(async () => {
  await rm(flowInstallPath, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("resolveOutputResultSchema", () => {
  it("resolves and validates a valid ./schema.json (formSchemaSchema doc)", async () => {
    const schema = await resolveOutputResultSchema(
      flowInstallPath,
      "./schemas/review.json",
    );

    expect(schema).toMatchObject({
      schemaVersion: 1,
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "ok", type: "boolean" }),
      ]),
    });
  });

  it("rejects a path that escapes the flow install dir with CONFIG", async () => {
    await expect(
      resolveOutputResultSchema(flowInstallPath, "../../etc/passwd"),
    ).rejects.toMatchObject({ code: "CONFIG" });
    await expect(
      resolveOutputResultSchema(flowInstallPath, "../../etc/passwd"),
    ).rejects.toBeInstanceOf(MaisterError);
  });

  it("rejects a missing file with CONFIG", async () => {
    await expect(
      resolveOutputResultSchema(flowInstallPath, "./schemas/missing.json"),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("rejects a file that is not valid JSON with CONFIG", async () => {
    await expect(
      resolveOutputResultSchema(flowInstallPath, "./schemas/bad.json"),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("rejects a file that is not a valid formSchemaSchema doc with CONFIG", async () => {
    await expect(
      resolveOutputResultSchema(flowInstallPath, "./schemas/wrong-shape.json"),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("rejects a symlink whose real target escapes the install dir with CONFIG", async () => {
    await expect(
      resolveOutputResultSchema(flowInstallPath, "./schemas/escape.json"),
    ).rejects.toMatchObject({ code: "CONFIG" });
    await expect(
      resolveOutputResultSchema(flowInstallPath, "./schemas/escape.json"),
    ).rejects.toBeInstanceOf(MaisterError);
  });
});
