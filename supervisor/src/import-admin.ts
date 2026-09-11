import { SupervisorError } from "./types";

// S4.3 / D9: the historical import path is admitted only for the exact import
// the operator enabled locally, at its exact generation and manifest digest.
// Enablement is an out-of-band operator act read at boot — no HTTP request can
// turn it on, and a revoked generation is gone for the life of the process.

const IMPORT_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export type ImportAdmission = {
  importId: string;
  generation: number;
  manifestDigest: string;
};

export type ImportAdmissionConfig = {
  directory: string;
  importId: string;
};

export type ImportAdmissionSnapshot =
  | { enabled: false; revoked: boolean }
  | {
      enabled: true;
      importId: string;
      generation: number;
      manifestDigest: string;
    };

function refuse(
  reason:
    | "import_admission_disabled"
    | "import_admission_revoked"
    | "import_generation_stale"
    | "import_manifest_mismatch",
): never {
  throw new SupervisorError("PRECONDITION", reason, { details: { reason } });
}

export function resolveImportAdmissionConfig(
  env: NodeJS.ProcessEnv,
): ImportAdmissionConfig | null {
  const directory = env.MAISTER_IMPORT_ADMISSION_DIR?.trim() ?? "";
  const importId = env.MAISTER_IMPORT_ADMISSION_ID?.trim() ?? "";

  if (!directory && !importId) return null;
  if (!directory) {
    throw new Error(
      "MAISTER_IMPORT_ADMISSION_DIR is required alongside MAISTER_IMPORT_ADMISSION_ID",
    );
  }
  if (!importId) {
    throw new Error(
      "MAISTER_IMPORT_ADMISSION_ID is required alongside MAISTER_IMPORT_ADMISSION_DIR",
    );
  }
  if (!IMPORT_ID.test(importId)) {
    throw new Error("import id must be 1-64 characters of [A-Za-z0-9._:-]");
  }

  return { directory, importId };
}

export class ImportAdmissionRegistry {
  #admitted: ImportAdmission | null = null;
  // Keyed by import id: a generation is revoked for good, but the operator may
  // restart the supervisor and enable the next generation of the same manifest.
  readonly #revoked = new Map<string, number>();

  enable(admission: ImportAdmission): void {
    if (this.#revoked.get(admission.importId) === admission.generation) {
      refuse("import_admission_revoked");
    }
    this.#admitted = { ...admission };
  }

  revoke(importId: string): void {
    if (!this.#admitted || this.#admitted.importId !== importId) {
      refuse("import_admission_disabled");
    }
    this.#revoked.set(importId, this.#admitted.generation);
    this.#admitted = null;
  }

  require(request: ImportAdmission): ImportAdmission {
    const admitted = this.#admitted;

    if (!admitted || admitted.importId !== request.importId) {
      if (this.#revoked.get(request.importId) === request.generation) {
        refuse("import_admission_revoked");
      }
      refuse("import_admission_disabled");
    }
    if (admitted.generation !== request.generation) {
      refuse("import_generation_stale");
    }
    if (admitted.manifestDigest !== request.manifestDigest) {
      refuse("import_manifest_mismatch");
    }

    return { ...admitted };
  }

  snapshot(): ImportAdmissionSnapshot {
    if (!this.#admitted) {
      return { enabled: false, revoked: this.#revoked.size > 0 };
    }

    return { enabled: true, ...this.#admitted };
  }
}
