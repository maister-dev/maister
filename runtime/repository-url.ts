export type Provider = "github" | "gitlab" | "gitea" | "gitverse" | "generic";

// Extract the host from both scp-like (git@host:org/repo) and URL forms.
export function parseHost(url: string): string | null {
  const scp = /^[^/@]+@([^/:]+):/.exec(url);

  if (scp) return scp[1].toLowerCase();

  const schemed = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)/i.exec(url);

  if (schemed) return schemed[1].toLowerCase();

  return null;
}

export function detectProvider(url: string): Provider {
  const host = parseHost(url);

  if (!host) return "generic";

  if (host === "github.com") return "github";
  if (host.includes("gitlab")) return "gitlab";
  if (host === "gitverse.ru") return "gitverse";
  if (host.includes("gitea")) return "gitea";

  return "generic";
}

// Strip `://user:password@` credentials from anywhere in the string — git
// stderr embeds the full URL mid-message, so this must NOT be anchored.
export function redactUrl(url: string): string {
  return url.replace(
    /([a-z][a-z0-9+.-]*:\/\/[^/:@\s]+):[^/@\s]*@/gi,
    "$1:***@",
  );
}
