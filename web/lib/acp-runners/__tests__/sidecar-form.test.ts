import { describe, expect, it } from "vitest";

import {
  buildCreateBody,
  buildPatchBody,
  emptySidecarDraft,
  validateSidecarDraft,
  type SidecarDraft,
} from "@/lib/acp-runners/sidecar-form";

const valid: SidecarDraft = {
  id: "ccr-default",
  lifecycle: "managed",
  configPath: "~/.claude-code-router/config.json",
  baseUrl: "http://127.0.0.1:3456",
  healthcheckUrl: "http://127.0.0.1:3456/health",
  authTokenRef: "env:MAISTER_CCR_AUTH_TOKEN",
  enabled: true,
};

describe("validateSidecarDraft", () => {
  it("accepts a well-formed draft", () => {
    expect(validateSidecarDraft(valid).ok).toBe(true);
  });

  it("rejects a bad id", () => {
    expect(validateSidecarDraft({ ...valid, id: "bad id!" }).errors.id).toBe(
      "id",
    );
  });

  it("rejects an empty id", () => {
    expect(validateSidecarDraft(emptySidecarDraft()).errors.id).toBe("id");
  });

  it("rejects a non-URL baseUrl and healthcheckUrl", () => {
    expect(
      validateSidecarDraft({ ...valid, baseUrl: "not a url" }).errors.baseUrl,
    ).toBe("baseUrl");
    expect(
      validateSidecarDraft({ ...valid, healthcheckUrl: "nope" }).errors
        .healthcheckUrl,
    ).toBe("healthcheckUrl");
  });

  it("rejects a non-env: authTokenRef", () => {
    expect(
      validateSidecarDraft({ ...valid, authTokenRef: "raw-token" }).errors
        .authTokenRef,
    ).toBe("authTokenRef");
  });

  it("rejects a configPath containing ..", () => {
    expect(
      validateSidecarDraft({ ...valid, configPath: "../etc/passwd" }).errors
        .configPath,
    ).toBe("configPath");
  });

  it("treats empty optionals as valid when id is present", () => {
    expect(validateSidecarDraft({ ...emptySidecarDraft(), id: "ccr" }).ok).toBe(
      true,
    );
  });
});

describe("buildCreateBody", () => {
  it("derives commandPreset ccr_start for managed and null for external", () => {
    expect(buildCreateBody(valid).commandPreset).toBe("ccr_start");
    expect(
      buildCreateBody({ ...valid, lifecycle: "external" }).commandPreset,
    ).toBeNull();
  });

  it("maps empty optionals to null", () => {
    const body = buildCreateBody({
      id: "x",
      lifecycle: "managed",
      enabled: true,
    });

    expect(body).toMatchObject({
      id: "x",
      kind: "ccr",
      configPath: null,
      baseUrl: null,
      healthcheckUrl: null,
      authTokenRef: null,
      enabled: true,
    });
  });
});

describe("buildPatchBody", () => {
  it("returns an empty body when nothing changed", () => {
    expect(buildPatchBody(valid, valid)).toEqual({});
  });

  it("omits enabled on a config-only edit", () => {
    const body = buildPatchBody(
      { ...valid, baseUrl: "http://127.0.0.1:9999" },
      valid,
    );

    expect(body).toEqual({ baseUrl: "http://127.0.0.1:9999" });
    expect("enabled" in body).toBe(false);
  });

  it("includes enabled only when it actually changed", () => {
    expect(buildPatchBody({ ...valid, enabled: false }, valid)).toEqual({
      enabled: false,
    });
  });

  it("clears a removed field to null", () => {
    expect(buildPatchBody({ ...valid, baseUrl: "" }, valid)).toEqual({
      baseUrl: null,
    });
  });

  it("emits both lifecycle and commandPreset when lifecycle switches", () => {
    expect(buildPatchBody({ ...valid, lifecycle: "external" }, valid)).toEqual({
      lifecycle: "external",
      commandPreset: null,
    });
  });
});
