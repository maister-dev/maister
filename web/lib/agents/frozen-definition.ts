import "server-only";

import type { ParsedAgentDefinition } from "./definition";

import { z } from "zod";

import { agentDefinitionSha256 } from "./activity-snapshot";
import { parseAgentDefinition, renderAgentDefinition } from "./definition";

/** Validate retained role structure without consulting a mutable catalog or changing its bytes. */
export const frozenAgentDefinitionSchema = z.custom<ParsedAgentDefinition>(
  (value) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("id" in value) ||
      typeof value.id !== "string"
    )
      return false;
    try {
      const definition = value as ParsedAgentDefinition;
      const parsed = parseAgentDefinition(
        value.id,
        renderAgentDefinition(definition),
      );

      return (
        agentDefinitionSha256(parsed) ===
        agentDefinitionSha256({
          ...definition,
          // Rendering appends one final newline; retained prompt bytes need not have one.
          prompt: definition.prompt.endsWith("\n")
            ? definition.prompt
            : `${definition.prompt}\n`,
        })
      );
    } catch {
      return false;
    }
  },
);
