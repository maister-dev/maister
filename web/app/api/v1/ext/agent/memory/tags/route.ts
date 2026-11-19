import "server-only";

import { executionMemoryIndex } from "@/lib/agent-memory-vault/index-route";

export const GET = executionMemoryIndex("tags");
