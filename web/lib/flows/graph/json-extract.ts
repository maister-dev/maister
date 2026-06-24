// Extract every top-level brace-balanced `{...}` substring, string-aware (so
// braces inside string literals do not break balancing). Linear O(n), no regex
// backtracking, and captures objects with nested objects.
export function extractBalancedJsonObjects(input: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(input.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}
