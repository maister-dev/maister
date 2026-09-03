import pino from "pino";
import { describe, expect, it } from "vitest";

import { buildRegisterRoutesOptions } from "../main";

const silentLogger = pino({ level: "silent" });

describe("buildRegisterRoutesOptions", () => {
  it("wires the production model-catalog registry", () => {
    const opts = buildRegisterRoutesOptions({
      app: {} as never,
      registry: {} as never,
      logger: silentLogger,
      runtimeRoot: "/tmp/main-wiring-test",
      killGraceMs: 5_000,
    });

    expect(opts.modelCatalog?.registry).toBeDefined();
  });
});
