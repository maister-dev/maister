import { config } from "dotenv";

// Match Next.js env precedence for tsx-launched CLI scripts so they read the
// same .env.local as `next dev`. Order (later wins via override):
//   .env  →  .env.local  →  .env.${NODE_ENV}  →  .env.${NODE_ENV}.local
// `.env.local` is skipped in test mode, matching Next.js.
const nodeEnv = process.env.NODE_ENV ?? "development";

config({ path: ".env" });
if (nodeEnv !== "test") config({ path: ".env.local", override: true });
config({ path: `.env.${nodeEnv}`, override: true });
config({ path: `.env.${nodeEnv}.local`, override: true });
