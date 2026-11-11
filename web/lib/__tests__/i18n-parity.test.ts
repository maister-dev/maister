import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

// M27/T-A7: enforce EN/RU key-for-key parity (previously "by convention").
// A missing or extra key in either locale fails here rather than rendering a
// raw key path to a user.
function keyTree(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];

  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...keyTree(value as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }

  return keys.sort();
}

// T-C9b (ADR-152): the memory surface's keys live in the `agentsAttach`
// namespace — verified against the catalogs, NOT the `projectSettings.agents`
// the screen doc used to name, which exists in neither file.
describe("T-C9b — agent-memory keys are complete in both catalogs", () => {
  const MEMORY_KEYS = [
    "memoryAction",
    "memoryTitle",
    "memoryClose",
    "memoryEdit",
    "memorySave",
    "memoryCancel",
    "memoryClear",
    "memoryClearConfirm",
    "memoryClearConfirmTitle",
    "memoryClearError",
    "memoryEmpty",
    "memorySize",
    "memoryOverCap",
    "memoryConflict",
    "memoryLoadError",
    "memoryToggle",
    "memoryFlowBound",
  ];

  it.each(["en", "ru"] as const)(
    "%s carries every agentsAttach memory key with non-empty copy",
    (locale) => {
      const ns = (locale === "en" ? en : ru).agentsAttach as Record<
        string,
        string
      >;

      for (const key of MEMORY_KEYS) {
        expect(ns[key], `${locale}.agentsAttach.${key}`).toBeTruthy();
      }
    },
  );

  it("the size indicator template exposes both placeholders in both locales", () => {
    for (const ns of [en.agentsAttach, ru.agentsAttach] as Array<
      Record<string, string>
    >) {
      expect(ns.memorySize).toContain("{size}");
      expect(ns.memorySize).toContain("{max}");
    }
  });

  it("RU copy is actually translated, not an EN duplicate", () => {
    const enNs = en.agentsAttach as Record<string, string>;
    const ruNs = ru.agentsAttach as Record<string, string>;

    for (const key of [
      "memoryTitle",
      "memoryClearConfirm",
      "memoryFlowBound",
    ]) {
      expect(ruNs[key]).not.toBe(enNs[key]);
    }
  });
});

describe("i18n en/ru parity", () => {
  it("en and ru have identical key trees", () => {
    expect(keyTree(en as Record<string, unknown>)).toEqual(
      keyTree(ru as Record<string, unknown>),
    );
  });

  it("the flowEditor namespace is present in both locales", () => {
    expect(Object.prototype.hasOwnProperty.call(en, "flowEditor")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(ru, "flowEditor")).toBe(true);
  });
});

type MessageTree = { readonly [key: string]: string | MessageTree };

function messageAt(catalog: MessageTree, path: string): string | undefined {
  let value: string | MessageTree | undefined = catalog;

  for (const segment of path.split(".")) {
    if (value === undefined || typeof value === "string") return undefined;
    value = value[segment];
  }

  return typeof value === "string" ? value : undefined;
}

const requiredMessages: ReadonlyArray<{
  namespace: string;
  keys: readonly string[];
}> = [
  {
    namespace: "run",
    keys: [
      "settingsTitle",
      "settingsDeclaredIntentNote",
      "settingsVerdictEnforced",
      "settingsVerdictInstructed",
      "settingsVerdictRefused",
      "settingsClassMcps",
      "settingsClassTools",
      "settingsClassSkills",
      "settingsClassRestrictions",
      "settingsClassPermissionMode",
      "settingsClassWorkspaceAccess",
      "settingsClassHooks",
      "settingsNoConstraints",
      "settingsRefusalReason",
      "settingsRefusedHint",
    ],
  },
  {
    namespace: "settings",
    keys: [
      "addRunner",
      "createRunnerTitle",
      "editRunnerTitle",
      "editAction",
      "deleteRunner",
      "fromPreset",
      "colId",
      "colAdapter",
      "colModel",
      "colProvider",
      "colPolicy",
      "colReadiness",
      "readinessReady",
      "readinessNotReady",
      "readinessUnknown",
      "readinessAmbient",
      "colEnabled",
      "colActions",
      "fieldId",
      "fieldModel",
      "fieldProviderKind",
      "fieldBaseUrl",
      "fieldAuthToken",
      "fieldApiKey",
      "fieldWireApi",
      "fieldPermissionPolicy",
      "fieldEnabled",
      "deleteConfirm",
      "deleteBlockedTitle",
      "deleteBlockedIntro",
      "validId",
      "validEnvRef",
      "validUrl",
      "policyDefault",
      "policyDangerous",
      "saveFailed",
      "providerPresetsReference",
      "usePreset",
      "cancel",
      "save",
      "saving",
      "modelSuggestions.loading",
      "modelSuggestions.empty",
      "modelSuggestions.refresh",
      "modelSuggestions.unknownModelHint",
      "modelSuggestions.error",
      "modelSuggestions.sources.agent",
      "modelSuggestions.sources.provider",
      "modelSuggestions.sources.curated",
      "modelSuggestions.sources.observed",
      "modelSuggestions.sources.preset",
    ],
  },
  {
    namespace: "tokens",
    keys: [
      "title",
      "empty",
      "adminOnly",
      "create",
      "createTitle",
      "nameLabel",
      "namePlaceholder",
      "expiresLabel",
      "cancel",
      "confirm",
      "secretTitle",
      "secretWarning",
      "copy",
      "copied",
      "revoke",
      "revokeConfirm",
      "colName",
      "colPrefix",
      "colStatus",
      "colCreated",
      "colLastUsed",
      "colExpires",
      "statusActive",
      "statusRevoked",
      "statusExpired",
      "errorGeneric",
    ],
  },
  {
    namespace: "nav",
    keys: ["integrations"],
  },
  {
    namespace: "readiness",
    keys: [
      "summary",
      "reasons",
      "ready",
      "blocked",
      "stale",
      "failed",
      "waiting",
      "overridden",
    ],
  },
];

describe("required UI messages", () => {
  for (const [locale, catalog] of [
    ["en", en],
    ["ru", ru],
  ] as const) {
    it.each(requiredMessages)(
      `${locale}.$namespace has non-empty required copy`,
      ({ namespace, keys }) => {
        for (const key of keys) {
          const path = `${namespace}.${key}`;

          expect(messageAt(catalog, path), `${locale}.${path}`).toEqual(
            expect.stringMatching(/\S/u),
          );
        }
      },
    );
  }

  it("preserves the placeholders the Desk substitutes", () => {
    for (const catalog of [en, ru]) {
      expect(catalog.desk.workEmptyFiltered).toContain("$stage");
      expect(catalog.desk.workCount).toContain("$count");
      for (const [key, value] of Object.entries(catalog.desk)) {
        expect(value, key).not.toMatch(/\{count\}/u);
        if (/Count$/u.test(key)) expect(value, key).toContain("$count");
      }
    }
  });
});
