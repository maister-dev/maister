import type { ObservatoryLabels } from "@/components/observatory/types";

import en from "@/messages/en.json";
import { labelsFromTranslations } from "@/components/observatory/labels";

type Translator = Parameters<typeof labelsFromTranslations>[0];

// Derive test labels from the real EN catalog so the fixture can never drift
// from the shipped message namespace (the previous hand-written copy did).
// Pass another catalog's namespace (e.g. ru.observatory) to test RU labels.
export function labelsForTest(
  namespace: Record<string, unknown> = en.observatory as Record<
    string,
    unknown
  >,
): ObservatoryLabels {
  const translate = ((key: string) =>
    key
      .split(".")
      .reduce<unknown>(
        (value, part) =>
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[part]
            : undefined,
        namespace,
      ) ?? key) as unknown as Translator;

  return labelsFromTranslations(translate);
}
