import { describe, expect, it } from "vitest";

import { onSite, registrableDomain, sameSite, siteArgument } from "./site";

describe("a site", () => {
  it("is the registrable domain, by the public suffix list", () => {
    expect(registrableDomain("www.akasaair.com")).toBe("akasaair.com");
    expect(registrableDomain("WWW.Example.COM")).toBe("example.com");
    expect(registrableDomain("secure.shop.co.uk")).toBe("shop.co.uk");
    expect(registrableDomain("book.goindigo.in")).toBe("goindigo.in");
    expect(registrableDomain("co.uk")).toBeNull();
  });

  it("counts private suffixes: each S3 bucket and github.io page is its own site", () => {
    expect(registrableDomain("bucket-a.s3.us-west-2.amazonaws.com")).toBe(
      "bucket-a.s3.us-west-2.amazonaws.com"
    );
    expect(
      sameSite(
        "bucket-a.s3.us-west-2.amazonaws.com",
        "bucket-b.s3.us-west-2.amazonaws.com"
      )
    ).toBe(false);
    expect(registrableDomain("www.a.github.io")).toBe("a.github.io");
    expect(registrableDomain("github.io")).toBeNull();
    expect(sameSite("a.github.io", "b.github.io")).toBe(false);
    expect(sameSite("a.github.io", "www.a.github.io")).toBe(true);
  });

  it("has none for an IP or localhost, which are each only themselves", () => {
    for (const host of ["127.0.0.1", "[::1]", "localhost"])
      expect(registrableDomain(host)).toBeNull();
    expect(sameSite("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(sameSite("127.0.0.1", "127.0.0.2")).toBe(false);
    expect(sameSite("localhost", "127.0.0.1")).toBe(false);
  });

  it("binds a host to a site the server named, subdomains included", () => {
    expect(onSite("www.akasaair.com", "akasaair.com")).toBe(true);
    expect(onSite("akasaair.com.evil.io", "akasaair.com")).toBe(false);
    expect(onSite("www.bbc.co.uk", "co.uk")).toBe(false);
    expect(onSite("evil.github.io", "github.io")).toBe(false);
    expect(onSite("127.0.0.1", "127.0.0.1")).toBe(false);
    expect(onSite("www.akasaair.com", "")).toBe(false);
  });

  it("is read from a site argument with a name, scheme, path or port around it", () => {
    expect(siteArgument("skyfare.com (SkyFare Air)")).toBe("skyfare.com");
    expect(siteArgument("https://www.skyfare.com/book?x=1")).toBe(
      "skyfare.com"
    );
    expect(siteArgument("WWW.LinkedIn.com:443/")).toBe("linkedin.com");
    expect(siteArgument("linkedin.com.")).toBe("linkedin.com");
    expect(siteArgument("SkyFare Air")).toBeNull();
    expect(siteArgument("(SkyFare Air)")).toBeNull();
    expect(siteArgument("co.uk")).toBeNull();
  });
});
