export type TemplateDefaultExpression = {
  path: string;
  literal: string;
};

export type QuotedTemplateLiteral = {
  literal: string;
  end: number;
};

export const TEMPLATE_PATH_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export function findMustacheClose(template: string, start: number): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = start + 2; index < template.length - 1; index += 1) {
    const char = template[index];

    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "}" && template[index + 1] === "}") return index;
  }

  return -1;
}

export function readQuotedLiteral(input: string): QuotedTemplateLiteral | null {
  const quote = input[0];

  if (quote !== "'" && quote !== '"') return null;

  let literal = "";
  let escaped = false;

  for (let index = 1; index < input.length; index += 1) {
    const char = input[index];

    if (escaped) {
      if (char === "n") literal += "\n";
      else if (char === "r") literal += "\r";
      else if (char === "t") literal += "\t";
      else literal += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === quote) return { literal, end: index + 1 };

    literal += char;
  }

  return null;
}

export function parseDefaultExpression(
  tag: string,
): TemplateDefaultExpression | null {
  const match = tag.match(/^([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\?\?\s*/);

  if (!match) return null;

  const literalInput = tag.slice(match[0].length);
  const parsed = readQuotedLiteral(literalInput);

  if (!parsed) return null;
  if (literalInput.slice(parsed.end).trim() !== "") return null;

  return {
    path: match[1],
    literal: parsed.literal,
  };
}
