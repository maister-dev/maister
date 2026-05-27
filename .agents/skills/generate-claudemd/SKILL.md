---
name: generate-claudemd
description: "Generate project-specific AGENTS.md from repo analysis."
user-invocable: false
command: /generate-claudemd
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Glob
  - Skill
routing:
  triggers:
    - generate AGENTS.md
    - create AGENTS.md
    - init AGENTS.md
    - bootstrap AGENTS.md
    - make AGENTS.md
  pairs_with:
    - go-patterns
    - codebase-overview
  complexity: Medium
  category: documentation
---

# Generate AGENTS.md Skill

Produce a project-specific AGENTS.md through a 4-phase pipeline: SCAN repo facts, DETECT domain enrichment, GENERATE from template, VALIDATE output. The goal is a AGENTS.md that makes new Codex sessions immediately productive by documenting only verified, project-specific facts.

This skill generates new AGENTS.md files. It cannot improve an existing one (use `Codex-md-improver` for that), cannot document private dependencies or encrypted configs it cannot read, cannot infer runtime behavior from static files, and cannot replace deep domain expertise — enrichment patterns are templates, not knowledge.

This skill does not use `context: fork` because it requires interactive user gates (confirmation when AGENTS.md already exists, review of generated output), which a forked context would bypass.

## Reference Loading Table

| Signal | Load These Files | Why |
|---|---|---|
| tasks related to this reference | `CLAUDEMD_TEMPLATE.md` | Loads detailed guidance from `CLAUDEMD_TEMPLATE.md`. |
| example-driven tasks, errors | `examples-and-errors.md` | Loads detailed guidance from `examples-and-errors.md`. |

## Instructions

Execute all phases sequentially. Verify each gate before advancing. Load the template from `${CLAUDE_SKILL_DIR}/references/CLAUDEMD_TEMPLATE.md` before Phase 3.

On explicit user request, two optional modes are available:
- **Subdirectory AGENTS.md**: Generate per-package AGENTS.md files for monorepos.
- **Minimal Mode** ("minimal AGENTS.md"): Only 3 sections — Overview, Commands, Architecture.

> See `references/examples-and-errors.md` for worked examples by language and the complete language indicator table.

### Phase 1: SCAN

**Goal**: Gather facts about the repository — language, build system, directory structure, test patterns, config approach.

**Step 1: Check for existing AGENTS.md**

```bash
ls -la AGENTS.md .Codex/AGENTS.md 2>/dev/null
```

If a AGENTS.md already exists, write output to `AGENTS.md.generated` and show a diff, because overwriting a hand-tuned AGENTS.md destroys work. Inform the user: "AGENTS.md already exists. Output will be written to AGENTS.md.generated so you can compare." Continue with all phases — the generated file is still useful for comparison.

If no AGENTS.md exists, set output path to `AGENTS.md`.

**Step 2: Detect language and framework**

Check root directory for language indicators (see `references/examples-and-errors.md` for the full indicator table).

Read the detected config file to extract: project name, dependencies, language version. Do not assume standard language patterns apply — read actual source files before writing any section, because conventions vary even within the same language ecosystem.

For Go projects:
```bash
head -5 go.mod
```

For Node.js projects:
```bash
cat package.json | head -30
```

**Step 3: Parse build system**

Parse the Makefile (or equivalent) for actual build targets rather than guessing commands, because the Makefile IS the source of truth for build commands in most repos and may wrap tools with flags, coverage, or race detection that raw invocations would miss.

```bash
ls Makefile makefile GNUmakefile 2>/dev/null
grep -E '^[a-zA-Z_-]+:' Makefile 2>/dev/null | head -20
```

Also check for: `package.json` scripts section, `Taskfile.yml`, `justfile`, CI config (`.github/workflows/`, `.gitlab-ci.yml`).

Record: build command, test command, lint command, "check everything" command. If no build system is found at all, document the gap rather than inventing commands.

**Step 4: Map directory structure**

