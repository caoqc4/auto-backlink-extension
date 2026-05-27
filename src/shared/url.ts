export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function rootDomainFromUrl(value: string): string {
  try {
    const hostname = new URL(normalizeUrl(value)).hostname.toLowerCase();
    const clean = hostname.replace(/^www\./, "");
    const parts = clean.split(".");
    if (parts.length <= 2) return clean;
    const secondLevelTlds = new Set(["co.uk", "com.au", "com.cn", "co.jp", "com.br"]);
    const lastTwo = parts.slice(-2).join(".");
    if (secondLevelTlds.has(lastTwo) && parts.length >= 3) {
      return parts.slice(-3).join(".");
    }
    return lastTwo;
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

export function hostnameFromUrl(value: string): string {
  try {
    return new URL(normalizeUrl(value)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return rootDomainFromUrl(value);
  }
}

export function sameRootDomain(left: string, right: string): boolean {
  return rootDomainFromUrl(left) === rootDomainFromUrl(right);
}
