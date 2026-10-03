import { closeSync, readSync, writeSync } from "node:fs";

writeSync(3, `${process.pid}\n`);
const acknowledgement = Buffer.alloc(1);
const received = readSync(3, acknowledgement, 0, 1, null);

closeSync(3);
if (received !== 1 || acknowledgement[0] !== 1)
  throw new Error("isolation application identity acknowledgement was lost");
