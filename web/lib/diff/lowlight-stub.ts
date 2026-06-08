// FINDING G (ADR-066): a no-grammar replacement for `@git-diff-view/lowlight`,
// wired via `turbopack.resolveAlias` in next.config.mjs. The real package
// statically imports `lowlight` + `highlight.js` with ALL grammars (~hundreds of
// KB), and `@git-diff-view/core` references its `highlighter` export inside
// `DiffFile`, so it cannot be tree-shaken — it would ship to the diff client
// chunk. We never invoke lowlight: the syntax bundle is built SERVER-SIDE with
// Shiki (`lib/diff/shiki-adapter.ts`) as a FULL bundle and hydrated on the
// client with `diffViewHighlight={true}` + NO `registerHighlighter`, so
// git-diff-view's `initSyntax()` early-return restores the already-merged
// syntax WITHOUT running any highlighter (the engine below stays inert).
// This stub keeps the two pure exports the lib
// actually uses (`processAST` is a hast tree-walker with no highlight.js
// dependency; the server diff-prep imports it through `@git-diff-view/react`)
// and replaces the highlighter engine with inert no-ops.

// Mirrors `@git-diff-view`'s loosely-typed hast walker node; the real `.d.ts`
// (not this stub) drives type-checking — this only feeds the bundler.
type AnyNode = {
  type?: string;
  value?: string;
  children?: AnyNode[];
  startIndex?: number;
  endIndex?: number;
  lineNumber?: number;
};

type SyntaxItem = {
  value: string;
  lineNumber: number;
  valueLength: number;
  nodeList: { node: AnyNode; wrapper?: AnyNode }[];
};

// Verbatim port of `@git-diff-view/lowlight`'s `processAST` (the pure part) —
// splits a highlighted hast Root into per-line syntax objects. No highlight.js.
export const processAST = (ast: {
  children: AnyNode[];
}): {
  syntaxFileObject: Record<number, SyntaxItem>;
  syntaxFileLineNumber: number;
} => {
  let lineNumber = 1;
  const syntaxObj: Record<number, SyntaxItem> = {};
  const loopAST = (nodes: AnyNode[], wrapper?: AnyNode): void => {
    nodes.forEach((node) => {
      if (node.type === "text") {
        const value = node.value ?? "";

        if (value.indexOf("\n") === -1) {
          const valueLength = value.length;

          if (!syntaxObj[lineNumber]) {
            node.startIndex = 0;
            node.endIndex = valueLength - 1;
            syntaxObj[lineNumber] = {
              value,
              lineNumber,
              valueLength,
              nodeList: [{ node, wrapper }],
            };
          } else {
            node.startIndex = syntaxObj[lineNumber].valueLength;
            node.endIndex = node.startIndex + valueLength - 1;
            syntaxObj[lineNumber].value += value;
            syntaxObj[lineNumber].valueLength += valueLength;
            syntaxObj[lineNumber].nodeList.push({ node, wrapper });
          }
          node.lineNumber = lineNumber;

          return;
        }
        const lines = value.split("\n");

        node.children = node.children || [];
        for (let i = 0; i < lines.length; i++) {
          const _value = i === lines.length - 1 ? lines[i] : lines[i] + "\n";
          const _lineNumber = i === 0 ? lineNumber : ++lineNumber;
          const _valueLength = _value.length;
          const _node: AnyNode = {
            type: "text",
            value: _value,
            startIndex: Infinity,
            endIndex: Infinity,
            lineNumber: _lineNumber,
          };

          if (!syntaxObj[_lineNumber]) {
            _node.startIndex = 0;
            _node.endIndex = _valueLength - 1;
            syntaxObj[_lineNumber] = {
              value: _value,
              lineNumber: _lineNumber,
              valueLength: _valueLength,
              nodeList: [{ node: _node, wrapper }],
            };
          } else {
            _node.startIndex = syntaxObj[_lineNumber].valueLength;
            _node.endIndex = _node.startIndex + _valueLength - 1;
            syntaxObj[_lineNumber].value += _value;
            syntaxObj[_lineNumber].valueLength += _valueLength;
            syntaxObj[_lineNumber].nodeList.push({ node: _node, wrapper });
          }
          node.children.push(_node);
        }
        node.lineNumber = lineNumber;

        return;
      }
      if (node.children) {
        loopAST(node.children, node);
        node.lineNumber = lineNumber;
      }
    });
  };

  loopAST(ast.children);

  return { syntaxFileObject: syntaxObj, syntaxFileLineNumber: lineNumber };
};

export function _getAST(): Record<string, never> {
  return {};
}

let maxLineToIgnoreSyntax = 2000;
let ignoreSyntaxHighlightList: (string | RegExp)[] = [];

// The default DiffHighlighter that `@git-diff-view/core` falls back to. It is
// never exercised here (Shiki builds the bundle server-side; the client renders
// the pre-merged syntax via `initSyntax()`'s early-return, no highlighter), so
// the engine methods are inert.
export const highlighter = {
  name: "lowlight",
  type: "class" as const,
  get maxLineToIgnoreSyntax(): number {
    return maxLineToIgnoreSyntax;
  },
  setMaxLineToIgnoreSyntax: (v: number): void => {
    maxLineToIgnoreSyntax = v;
  },
  get ignoreSyntaxHighlightList(): (string | RegExp)[] {
    return ignoreSyntaxHighlightList;
  },
  setIgnoreSyntaxHighlightList: (v: (string | RegExp)[]): void => {
    ignoreSyntaxHighlightList = v;
  },
  getAST: (): undefined => undefined,
  processAST,
  hasRegisteredCurrentLang: (): boolean => false,
  getHighlighterEngine: (): undefined => undefined,
};

export const versions = "0.1.5";
