import { registerHooks } from "node:module";

import { resolve } from "./_server-only-shim.mjs";

registerHooks({ resolve });
