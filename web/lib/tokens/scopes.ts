import { MaisterError } from "@/lib/errors";
import {
  isTokenScope,
  TOKEN_SCOPE_ALL,
  type TokenScope,
} from "@/types/token-scopes";

export { TOKEN_SCOPE_VALUES, type TokenScope } from "@/types/token-scopes";

export function normalizeTokenScopes(scopes?: readonly string[]): TokenScope[] {
  if (!scopes || scopes.length === 0) return [TOKEN_SCOPE_ALL];

  const uniqueScopes = [...new Set(scopes)];
  const knownScopes: TokenScope[] = [];
  const unknownScopes: string[] = [];

  for (const scope of uniqueScopes) {
    if (isTokenScope(scope)) {
      knownScopes.push(scope);
    } else {
      unknownScopes.push(scope);
    }
  }

  if (unknownScopes.length > 0) {
    throw new MaisterError(
      "CONFIG",
      `unknown token scopes: ${unknownScopes.join(", ")}`,
    );
  }

  if (knownScopes.includes(TOKEN_SCOPE_ALL)) return [TOKEN_SCOPE_ALL];

  return knownScopes;
}

export function tokenHasScope(
  scopes: readonly string[],
  requiredScope: string,
): boolean {
  return scopes.includes(TOKEN_SCOPE_ALL) || scopes.includes(requiredScope);
}
