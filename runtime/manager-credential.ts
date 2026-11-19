import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const MANAGER_HOST_HEADER = "x-maister-execution-host";
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;

export class ManagerCredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagerCredentialError";
  }
}

/** Read one credential from a service-owned file. Rotation replaces its inode. */
export async function readManagerCredential(file: string): Promise<string> {
  if (!isAbsolute(file)) {
    throw new ManagerCredentialError(
      "Manager credential requires an absolute file path",
    );
  }

  try {
    const handle = await open(
      file,
      O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
    );

    try {
      const stat = await handle.stat();

      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        ![0o400, 0o600].includes(stat.mode & 0o7777) ||
        ![64, 65].includes(stat.size)
      ) {
        throw new ManagerCredentialError(
          "Manager credential requires a private service-owned file",
        );
      }
      const data = Buffer.alloc(66);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      const credential = data.toString("utf8", 0, bytesRead).replace(/\n$/, "");

      if (bytesRead !== stat.size || !/^[0-9a-f]{64}$/.test(credential)) {
        throw new ManagerCredentialError(
          "Manager credential requires 32 bytes encoded as lowercase hexadecimal",
        );
      }

      return credential;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ManagerCredentialError) throw error;
    throw new ManagerCredentialError(
      "Manager credential file could not be read",
      { cause: error },
    );
  }
}
