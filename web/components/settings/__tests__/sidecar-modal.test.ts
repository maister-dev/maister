import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/settings",
}));

import {
  SidecarModal,
  type SidecarRow,
} from "@/components/settings/sidecar-modal";

const row: SidecarRow = {
  id: "ccr-default",
  lifecycle: "managed",
  configPath: "~/.claude-code-router/config.json",
  baseUrl: "http://127.0.0.1:3456",
  healthcheckUrl: "http://127.0.0.1:3456/health",
  authTokenRef: "env:MAISTER_CCR_AUTH_TOKEN",
  enabled: true,
};

describe("SidecarModal", () => {
  it("renders the create form with an editable id and no delete button", () => {
    const markup = renderToStaticMarkup(
      createElement(SidecarModal, {
        mode: "create",
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(markup).toContain("createSidecarTitle");
    expect(markup).toContain("lifecycle");
    expect(markup).toContain("configPath");
    expect(markup).toContain("authTokenRef");
    // create mode: id is an editable input, delete is absent
    expect(markup).toContain('type="text"');
    expect(markup).not.toContain("deleteSidecar");
  });

  it("renders the edit form prefilled with a read-only id and a delete button", () => {
    const markup = renderToStaticMarkup(
      createElement(SidecarModal, {
        mode: "edit",
        sidecar: row,
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(markup).toContain("editSidecarTitle");
    expect(markup).toContain("deleteSidecar");
    // edit prefill from the row
    expect(markup).toContain("ccr-default");
    expect(markup).toContain("http://127.0.0.1:3456");
    expect(markup).toContain("env:MAISTER_CCR_AUTH_TOKEN");
    // id renders as a read-only <code>, not an editable id input
    expect(markup).toContain("<code");
  });
});
