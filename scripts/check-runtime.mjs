import { assertSupportedNode } from "../runtime/node-version.ts";

assertSupportedNode(process.versions.node);
process.stdout.write(`MAIster runtime: Node ${process.versions.node}\n`);
