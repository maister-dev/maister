import type { ObservatoryLabels } from "@/components/observatory/types";

import en from "@/messages/en.json";
import { labelsFromTranslations } from "@/components/observatory/labels";

type Translator = Parameters<typeof labelsFromTranslations>[0];

function translatorFor(namespace: Record<string, unknown>): Translator {
  return ((key: string) =>
    key
      .split(".")
      .reduce<unknown>(
        (value, part) =>
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[part]
            : undefined,
        namespace,
      ) ?? key) as unknown as Translator;
}

// Derive test labels from the real EN catalog so the fixture can never drift
// from the shipped message namespace (the previous hand-written copy did).
// Pass another catalog's namespaces (e.g. ru.observatory, ru.runBucket,
// ru.runKind) to test RU labels.
export function labelsForTest(
  namespace: Record<string, unknown> = en.observatory as Record<
    string,
    unknown
  >,
  bucketNamespace: Record<string, unknown> = en.runBucket as Record<
    string,
    unknown
  >,
  kindNamespace: Record<string, unknown> = en.runKind as Record<
    string,
    unknown
  >,
): ObservatoryLabels {
  return labelsFromTranslations(
    translatorFor(namespace),
    translatorFor(bucketNamespace),
    translatorFor(kindNamespace),
  );
}
