/** Extract only semantic assistant text from an ACP session update. */
export function agentMessageText(update: unknown): string | null {
  if (
    typeof update !== "object" ||
    update === null ||
    !("sessionUpdate" in update) ||
    update.sessionUpdate !== "agent_message_chunk" ||
    !("content" in update)
  )
    return null;
  const content = update.content;

  if (
    typeof content !== "object" ||
    content === null ||
    !("type" in content) ||
    content.type !== "text" ||
    !("text" in content)
  )
    return null;

  return typeof content.text === "string" ? content.text : null;
}
