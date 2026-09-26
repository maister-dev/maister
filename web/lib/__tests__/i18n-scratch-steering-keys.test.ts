import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

// ADR-182 T4.5: the scratch delivery copy. Key-for-key EN/RU parity is the
// global `i18n-parity` test; this pins the steering keys' copy and that the
// busy-composer copy no longer promises the deleted browser auto-send.
const DELIVERY_KEYS = [
  "deliverySteeredNotice",
  "deliveryQueuedNotice",
  "deliveryQueuedBadge",
  "deliverySteeredBadge",
  "deliveryNotSentBadge",
] as const;

describe("scratch steering copy (ADR-182)", () => {
  it.each(["en", "ru"] as const)(
    "%s carries every delivery key with non-empty copy",
    (locale) => {
      const ns = (locale === "en" ? en : ru).scratch as unknown as Record<
        string,
        unknown
      >;

      for (const key of DELIVERY_KEYS)
        expect(ns[key], `${locale}.scratch.${key}`).toBeTruthy();
    },
  );

  it("drops the auto-send promise from the busy composer copy", () => {
    expect(en.scratch.interruptTitle).not.toMatch(/automatically/i);
    expect(en.scratch.draftWhileBusy).not.toMatch(/Stop/);
    expect(ru.scratch.interruptTitle).not.toMatch(/автоматически/i);
    expect(ru.scratch.draftWhileBusy).not.toMatch(/Стоп/);
  });
});
