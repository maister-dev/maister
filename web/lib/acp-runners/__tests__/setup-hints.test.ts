import { describe, expect, it } from "vitest";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { adapterSetupHint } from "@/lib/acp-runners/setup-hints";
import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

const enSetup = (en as { settings: { setupHint: Record<string, string> } })
  .settings.setupHint;
const ruSetup = (ru as { settings: { setupHint: Record<string, string> } })
  .settings.setupHint;

describe("adapterSetupHint", () => {
  for (const adapter of ADAPTER_IDS) {
    it(`returns the settings-namespace key for ${adapter}`, () => {
      expect(adapterSetupHint(adapter)).toBe(`setupHint.${adapter}`);
    });

    it(`${adapter} hint resolves to a non-empty EN and RU string`, () => {
      const leaf = adapterSetupHint(adapter).split(".")[1];

      expect(typeof enSetup[leaf]).toBe("string");
      expect(enSetup[leaf].length).toBeGreaterThan(0);
      expect(typeof ruSetup[leaf]).toBe("string");
      expect(ruSetup[leaf].length).toBeGreaterThan(0);
    });
  }
});
