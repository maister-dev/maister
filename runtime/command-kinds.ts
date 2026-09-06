export const COMMAND_KINDS = [
  "workspace.adopt",
  "workspace.release",
  "session.create",
  "session.prompt",
  "session.input",
  "session.cancel",
  "session.checkpoint",
  "session.delete",
  "runtime_object.reserve",
  "runtime_object.upload",
  "runtime_object.delete",
] as const;

export type CommandKind = (typeof COMMAND_KINDS)[number];
