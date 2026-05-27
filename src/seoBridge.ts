type SeoProvider = "ahrefs" | "semrush" | "page";

export {};

declare global {
  interface Window {
    __backlinkForgeSeoBridgeInstalled?: boolean;
  }
}

if (!window.__backlinkForgeSeoBridgeInstalled) {
  window.__backlinkForgeSeoBridgeInstalled = true;
  installSeoBridge();
}

function installSeoBridge() {
  const provider = providerFromHost(location.hostname);
  if (provider === "page") return;

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const requestUrl = requestUrlFromFetchInput(input);
    const requestBody = init?.body || requestBodyFromFetchInput(input);
    const response = await Reflect.apply(originalFetch, this, Array.from(arguments));
    if (shouldCaptureSeoResult(provider, requestUrl)) {
      response.clone().text().then((text: string) => publishSeoResult(provider, requestUrl, requestBody, text)).catch(() => undefined);
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(_method: string, url: string | URL) {
    (this as XMLHttpRequest & { __backlinkForgeUrl?: string }).__backlinkForgeUrl = String(url);
    return Reflect.apply(originalOpen, this, Array.from(arguments));
  };
  XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null) {
    const xhr = this as XMLHttpRequest & { __backlinkForgeUrl?: string; __backlinkForgeBody?: unknown };
    xhr.__backlinkForgeBody = body;
    this.addEventListener("load", () => {
      const requestUrl = xhr.__backlinkForgeUrl || "";
      if (!shouldCaptureSeoResult(provider, requestUrl)) return;
      try {
        publishSeoResult(provider, requestUrl, xhr.__backlinkForgeBody, String(xhr.responseText || ""));
      } catch {
        // Binary or protected response, ignore.
      }
    });
    return Reflect.apply(originalSend, this, Array.from(arguments));
  };
}

function providerFromHost(hostname: string): SeoProvider {
  if (/(\.|^)ahrefs\.com$/i.test(hostname)) return "ahrefs";
  if (/(\.|^)semrush\.com$/i.test(hostname)) return "semrush";
  return "page";
}

function shouldCaptureSeoResult(provider: SeoProvider, url: string) {
  const cleanUrl = String(url || "");
  if (provider === "ahrefs") {
    return /\/v4\/.*stGetFreeBacklinks(Overview|List)/i.test(cleanUrl) || /stGetFreeBacklinks(Overview|List)/i.test(cleanUrl);
  }
  if (provider === "semrush") {
    return /backlinks|refdomains|analytics\/backlinks/i.test(cleanUrl);
  }
  return false;
}

function publishSeoResult(provider: SeoProvider, requestUrl: string, requestBody: unknown, responseText: string) {
  if (!responseText || responseText.length < 2) return;
  window.postMessage({
    source: "backlink-forge-seo-result",
    payload: {
      provider,
      pageUrl: location.href,
      requestUrl,
      requestBody: bodyToText(requestBody),
      responseText: responseText.slice(0, 2_000_000),
      capturedAt: new Date().toISOString()
    }
  }, "*");
}

function requestUrlFromFetchInput(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestBodyFromFetchInput(input: RequestInfo | URL) {
  return typeof input !== "string" && !(input instanceof URL) ? input.body : "";
}

function bodyToText(body: unknown) {
  if (!body) return "";
  if (typeof body === "string") return body.slice(0, 20000);
  try {
    return JSON.stringify(body).slice(0, 20000);
  } catch {
    return "";
  }
}