```bash
ls -d */ 2>/dev/null
# Go projects:
ls internal/ cmd/ pkg/ 2>/dev/null
```

Categorize directories by role (source, test, config, docs, build, vendor).

**Step 5: Find test patterns**

```bash
ls *_test.go 2>/dev/null | head -5          # Go
ls *.test.ts *.test.js 2>/dev/null | head -5 # Node.js
ls test_*.py *_test.py 2>/dev/null | head -5 # Python
```

Read 1-2 representative test files to identify: test framework, assertion library, mocking approach, naming conventions.

**Step 6: Detect configuration approach**

```bash
ls .env.example .env.sample 2>/dev/null
ls config.yaml config.json *.toml *.ini 2>/dev/null
grep -r 'os.Getenv\|flag\.\|viper\.\|envconfig' --include='*.go' -l 2>/dev/null | head -5
```

**Step 7: Detect code style tooling**

```bash
ls .golangci.yml .eslintrc* .prettierrc* .flake8 pyproject.toml .editorconfig 2>/dev/null
```

If a linter config exists, read it to extract key rules.

**Step 8: Check for license headers**

```bash
grep -r 'SPDX-License-Identifier' --include='*.go' --include='*.py' --include='*.ts' -l 2>/dev/null | head -3
```

If found, note the license type and header convention.

**GATE**: Language detected. Build targets identified. Directory structure mapped. Test patterns found (or noted as absent). Config approach documented. Proceed ONLY when gate passes.

---

### Phase 2: DETECT

**Goal**: Identify domain-specific enrichment sources based on repo characteristics. Auto-detect the repo domain and load domain-specific patterns (sapcc Go conventions, OpenStack patterns, etc.) because generic language knowledge is insufficient for project-specific AGENTS.md generation.

**Step 1: Check for sapcc domain (Go repos)**

If Go project detected:
```bash
grep -i 'sapcc\|sap-' go.mod 2>/dev/null
grep -r 'github.com/sapcc' --include='*.go' -l 2>/dev/null | head -5
```

If sapcc imports found, load enrichment from `go-patterns` skill patterns:
- Anti-over-engineering principles
- Error wrapping conventions (`fmt.Errorf("...: %w", err)`)
- `must.Return` scope rules
- Testing patterns (table-driven tests, assertion libraries)
- Makefile management via `go-makefile-maker`

**Step 2: Check for OpenStack/Gophercloud**

```bash
grep -i 'gophercloud\|openstack' go.mod 2>/dev/null
grep -r 'gophercloud' --include='*.go' -l 2>/dev/null | head -5
```

If found, note OpenStack API patterns, Keystone auth, and endpoint catalog usage.

**Step 3: Detect database drivers**

```bash
grep -E 'database/sql|pgx|gorm|sqlx|ent' go.mod 2>/dev/null
grep -E '"pg"|"mysql"|"prisma"|"typeorm"|"knex"|"drizzle"' package.json 2>/dev/null
grep -E 'sqlalchemy|django|psycopg|asyncpg' pyproject.toml requirements.txt 2>/dev/null
```

If found, plan to include Database Patterns section.

**Step 4: Detect API frameworks**

```bash
grep -E 'gorilla/mux|gin-gonic|chi|echo|fiber|go-swagger' go.mod 2>/dev/null
grep -E '"express"|"fastify"|"koa"|"hono"|"next"' package.json 2>/dev/null
grep -E 'fastapi|flask|django|starlette' pyproject.toml requirements.txt 2>/dev/null
```

If found, plan to include API Patterns section.

**Step 5: Build enrichment plan**

```
Enrichment Plan:
- [ ] sapcc Go conventions (if sapcc imports detected)
- [ ] OpenStack/Gophercloud patterns (if gophercloud detected)
- [ ] Error Handling section (if Go, Rust, or explicit error patterns)
- [ ] Database Patterns section (if DB driver detected)
- [ ] API Patterns section (if API framework detected)
- [ ] Configuration section (if non-trivial config detected)
```

