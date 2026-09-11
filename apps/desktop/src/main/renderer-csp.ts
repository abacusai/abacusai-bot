// The renderer CSP, also served as a response header (not only the <meta> in
// renderer/index.html) so it covers workers/navigations a meta tag misses. Keep
// in sync with that <meta>.
export const RENDERER_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; media-src 'self' blob: data:; " +
  "img-src 'self' blob: data:; connect-src 'self' data:;";

interface HeadersReceivedDetails {
  resourceType: string;
  url: string;
  responseHeaders?: Record<string, string[]>;
}

// Applied only to app:// main-frame documents (the experience renderer, our own
// UI); connectors/browser (https) and the visualizer (data:) share the session
// but keep their own policies, so they pass through unchanged.
export const rendererCspHeaders = (
  details: HeadersReceivedDetails
): Record<string, string[]> | undefined => {
  if (
    details.resourceType !== "mainFrame" ||
    !details.url.startsWith("app://")
  ) {
    return details.responseHeaders;
  }
  const headers: Record<string, string[]> = { ...details.responseHeaders };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "content-security-policy") {
      delete headers[name];
    }
  }
  headers["Content-Security-Policy"] = [RENDERER_CSP];
  return headers;
};
