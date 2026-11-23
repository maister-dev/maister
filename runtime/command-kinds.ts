export const COMMAND_KINDS = [
  "workspace.adopt",
  "workspace.prepare",
  "workspace.release",
  "workspace.observe_head",
  "workspace.publication",
  "session.create",
  "session.prompt",
  "session.input",
  "session.steer",
  "session.cancel",
  "session.checkpoint",
  "session.delete",
  "runtime_object.reserve",
  "runtime_object.upload",
  "runtime_object.delete",
  "stand.dispatch",
] as const;

export type CommandKind = (typeof COMMAND_KINDS)[number];
