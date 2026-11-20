import "server-only";

import { projectMemoryIndex } from "@/lib/agent-memory-vault/index-route";

export const GET = projectMemoryIndex("tags");
