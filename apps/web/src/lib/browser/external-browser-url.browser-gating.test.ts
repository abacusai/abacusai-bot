import { describe, expect, it } from "vitest";

import { externalBrowserUrl } from "./external-browser-url";

describe("external browser links", () => {
  it.each([
    "http://localhost:3000",
    "http://LOCALHOST.:3000",
    "http://app.localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.1:3000",
    "http://2130706433:3000",
    "http://0.0.0.0:3000",
    "http://10.2.3.4",
    "http://172.16.0.1",
    "http://192.168.1.1",
    "http://169.254.169.254",
    "http://100.64.0.1",
    "http://[::1]:3000",
    "http://[::]:3000",
    "http://[::ffff:127.0.0.1]",
    "http://[fd00::1]",
    "http://[fe80::1]",
    "http://host",
    "http://app.local",
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/index.html",
    "https://user:password@example.com",
    "not a URL",
    undefined,
  ])("does not open host-only or unsafe URL %s", (url) => {
    expect(externalBrowserUrl(url)).toBeNull();
  });

  it.each([
    "https://example.com/preview?session=1",
    "http://8.8.8.8/",
    "https://[2606:4700:4700::1111]/",
  ])("keeps a public HTTP link %s", (url) => {
    expect(externalBrowserUrl(url)).toBe(url);
  });
});
