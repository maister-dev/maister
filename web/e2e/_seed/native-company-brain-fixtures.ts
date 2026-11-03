import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

const nativeFixturesSchema = z.object({
  adminEmail: z.string().email(),
  adminPassword: z.string().min(1),
  users: z.object({
    admin: z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      password: z.string().min(1),
      name: z.string().min(1),
    }),
  }),
  byKey: z.object({
    scratch: z.object({
      projectId: z.string().uuid(),
      projectSlug: z.string().min(1),
      repoPath: z.string().min(1),
      runnerId: z.string().min(1),
      flowId: z.string().uuid(),
    }),
  }),
});

export function loadNativeCompanyBrainFixtures(): z.infer<
  typeof nativeFixturesSchema
> {
  return nativeFixturesSchema.parse(
    JSON.parse(readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8")),
  );
}
