// CMSG-02 / CMSG-03 / CMSG-05 engine (ADR-225, docs/system-analytics/client-messages.md)
// — pure in-memory fixture tests proving every traversal and violation rule of
// `scanClientNamespaces` and `minimalCover` without touching the real repo.
import { describe, expect, it } from "vitest";

import {
  minimalCover,
  scanClientNamespaces,
} from "@/test-support/client-namespace-scanner";

describe("client-namespace-scanner engine (CMSG-02..05)", () => {
  it("collects a useTranslations literal reached through a 2-hop import from a use-client file", () => {
    const result = scanClientNamespaces({
      "components/root.tsx": `"use client";\nimport { mid } from "@/components/mid";\nexport function Root() { return mid(); }`,
      "components/mid.ts": `import { leaf } from "./leaf";\nexport const mid = () => leaf();`,
      "components/leaf.ts": `import { useTranslations } from "next-intl";\nexport function leaf() { const t = useTranslations("run.runStatus"); return t("ok"); }`,
    });

    expect(result.literals.get("run.runStatus")).toBeDefined();
    expect(result.violations).toEqual([]);
  });

  it("ignores literals used only by server code", () => {
    const result = scanClientNamespaces({
      "app/page.tsx": `import { helper } from "@/lib/server-only";\nexport default function Page() { return helper(); }`,
      "lib/server-only.ts": `import { useTranslations } from "next-intl";\nexport function helper() { return useTranslations("serverOnly"); }`,
    });

    expect([...result.literals.keys()]).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("ignores import type edges so type-only references do not pull modules into the client graph", () => {
    const result = scanClientNamespaces({
      "components/client.tsx": `"use client";\nimport type { Foo } from "@/lib/typed";\nexport type Bar = Foo;`,
      "lib/typed.ts": `import { useTranslations } from "next-intl";\nexport type Foo = string;\nexport const f = () => useTranslations("typeOnly");`,
    });

    expect([...result.literals.keys()]).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("follows next/dynamic(() => import(...)) edges into client modules", () => {
    const result = scanClientNamespaces({
      "components/host.tsx": `"use client";\nimport dynamic from "next/dynamic";\nconst Lazy = dynamic(() => import("./lazy-panel"));\nexport function Host() { return Lazy; }`,
      "components/lazy-panel.tsx": `import { useTranslations } from "next-intl";\nexport default function Lazy() { return useTranslations("studio"); }`,
    });

    expect([...result.literals.keys()]).toEqual(["studio"]);
    expect(result.violations).toEqual([]);
  });

  it("stops traversal at a use-server boundary", () => {
    const result = scanClientNamespaces({
      "components/form.tsx": `"use client";\nimport { submit } from "./actions";\nexport const onClick = () => submit();`,
      "components/actions.ts": `"use server";\nimport { helper } from "./server-helper";\nexport async function submit() { return helper(); }`,
      "components/server-helper.ts": `import { useTranslations } from "next-intl";\nexport function helper() { return useTranslations("actionServer"); }`,
    });

    expect([...result.literals.keys()]).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("CMSG-03 flags root and non-literal useTranslations calls in client code", () => {
    const result = scanClientNamespaces({
      "components/bad.tsx": `"use client";\nimport { useTranslations } from "next-intl";\nexport function Bad({ ns }: { ns: string }) {\n  const t1 = useTranslations();\n  const t2 = useTranslations(ns);\n  return [t1, t2];\n}`,
    });

    expect(result.violations.map((v) => v.kind)).toEqual([
      "root_use_translations",
      "dynamic_use_translations",
    ]);
  });

  it("CMSG-03 flags useMessages calls in client code", () => {
    const result = scanClientNamespaces({
      "components/bad.tsx": `"use client";\nimport { useMessages } from "next-intl";\nexport function Bad() { return useMessages(); }`,
    });

    expect(result.violations).toEqual([
      expect.objectContaining({
        kind: "use_messages",
        file: "components/bad.tsx",
      }),
    ]);
  });

  it("CMSG-05 flags any NextIntlClientProvider rendered outside app/layout.tsx", () => {
    const result = scanClientNamespaces({
      "app/layout.tsx": `import { NextIntlClientProvider } from "next-intl";\nexport default function Root({ children }: any) { return <NextIntlClientProvider>{children}</NextIntlClientProvider>; }`,
      "app/sub/layout.tsx": `import { NextIntlClientProvider } from "next-intl";\nexport default function Sub({ children }: any) { return <NextIntlClientProvider>{children}</NextIntlClientProvider>; }`,
    });

    expect(result.violations).toEqual([
      expect.objectContaining({
        kind: "stray_provider",
        file: "app/sub/layout.tsx",
      }),
    ]);
  });

  it("CMSG-03 flags a hook re-exported under another name, which would hide every call to it", () => {
    const result = scanClientNamespaces({
      "lib/intl-barrel.ts": `export { useTranslations as useT } from "next-intl";`,
      "components/bad.tsx": `"use client";\nimport { useT } from "@/lib/intl-barrel";\nexport function Bad() { return useT("run"); }`,
    });

    expect([...result.literals.keys()]).toEqual([]);
    expect(result.violations).toEqual([
      expect.objectContaining({
        kind: "intl_reexport",
        file: "lib/intl-barrel.ts",
      }),
    ]);
  });

  it("CMSG-03 flags a hook re-exported from a module other than next-intl", () => {
    const result = scanClientNamespaces({
      "lib/intl-barrel.ts": `export { useMessages } from "use-intl/react";`,
    });

    expect(result.violations.map((v) => v.kind)).toEqual(["intl_reexport"]);
  });

  it("CMSG-03 flags useTranslations imported from a module other than next-intl", () => {
    const result = scanClientNamespaces({
      "components/bad.tsx": `"use client";\nimport { useTranslations } from "use-intl";\nexport function Bad() { return useTranslations("run"); }`,
    });

    expect(result.violations).toEqual([
      expect.objectContaining({
        kind: "indirect_intl_import",
        file: "components/bad.tsx",
      }),
    ]);
  });

  it("CMSG-05 flags a provider re-exported under another name, which would hide every render", () => {
    const result = scanClientNamespaces({
      "lib/intl-barrel.ts": `export { NextIntlClientProvider as Provider } from "next-intl";`,
      "app/sub/layout.tsx": `import { Provider } from "@/lib/intl-barrel";\nexport default function Sub({ children }) { return <Provider>{children}</Provider>; }`,
    });

    expect(result.violations).toEqual([
      expect.objectContaining({
        kind: "intl_reexport",
        file: "lib/intl-barrel.ts",
      }),
    ]);
  });

  it("CMSG-05 flags NextIntlClientProvider imported from a module other than next-intl", () => {
    const result = scanClientNamespaces({
      "app/sub/layout.tsx": `import { NextIntlClientProvider } from "@/lib/intl-barrel";\nexport default function Sub({ children }) { return <NextIntlClientProvider>{children}</NextIntlClientProvider>; }`,
    });

    expect(result.violations.map((v) => v.kind)).toEqual([
      "stray_provider",
      "indirect_intl_import",
    ]);
  });

  it("CMSG-01 reports where the root provider's picker and namespace list were imported from", () => {
    const wired = scanClientNamespaces({
      "app/layout.tsx": `import { NextIntlClientProvider } from "next-intl";\nimport { pickMessages } from "@/i18n/pick-messages";\nimport { CLIENT_NAMESPACES } from "@/i18n/client-namespaces";\nexport default async function Root({ children }) {\n  const picked = pickMessages(await getMessages(), CLIENT_NAMESPACES);\n  return <NextIntlClientProvider messages={picked}>{children}</NextIntlClientProvider>;\n}`,
    });
    const rawCatalog = scanClientNamespaces({
      "app/layout.tsx": `import { NextIntlClientProvider } from "next-intl";\nexport default function Root({ children }) {\n  return <NextIntlClientProvider messages={{}}>{children}</NextIntlClientProvider>;\n}`,
    });

    expect(wired.rootProviders).toEqual([
      {
        pickerSource: "@/i18n/pick-messages",
        listSource: "@/i18n/client-namespaces",
      },
    ]);
    expect(rawCatalog.rootProviders).toEqual([
      { pickerSource: null, listSource: null },
    ]);
  });

  it("collects a literal from a .jsx client file", () => {
    const result = scanClientNamespaces({
      "components/plain.jsx": `"use client";\nimport { useTranslations } from "next-intl";\nexport default function Plain() {\n  return <p>{useTranslations("plain")("title")}</p>;\n}`,
    });

    expect([...result.literals.keys()]).toEqual(["plain"]);
    expect(result.violations).toEqual([]);
  });

  it("minimalCover keeps independent paths and drops paths nested under a parent namespace", () => {
    expect(
      minimalCover([
        "run",
        "run.runStatus",
        "run.terminalCause.reasons",
        "runStatus",
        "inbox.reviews",
        "inbox.reviews",
      ]),
    ).toEqual(["inbox.reviews", "run", "runStatus"]);
  });
});
