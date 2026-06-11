import { describe, expect, it } from "vitest";

import {
  shellLintDiagnostics,
  shellLintFindings,
} from "@/lib/flows/shell-lint";

function rules(source: string): string[] {
  return shellLintFindings(source).map((f) => f.rule);
}

describe("shellLintFindings — missing_shebang", () => {
  it("warns when line 1 is not a #! shebang", () => {
    const findings = shellLintFindings("echo hello\n");
    const hit = findings.find((f) => f.rule === "missing_shebang");

    expect(hit).toBeDefined();
    expect(hit?.line).toBe(1);
  });

  it("does not warn when line 1 is a shebang", () => {
    expect(rules("#!/usr/bin/env bash\nset -e\necho hi\n")).not.toContain(
      "missing_shebang",
    );
  });
});

describe("shellLintFindings — rm_rf_unquoted_var", () => {
  it("warns on rm -rf against an unquoted variable", () => {
    const source = "#!/bin/bash\nset -e\nrm -rf $TARGET/build\n";
    const hit = shellLintFindings(source).find(
      (f) => f.rule === "rm_rf_unquoted_var",
    );

    expect(hit).toBeDefined();
    expect(hit?.line).toBe(3);
  });

  it("does not warn when the rm -rf path is quoted", () => {
    const source = '#!/bin/bash\nset -e\nrm -rf "$TARGET/build"\n';

    expect(rules(source)).not.toContain("rm_rf_unquoted_var");
  });
});

describe("shellLintFindings — unquoted_var_dangerous", () => {
  it("warns on an unquoted variable inside a dangerous command", () => {
    const source = "#!/bin/bash\nset -e\ncd $WORKDIR\n";
    const hit = shellLintFindings(source).find(
      (f) => f.rule === "unquoted_var_dangerous",
    );

    expect(hit).toBeDefined();
    expect(hit?.line).toBe(3);
  });

  it("does not warn when the dangerous command's variable is quoted", () => {
    const source = '#!/bin/bash\nset -e\ncd "$WORKDIR"\n';

    expect(rules(source)).not.toContain("unquoted_var_dangerous");
  });
});

describe("shellLintFindings — quote-aware comment stripping (F4)", () => {
  it("does not treat a `#` inside a quoted string as a comment (keeps the trailing danger)", () => {
    // The in-quote `#` must NOT truncate the line — the unquoted `$EXTRA` that
    // follows is still a dangerous-command foot-gun and must be flagged.
    const source = '#!/bin/bash\nset -e\nrm -rf "keep # this" $EXTRA\n';
    const hit = shellLintFindings(source).find(
      (f) => f.rule === "rm_rf_unquoted_var",
    );

    expect(hit).toBeDefined();
    expect(hit?.line).toBe(3);
  });

  it("still strips a real (unquoted) trailing comment so its tokens are ignored", () => {
    // The `$VAR` lives only inside a real comment → no finding.
    const source = "#!/bin/bash\nset -e\necho safe # cd $VAR\n";

    expect(rules(source)).not.toContain("unquoted_var_dangerous");
  });
});

describe("shellLintFindings — legacy_backticks", () => {
  it("warns on legacy backtick command substitution", () => {
    const source = "#!/bin/bash\nset -e\nnow=`date`\n";
    const hit = shellLintFindings(source).find(
      (f) => f.rule === "legacy_backticks",
    );

    expect(hit).toBeDefined();
    expect(hit?.line).toBe(3);
  });

  it("does not warn on modern $() command substitution", () => {
    const source = "#!/bin/bash\nset -e\nnow=$(date)\n";

    expect(rules(source)).not.toContain("legacy_backticks");
  });
});

describe("shellLintFindings — missing_set_e", () => {
  it("warns when no `set -e` hint is present", () => {
    const source = "#!/bin/bash\necho building\n";
    const hit = shellLintFindings(source).find(
      (f) => f.rule === "missing_set_e",
    );

    expect(hit).toBeDefined();
    expect(hit?.line).toBe(1);
  });

  it("does not warn when `set -e` is present", () => {
    const source = "#!/bin/bash\nset -e\necho building\n";

    expect(rules(source)).not.toContain("missing_set_e");
  });

  it("recognises the combined `set -euo pipefail` form", () => {
    const source = "#!/bin/bash\nset -euo pipefail\necho building\n";

    expect(rules(source)).not.toContain("missing_set_e");
  });

  it("recognises a `-e` shebang as errexit (no missing_set_e) (F5)", () => {
    const source = "#!/bin/bash -e\necho building\n";

    expect(rules(source)).not.toContain("missing_set_e");
  });

  it("recognises a `-euo` shebang as errexit (no missing_set_e) (F5)", () => {
    const source = "#!/usr/bin/env -S bash -euo pipefail\necho building\n";

    expect(rules(source)).not.toContain("missing_set_e");
  });
});

describe("shellLintFindings — clean script", () => {
  it("returns no findings for a well-formed script", () => {
    const source = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'rm -rf "$BUILD_DIR"',
      'cd "$WORKDIR"',
      "now=$(date)",
      'echo "done at ${now}"',
      "",
    ].join("\n");

    expect(shellLintFindings(source)).toEqual([]);
  });

  it("returns an array of findings carrying a line and a rule", () => {
    const findings = shellLintFindings("echo hi\n");

    for (const finding of findings) {
      expect(typeof finding.line).toBe("number");
      expect(typeof finding.rule).toBe("string");
      expect(typeof finding.message).toBe("string");
    }
  });
});

describe("shellLintDiagnostics — CodeMirror mapping", () => {
  it("maps every finding to a warning-severity char-offset diagnostic", () => {
    const source = "#!/bin/bash\nset -e\nrm -rf $TARGET\n";
    const diagnostics = shellLintDiagnostics(source);
    const findings = shellLintFindings(source);

    expect(diagnostics).toHaveLength(findings.length);
    expect(diagnostics.length).toBeGreaterThan(0);

    for (const diagnostic of diagnostics) {
      expect(diagnostic.severity).toBe("warning");
      expect(diagnostic.from).toBeGreaterThanOrEqual(0);
      expect(diagnostic.to).toBeGreaterThanOrEqual(diagnostic.from);
      expect(diagnostic.to).toBeLessThanOrEqual(source.length);
    }
  });

  it("anchors a line-3 finding past the first two newlines", () => {
    const source = "#!/bin/bash\nset -e\nrm -rf $TARGET\n";
    const rmDiag = shellLintDiagnostics(source).find((d) =>
      d.message.includes("rm -rf"),
    );

    // offset of the start of line 3 = len("#!/bin/bash\n") + len("set -e\n")
    expect(rmDiag?.from).toBe("#!/bin/bash\n".length + "set -e\n".length);
  });

  it("returns no diagnostics for a clean script", () => {
    const source = '#!/bin/bash\nset -euo pipefail\nrm -rf "$BUILD"\n';

    expect(shellLintDiagnostics(source)).toEqual([]);
  });
});