**GATE**: Enrichment sources identified. Domain-specific patterns loaded (or explicitly noted as not applicable). Enrichment plan documented. Proceed ONLY when gate passes.

---

### Phase 3: GENERATE

**Goal**: Load template, fill sections from scan results and enrichment, write AGENTS.md. Every section must be derived from actual repo analysis because guessed content wastes the context window and teaches Codex wrong patterns.

**Step 1: Load template**

Read `${CLAUDE_SKILL_DIR}/references/CLAUDEMD_TEMPLATE.md` for the output structure. Follow its structure exactly because consistent structure means Codex sessions can parse AGENTS.md predictably across projects.

**Step 2: Fill required sections**

Fill all 6 required sections from Phase 1 scan results. Every section must be derived from actual repo analysis — no guesses, no fabricated content.

> See `references/examples-and-errors.md` (Phase 3: Section Descriptions) for the full per-section rules, optional section guidelines, and banned generic phrases list.

**Step 3: Fill optional sections**

Based on the Phase 2 enrichment plan, fill applicable optional sections. Optional sections without evidence are worse than omitted sections.

**Step 4: Apply domain enrichment**

> See `references/examples-and-errors.md` (Sapcc Go Enrichment) for the patterns to integrate into Code Style, Testing Conventions, and Common Pitfalls sections when sapcc imports were detected in Phase 2.

**Step 5: Write output**

Write the completed AGENTS.md (or AGENTS.md.generated) to the output path determined in Phase 1 Step 1. Verify every path mentioned in the output exists and every command is runnable before writing, because a AGENTS.md with broken paths is worse than no AGENTS.md — it teaches Codex to trust wrong information.

If writing to `AGENTS.md.generated`, show the user a summary diff:
```bash
diff AGENTS.md AGENTS.md.generated 2>/dev/null || echo "New file created"
```

**GATE**: AGENTS.md written. All required sections populated with project-specific content (no placeholders). Optional sections populated based on enrichment plan. Output path is correct. Proceed ONLY when gate passes.

---

### Phase 4: VALIDATE

**Goal**: Verify the generated AGENTS.md is accurate, complete, and free of generic filler.

**Step 1: Verify all paths exist**

Extract every file path and directory path mentioned in the generated AGENTS.md. Check each one with `test -e` because one broken path undermines the entire document:

```bash
test -e "<path>" && echo "OK: <path>" || echo "MISSING: <path>"
```

If any path is missing, fix or remove the reference.

**Step 2: Verify all commands parse**

```bash
which <tool> 2>/dev/null || echo "MISSING: <tool>"
grep -q '^<target>:' Makefile 2>/dev/null || echo "MISSING TARGET: <target>"
```

**Step 3: Check for remaining placeholders**

```bash
grep -E '\{[^}]+\}|TODO|FIXME|TBD|PLACEHOLDER' <output_file>
```

If any placeholders remain, fill them from repo analysis or remove the containing section.

**Step 4: Check for generic filler**

> See `references/examples-and-errors.md` for the banned generic phrases list. Search for each phrase; remove or replace any found.

**Step 5: Report summary**

Display the validation report from `references/examples-and-errors.md` (Phase 4 Validation Report Template).

**GATE**: All paths resolve. All commands verified. No placeholders remain. No generic filler detected. Validation report displayed.

---

## References

### Reference Files

- `${CLAUDE_SKILL_DIR}/references/CLAUDEMD_TEMPLATE.md`: Template structure for generated AGENTS.md files with required and optional sections
- `${CLAUDE_SKILL_DIR}/references/examples-and-errors.md`: Worked examples by language/scenario, error handling, language indicator table, banned generic phrases
- Official Anthropic `Codex-md-management:Codex-md-improver`: Companion skill for improving existing AGENTS.md files (use after generation for refinement)

### Companion Skills

- `go-patterns`: Domain-specific patterns for sapcc Go repositories (loaded during Phase 2 enrichment)
- `codebase-overview`: Deeper codebase exploration when AGENTS.md generation needs more architectural context
