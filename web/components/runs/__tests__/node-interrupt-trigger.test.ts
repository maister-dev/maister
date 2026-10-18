import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

import { NodeInterruptTrigger } from "@/components/runs/node-interrupt-trigger";

describe("NodeInterruptTrigger", () => {
  it("explains that the control stops only the current step", () => {
    const html = renderToStaticMarkup(
      createElement(NodeInterruptTrigger, {
        runId: "11111111-1111-4111-8111-111111111111",
        canAct: true,
      }),
    );

    expect(html).toContain("nodeInterrupt.interruptNode");
    expect(html).toContain("nodeInterrupt.interruptNodeHelp");
    expect(html).toContain("aria-describedby=");
  });

  it("uses explicit English and Russian copy", () => {
    const en = JSON.parse(
      readFileSync(
        new URL("../../../messages/en.json", import.meta.url),
        "utf8",
      ),
    ) as { nodeInterrupt: Record<string, string> };
    const ru = JSON.parse(
      readFileSync(
        new URL("../../../messages/ru.json", import.meta.url),
        "utf8",
      ),
    ) as { nodeInterrupt: Record<string, string> };

    expect(en.nodeInterrupt.interruptNode).toBe("Stop current step");
    expect(en.nodeInterrupt.interruptNodeHelp).toMatch(/only the current/i);
    expect(ru.nodeInterrupt.interruptNode).toBe("Остановить текущий шаг");
    expect(ru.nodeInterrupt.interruptNodeHelp).toMatch(/только текущий шаг/i);
  });
});
