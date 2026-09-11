// S4.3 / D9: the maintenance import path is admitted only for the exact import
// the operator enabled locally, at its exact generation and manifest digest.
// Every other request is refused before a byte is read. Enablement is an
// out-of-band operator act — shutdown disables admission and a revoked
// generation can never be reopened over HTTP.

import { describe, expect, it } from "vitest";

import {
  ImportAdmissionRegistry,
  resolveImportAdmissionConfig,
} from "../import-admin";

const admission = {
  importId: "inv-7f3a",
  generation: 1,
  manifestDigest: "a".repeat(64),
};

function enabled(): ImportAdmissionRegistry {
  const registry = new ImportAdmissionRegistry();

  registry.enable(admission);

  return registry;
}

describe("resolveImportAdmissionConfig", () => {
  it("stays disabled when the operator set nothing", () => {
    expect(resolveImportAdmissionConfig({})).toBeNull();
  });

  it("reads the operator directory and import id together", () => {
    expect(
      resolveImportAdmissionConfig({
        MAISTER_IMPORT_ADMISSION_DIR: "/srv/import",
        MAISTER_IMPORT_ADMISSION_ID: "inv-7f3a",
      }),
    ).toEqual({ directory: "/srv/import", importId: "inv-7f3a" });
  });

  it("refuses a half-configured admission rather than guessing", () => {
    expect(() =>
      resolveImportAdmissionConfig({
        MAISTER_IMPORT_ADMISSION_DIR: "/srv/import",
      }),
    ).toThrow(/MAISTER_IMPORT_ADMISSION_ID/);
    expect(() =>
      resolveImportAdmissionConfig({ MAISTER_IMPORT_ADMISSION_ID: "inv-7f3a" }),
    ).toThrow(/MAISTER_IMPORT_ADMISSION_DIR/);
  });

  it("refuses an import id that is not an opaque token", () => {
    expect(() =>
      resolveImportAdmissionConfig({
        MAISTER_IMPORT_ADMISSION_DIR: "/srv/import",
        MAISTER_IMPORT_ADMISSION_ID: "../escape",
      }),
    ).toThrow(/import id/i);
  });
});

describe("ImportAdmissionRegistry", () => {
  it("admits only the enabled import, generation and manifest digest", () => {
    const registry = enabled();

    expect(registry.require(admission)).toEqual(admission);
  });

  it("refuses a request for an import that was never enabled", () => {
    const registry = new ImportAdmissionRegistry();

    expect(() => registry.require(admission)).toThrowError(
      expect.objectContaining({ code: "PRECONDITION" }),
    );
    expect(() => registry.require(admission)).toThrow(
      /import_admission_disabled/,
    );
  });

  it("refuses another import id while one is enabled", () => {
    const registry = enabled();

    expect(() =>
      registry.require({ ...admission, importId: "inv-0000" }),
    ).toThrow(/import_admission_disabled/);
  });

  it("refuses a stale generation as a typed conflict", () => {
    const registry = enabled();

    expect(() => registry.require({ ...admission, generation: 0 })).toThrow(
      /import_generation_stale/,
    );
    expect(() => registry.require({ ...admission, generation: 2 })).toThrow(
      /import_generation_stale/,
    );
  });

  it("refuses a manifest digest that does not match the enabled manifest", () => {
    const registry = enabled();

    expect(() =>
      registry.require({ ...admission, manifestDigest: "b".repeat(64) }),
    ).toThrow(/import_manifest_mismatch/);
  });

  it("cannot be reopened over the wire once its generation is revoked", () => {
    const registry = enabled();

    registry.revoke(admission.importId);
    expect(() => registry.require(admission)).toThrow(
      /import_admission_revoked/,
    );
    expect(() => registry.enable(admission)).toThrow(
      /import_admission_revoked/,
    );
  });

  it("keeps revocation scoped to the generation it revoked", () => {
    const registry = enabled();

    registry.revoke(admission.importId);
    registry.enable({ ...admission, generation: 2 });
    expect(registry.require({ ...admission, generation: 2 })).toMatchObject({
      generation: 2,
    });
  });

  it("refuses to revoke an import it never admitted", () => {
    const registry = enabled();

    expect(() => registry.revoke("inv-0000")).toThrow(
      /import_admission_disabled/,
    );
  });

  it("reports a bounded snapshot without leaking the operator directory", () => {
    const registry = enabled();

    expect(registry.snapshot()).toEqual({
      enabled: true,
      importId: admission.importId,
      generation: 1,
      manifestDigest: admission.manifestDigest,
    });
    registry.revoke(admission.importId);
    expect(registry.snapshot()).toEqual({ enabled: false, revoked: true });
  });
});
