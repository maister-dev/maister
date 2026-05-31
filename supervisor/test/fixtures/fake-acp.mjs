#!/usr/bin/env node
// Minimal ACP-binary stand-in for tests.
// Flags:
//   --lines <N>         emit N JSONL lines on stdout (default 3)
//   --exit-code <N>     exit with code N (default 0)
//   --hang              keep stdin open and never exit (use SIGTERM to stop)
//   --resume <id>       echo the resume marker as the first line
//   --emit-usage        include a `usage` block in the last line
//   --giant-bytes <N>   emit a single line of N raw bytes with NO trailing newline (overflow test)
//   --echo-env <NAME>   emit the named environment variable as the first line
const args = process.argv.slice(2);
let lines = 3;
let exitCode = 0;
let hang = false;
let resume = null;
let emitUsage = false;
let giantBytes = 0;
let echoEnv = null;

for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--lines") {
    lines = Number.parseInt(args[++i], 10);
  } else if (a === "--exit-code") {
    exitCode = Number.parseInt(args[++i], 10);
  } else if (a === "--hang") {
    hang = true;
  } else if (a === "--resume") {
    resume = args[++i];
  } else if (a === "--emit-usage") {
    emitUsage = true;
  } else if (a === "--giant-bytes") {
    giantBytes = Number.parseInt(args[++i], 10);
  } else if (a === "--echo-env") {
    echoEnv = args[++i];
  }
}

if (giantBytes > 0) {
  process.stdout.write("x".repeat(giantBytes));
  process.exit(exitCode);
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (resume) {
  emit({ type: "resumed", sessionId: resume });
}

if (echoEnv) {
  emit({ type: "env", name: echoEnv, value: process.env[echoEnv] ?? null });
}

for (let i = 0; i < lines; i += 1) {
  const isLast = i === lines - 1;
  emit({
    type: "agent_message_chunk",
    index: i,
    text: `line ${i}`,
    ...(isLast && emitUsage
      ? {
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 100,
            output_tokens: 200,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 0,
          },
        }
      : {}),
  });
}

if (hang) {
  process.stdin.resume();
  process.on("SIGTERM", () => process.exit(143));
} else {
  process.exit(exitCode);
}
