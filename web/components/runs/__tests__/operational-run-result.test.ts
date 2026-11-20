import type { OperationalOutcome } from "@/lib/run-results/operational-types";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { expect, it, vi } from "vitest";

import { OperationalRunResult } from "@/components/runs/operational-run-result";
import { TaskQualificationSourceFailureNotice } from "@/components/agents/task-qualification-source-failure-notice";
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
  ["en", en, "Continuation needs attention", "Recheck execution"],
  ["ru", ru, "Продолжение требует внимания", "Проверить исполнение"],
] as const)(
  "renders the settlement diagnosis and gates the action in %s",
  (locale, messages, heading, action) => {
    const render = (canAct: boolean): string =>
      renderToStaticMarkup(
        createElement(NextIntlClientProvider, {
          locale,
          messages,
          timeZone: "UTC",
          // eslint-disable-next-line react-jsx/no-children-prop -- Provider props require children in the non-JSX renderer.
          children: createElement(OperationalRunResult, {
            runId: "run",
            canAct,
            outcome: {
              ...invalid,
              state: "pending",
              effectiveOutcome: null,
              validation: "pending",
              resultRevision: null,
              reasonCodes: [],
              continuationAttention: {
                assignmentEpoch: 2,
                reason: "operational_integrity_refused",
                blockedReason: "session_process_owner_unconfirmed",
                observation: "a".repeat(32),
              },
            },
          }),
        }),
      );
    const member = render(true);
    const viewer = render(false);
    for (const html of [member, viewer]) {
      expect(html).toContain(heading);
      expect(html).toContain("session_process_owner_unconfirmed");
      expect(html).not.toContain(messages.operationalAgents.awaitingResult);
    }
    expect(member).toContain(action);
    expect(viewer).not.toContain(action);
  },
);

it.each([
  {
    locale: "en",
    messages: en,
    invariant: "Partial completion requires confirmed progress.",
    remediation:
      "If nothing completed and no effect was confirmed, report blocked or failed with an actionable error diagnostic.",
    preparation:
      "Workspace preparation failed. This is an infrastructure failure, not a task assessment.",
    preparationAction:
      "Inspect the preparation details and resolve the reported problem before starting a new attempt.",
    modelClaim: "The model did not start",
  },
  {
    locale: "ru",
    messages: ru,
    invariant: "Частичное выполнение требует подтверждённого прогресса.",
    remediation:
      "Если ничего не выполнено и ни один эффект не подтверждён, укажите blocked или failed с описанием ошибки и способом её устранения.",
    preparation:
      "Подготовка рабочего пространства завершилась ошибкой. Это сбой инфраструктуры, а не оценка задачи.",
    preparationAction:
      "Изучите детали подготовки и устраните указанную проблему перед новой попыткой.",
    modelClaim: "Модель не была запущена",
  },
])(
  "shows the exact rejected invariant, field and remediation in $locale while retaining old receipt compatibility",
  ({
    locale,
    messages,
    invariant,
    remediation,
    preparation,
    preparationAction,
    modelClaim,
  }) => {
    const render = (outcome: OperationalOutcome): string =>
      renderToStaticMarkup(
        // The provider's props require children in this non-JSX renderer.
        createElement(NextIntlClientProvider, {
          locale,
          messages,
          timeZone: "UTC",
          // eslint-disable-next-line react-jsx/no-children-prop -- Provider props require children in the non-JSX renderer.
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
        // A later epoch carries no evidence that earlier model execution was absent.
        assignmentEpoch: 3,
        stage: "baseline",
        probeOperation: "lstat",
        causeChain: [{ name: "Error", code: "ENOENT", syscall: "lstat" }],
      },
    });

    expect(preparationHtml).toContain(
      messages.operationalAgents.preparationFailed,
    );
    expect(preparationHtml).toContain(preparation);
    expect(preparationHtml).toContain(preparationAction);
    expect(preparationHtml).not.toContain(modelClaim);
    expect(preparationHtml).toContain(
      messages.operationalAgents.preparationRemediation,
    );
    expect(preparationHtml).toContain("ENOENT");
    expect(preparationHtml).not.toContain(
      messages.operationalAgents.invalidResult,
    );
    const provenTaskFailure = renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale,
        messages,
        timeZone: "UTC",
        // eslint-disable-next-line react-jsx/no-children-prop -- Provider props require children in the non-JSX renderer.
        children: createElement(TaskQualificationSourceFailureNotice, {
          failure: {
            runId: "run",
            stage: "baseline",
            causeCode: "ENOENT",
            modelStarted: false,
          },
        }),
      }),
    );

    expect(provenTaskFailure).toContain(
      messages.launch.admission.beforeModelFailure,
    );
    expect(provenTaskFailure).toContain('href="/runs/run"');
  },
);
