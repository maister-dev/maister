// Next otherwise gives its dev child half of the host's RAM for JavaScript
// alone, leaving Turbopack's native allocations, Postgres and agents unbudgeted.
// Keep operator NODE_OPTIONS (including an explicit heap budget) authoritative.
const nodeOptions = process.env.NODE_OPTIONS ?? "";

if (!/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s|$)/u.test(nodeOptions)) {
  process.env.NODE_OPTIONS = `--max-old-space-size=1024 ${nodeOptions}`.trim();
}

// Use Next's CLI in this process so its argument handling, signals and child
// restart lifecycle stay intact; this launcher adds no supervising process.
process.argv.splice(2, 0, "dev");
await import("next/dist/bin/next");
