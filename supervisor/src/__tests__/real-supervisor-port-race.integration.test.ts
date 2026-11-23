import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";

import { expect, it, vi } from "vitest";

import {
  startRealSupervisor,
  type RealSupervisor,
} from "./_fixtures/real-supervisor";

it("reallocates a raced fixture port without adopting a competing supervisor's health response", async () => {
  const foreignHealth = {
    host: { hostKey: "some-other-supervisor", bootId: "other-boot" },
  };
  const competing = createServer((_req, res) =>
    res.end(JSON.stringify(foreignHealth)),
  );
  const listening = once(competing, "listening");

  competing.listen(0, "0.0.0.0");
  await listening;
  const address = competing.address();

  if (!address || typeof address === "string")
    throw new Error("Expected a TCP port");
  const competingUrl = `http://127.0.0.1:${address.port}`;
  const allocation = vi
    .spyOn(net.Server.prototype, "address")
    .mockReturnValueOnce(address);
  let supervisor: RealSupervisor | undefined;

  try {
    supervisor = await startRealSupervisor();
    if (supervisor.url === competingUrl) await supervisor.exited;
    expect(supervisor.url).not.toBe(competingUrl);
    const health = await (await fetch(`${supervisor.url}/health`)).json();

    expect(health).toMatchObject({
      host: { hostKey: expect.any(String), bootId: expect.any(String) },
    });
    expect(health).not.toMatchObject(foreignHealth);
    expect(await (await fetch(`${competingUrl}/health`)).json()).toEqual(
      foreignHealth,
    );
  } finally {
    allocation.mockRestore();
    try {
      await supervisor?.stop();
    } finally {
      await new Promise<void>((resolve, reject) => {
        competing.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}, 30_000);
