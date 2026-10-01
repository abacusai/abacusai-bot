/**
 * The quota ledger: a free model is skipped once the window its provider
 * publishes is spent, and the window reopens when the provider's would.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  fileQuotaStore,
  memoryQuotaStore,
  QuotaLedger,
  quotaKey,
} from "./openllm-quota.js";

const NOON = Date.UTC(2026, 9, 1, 12, 0, 30);
const MINUTE = 60_000;

describe("a model's free window", () => {
  it("closes at the published calls per minute and reopens with the next minute", () => {
    let now = NOON;
    const ledger = new QuotaLedger(() => now);

    for (let call = 0; call < 29; call++)
      ledger.record("groq", "openai/gpt-oss-20b", 10);
    expect(ledger.blockedUntil("groq", "openai/gpt-oss-20b")).toBe(0);

    ledger.record("groq", "openai/gpt-oss-20b", 10);
    expect(ledger.blockedUntil("groq", "openai/gpt-oss-20b")).toBe(
      Date.UTC(2026, 9, 1, 12, 1, 0)
    );
    now += MINUTE;
    expect(ledger.blockedUntil("groq", "openai/gpt-oss-20b")).toBe(0);
  });

  it("closes on the day's tokens until UTC midnight", () => {
    const ledger = new QuotaLedger(() => NOON);

    ledger.record("cerebras", "gpt-oss-120b", 1_000_000);

    expect(ledger.blockedUntil("cerebras", "gpt-oss-120b")).toBe(
      Date.UTC(2026, 9, 2)
    );
  });

  it("is never held for a source with no published limits", () => {
    const ledger = new QuotaLedger(() => NOON);

    for (let call = 0; call < 1_000; call++)
      ledger.record("gemini", "gemini-3.6-flash", 100_000);

    expect(ledger.blockedUntil("gemini", "gemini-3.6-flash")).toBe(0);
  });

  it("stops holding back a key that answers past the free limits", () => {
    const ledger = new QuotaLedger(() => NOON);

    for (let call = 0; call < 30; call++)
      ledger.record("groq", "llama-3.3-70b-versatile", 10);
    expect(
      ledger.blockedUntil("groq", "llama-3.3-70b-versatile")
    ).toBeGreaterThan(0);

    // Asked anyway (picked by hand, or the soonest when all were out), and it answered.
    ledger.record("groq", "llama-3.3-70b-versatile", 10);
    expect(ledger.blockedUntil("groq", "llama-3.3-70b-versatile")).toBe(0);
  });

  it("counts account-wide sources under the provider, the rest per model", () => {
    expect(quotaKey("mistral", "devstral-latest")).toBe("mistral");
    expect(quotaKey("groq", "openai/gpt-oss-120b")).toBe(
      "groq/openai/gpt-oss-120b"
    );
  });
});

describe("the ledger on disk", () => {
  it("is shared by every chat: one process's calls count for the next", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "quota-")),
      "q.json"
    );
    const first = new QuotaLedger(() => NOON, fileQuotaStore(file));
    const second = new QuotaLedger(() => NOON, fileQuotaStore(file));

    for (let call = 0; call < 3; call++)
      first.record("cerebras", "gpt-oss-120b", 1);
    for (let call = 0; call < 2; call++)
      second.record("cerebras", "gpt-oss-120b", 1);

    expect(first.blockedUntil("cerebras", "gpt-oss-120b")).toBeGreaterThan(0);
  });

  it("reads a damaged file as empty", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "quota-")),
      "q.json"
    );
    fs.writeFileSync(file, "{not json");

    expect(fileQuotaStore(file).read()).toEqual({});
    expect(memoryQuotaStore().read()).toEqual({});
  });
});
