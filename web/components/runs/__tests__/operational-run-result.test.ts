import type { OperationalOutcome } from "@/lib/run-results/operational-types";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { expect, it, vi } from "vitest";

import { OperationalRunResult } from "@/components/runs/operational-run-result";
import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/feedback/feedback-provider", () => ({
  useFeedback: () => ({ error: vi.fn(), success: vi.fn() }),
}));

const invalid: OperationalOutcome = {
  version: 1,
  state: "terminal",
  reportedOutcome: null,
  effectiveOutcome: "failed",
  successful: false,
  validation: "invalid",
  integrity: "clean",
  resultRevision: 1,
  reportedResult: null,
  referenceLinks: [],
  reasonCodes: ["schema_mismatch"],
  cleanup: null,
};

it.each([
  {
    locale: "en",
    messages: en,
    invariant: "Partial completion requires confirmed progress.",
    remediation:
      "If nothing completed and no effect was confirmed, report blocked or failed with an actionable error diagnostic.",
  },
  {
    locale: "ru",
    messages: ru,
    invariant: "Частичное выполнение требует подтверждённого прогресса.",
    remediation:
      "Если ничего не выполнено и ни один эффект не подтверждён, укажите blocked или failed с описанием ошибки и способом её устранения.",
  },
])(
  "shows the exact rejected invariant, field and remediation in $locale while retaining old receipt compatibility",
  ({ locale, messages, invariant, remediation }) => {
    const render = (outcome: OperationalOutcome): string =>
      renderToStaticMarkup(
        // The provider's props require children in this non-JSX renderer.
        // eslint-disable-next-line react/no-children-prop
        createElement(NextIntlClientProvider, {
          locale,
          messages,
          timeZone: "UTC",
          children: createElement(OperationalRunResult, {
            runId: "run",
            outcome,
            canAct: false,
          }),
        }),
      );
    const html = render({
      ...invalid,
      validationDiagnostics: [
        { code: "partial_requires_progress", path: "outcome" },
      ],
    });

    expect(html).toContain(invariant);
    expect(html).toContain(remediation);
    expect(html).toContain("<code>outcome</code>");
    expect(html).not.toContain(messages.operationalAgents.counts.scanned);
    expect(render(invalid)).toContain(messages.operationalAgents.invalidResult);
    const preparationHtml = render({
      ...invalid,
      resultRevision: null,
      infrastructureFailure: {
        runId: "run",
        assignmentEpoch: 1,
        stage: "baseline",
        probeOperation: "lstat",
        causeChain: [{ name: "Error", code: "ENOENT", syscall: "lstat" }],
      },
    });

    expect(preparationHtml).toContain(
      messages.operationalAgents.preparationFailed,
    );
    expect(preparationHtml).toContain(
      messages.operationalAgents.preparationRemediation,
    );
    expect(preparationHtml).toContain("ENOENT");
    expect(preparationHtml).not.toContain(
      messages.operationalAgents.invalidResult,
    );
  },
);
