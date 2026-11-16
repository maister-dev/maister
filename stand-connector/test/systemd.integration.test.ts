import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSystemdDriver } from "../src/systemd.ts";

test("IT-CBO-06 bounds the service manager interface and sanitizes its journal output", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "maister-stand-systemd-"));
  const systemctl = join(directory, "systemctl");
  const journalctl = join(directory, "journalctl");

  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    systemctl,
    `#!/bin/sh
case "$*" in
  '--system --no-pager show --property=Id --property=LoadState --property=ActiveState --property=InvocationID -- fixture.service')
    printf 'Id=fixture.service\\nLoadState=loaded\\nActiveState=active\\nInvocationID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;
  '--system --no-pager --all show --property=Id --property=Job -- fixture.service')
    printf 'Id=fixture.service\\nJob=\\n' ;;
  '--system --no-pager --job-mode=fail restart -- fixture.service') exit 0 ;;
  *) exit 17 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(
    journalctl,
    `#!/bin/sh
test "$*" = '--system --no-pager --quiet --output=cat --since=-10min --lines=200 --unit=fixture.service' || exit 17
printf 'running at /home/private/dir password=secret\\nAuthorization: Bearer abcd.efgh\\nlocal-secret\\n'
`,
    { mode: 0o700 },
  );
  const driver = createSystemdDriver({ systemctl, journalctl }, [
    "local-secret",
  ]);
  const component = {
    scope: "system",
    user: null,
    unit: "fixture.service",
  } as const;

  assert.deepEqual(await driver.inspect(component), {
    state: "active",
    invocationId: "a".repeat(32),
  });
  assert.equal(await driver.restart(component), "received");
  await driver.requireQuiescent?.(component);
  const logs = await driver.logs(component);

  assert.match(logs.text, /running at \[redacted\]/);
  assert.doesNotMatch(
    logs.text,
    /private\/dir|abcd\.efgh|password=secret|local-secret/,
  );
  await assert.rejects(driver.inspect({ ...component, unit: "--help" }), {
    reason: "unsupported_config",
  });
});
