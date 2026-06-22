export function isScratchTranscriptClearCommand(prompt: string): boolean {
  return prompt.trim() === "/clear";
}
