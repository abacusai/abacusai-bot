import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dueAgendaItems } from "@abacus-ai/agent/phone-nudges";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingWait } from "#main/services/agent-tools/pending-waits";

import { NudgeAgenda, nudgeNotes, siteName, waitItem } from "./nudge-agenda";
import { PhoneLane } from "./phone-lane";
import { refusedTextRule } from "./refused-text.test-support";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nudge-agenda-"));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-09T06:00:00Z");

const gmail: PendingWait = {
  itemId: "connect:gmailuser",
  kind: "connector",
  stage: "link_sent",
  site: null,
  label: "Gmail",
  since: NOW - 60_000,
  expiresAt: NOW + 23 * 60 * 60_000,
};

const agenda = (
  options: {
    waits?: PendingWait[];
    /** Throws this on every agenda post. */
    refuse?: string;
    /** Fails this many agenda posts first. */
    failTimes?: number;
    dropped?: Array<{ item_id: string; reason: string }>;
    enabled?: boolean;
  } = {}
) => {
  const calls: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  let failures = options.failTimes ?? 0;
  const nudges = new NudgeAgenda(
    {
      call: (async (body: Record<string, unknown>) => {
        calls.push(body);
        if (body.action === "checkins")
          return { ok: true, enabled: options.enabled ?? true };
        if (options.refuse != null) throw new Error(options.refuse);
        if (failures > 0) {
          failures -= 1;
          throw new Error("Abacus API returned 502");
        }
        return { ok: true, accepted: [], dropped: options.dropped ?? [] };
      }) as never,
      phoneDir: dir,
      waits: async () => options.waits ?? [],
      now: () => NOW,
      log: (line) => logs.push(line),
    },
    { debounceMs: 5_000, checkEveryMs: 15_000 }
  );
  const posts = () => calls.filter((body) => body.action === "nudge_agenda");
  return { nudges, calls, posts, logs };
};

const writeLoops = (loops: unknown[]): void =>
  fs.writeFileSync(path.join(dir, "open-loops.json"), JSON.stringify(loops));
const writeLanguage = (language: string): void =>
  fs.writeFileSync(
    path.join(dir, "checkins.json"),
    JSON.stringify({ language })
  );
const readZone = (): unknown =>
  JSON.parse(fs.readFileSync(path.join(dir, "zone.json"), "utf8"));

describe("the check-in agenda", () => {
  it("posts on the first poll of every start, empty when there is nothing, so a previous host's items clear", async () => {
    const { nudges, posts } = agenda();
    nudges.start();
    nudges.polled({});
    nudges.polled({});
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ action: "nudge_agenda", items: [] });
    nudges.stop();
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    nudges.stop();
  });

  it("carries due loops, connector links and the language, value-free", async () => {
    writeLoops([
      {
        id: "L1",
        text: "Passport renewal slot",
        due: "2026-10-09T10:30",
        status: "open",
      },
    ]);
    writeLanguage("es");
    const { nudges, posts } = agenda({ waits: [gmail] });
    nudges.start();
    nudges.polled({ tz: "Asia/Kolkata" });
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({
      action: "nudge_agenda",
      lang: "es",
      items: [
        {
          item_id: "loop:L1",
          kind: "due",
          at: Date.parse("2026-10-09T05:00:00Z") / 1000,
          expires_at: Date.parse("2026-10-09T18:29:00Z") / 1000,
          summary: "Passport renewal slot",
        },
        {
          // When the link went: the server adds its own two hours.
          item_id: "connect:gmailuser",
          kind: "connect",
          at: gmail.since / 1000,
          expires_at: gmail.expiresAt / 1000,
          summary: "Gmail link was sent and is not connected yet.",
        },
      ],
    });
    nudges.stop();
  });

  it("makes the server's zone the loop's clock, and forgets it when the server has none", () => {
    const { nudges, logs } = agenda();
    nudges.start();
    nudges.polled({ tz: "Europe/Madrid" });
    expect(readZone()).toEqual({ timezone: "Europe/Madrid" });
    nudges.polled({ tz: "Not/AZone" });
    nudges.polled({});
    expect(readZone()).toEqual({ timezone: "Europe/Madrid" });
    nudges.polled({ tz: null });
    expect(readZone()).toEqual({});
    expect(logs).toContain("[phone] timezone Europe/Madrid");
    nudges.stop();
  });

  it("posts again after every turn, changed or not, a few seconds later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const { nudges, posts } = agenda();
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    nudges.turnEnded();
    nudges.turnEnded();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    nudges.stop();
  });

  it("posts between turns only when the agenda changed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const waits: PendingWait[] = [];
    const { nudges, posts } = agenda({ waits });
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(posts()).toHaveLength(1);
    waits.push(gmail);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.items).toHaveLength(1);
    nudges.stop();
  });

  it("retries a post that failed on the next check, and says so once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const { nudges, posts, logs } = agenda({ failTimes: 2 });
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => expect(posts()).toHaveLength(3));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(posts()).toHaveLength(3);
    expect(
      logs.filter((line) => line.includes("agenda not taken"))
    ).toHaveLength(1);
    nudges.stop();
  });

  it("logs what the server dropped by reason only", async () => {
    const { nudges, logs } = agenda({
      dropped: [
        { item_id: "loop:L1", reason: "refused_text:digit_run" },
        { item_id: "loop:L2", reason: "bad_at" },
      ],
    });
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() =>
      expect(logs).toContain(
        "[phone] agenda dropped refused_text:digit_run,bad_at"
      )
    );
    nudges.stop();
  });

  it("leaves a server without the action alone after saying so once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const { nudges, calls, logs } = agenda({
      refuse: "action must be one of pair, status, inbox",
    });
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    nudges.turnEnded();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(
      logs.filter((line) => line.includes("agenda not taken"))
    ).toHaveLength(1);
    // Nor is the loop asked for a language the server would never use.
    expect(nudges.notes({ id: "m1", text: "hola" })).toEqual([]);
    nudges.stop();
  });

  it("never names more than the server keeps", async () => {
    fs.writeFileSync(
      path.join(dir, "zone.json"),
      JSON.stringify({ timezone: "UTC" })
    );
    writeLoops(
      Array.from({ length: 14 }, (_, index) => ({
        id: `L${index + 1}`,
        text: `Loop ${index + 1}`,
        due: "2026-10-10",
        status: "open",
      }))
    );
    const { nudges } = agenda();
    expect((await nudges.build()).items).toHaveLength(10);
  });

  it("turns a wait into an item with its name and stage only", () => {
    expect(waitItem(gmail).summary).toBe(
      "Gmail link was sent and is not connected yet."
    );
  });

  it("puts what waits on the user ahead, two minutes after it began at the earliest, to expire with it", () => {
    const wait = (over: Partial<PendingWait>): PendingWait => ({
      itemId: "wait:1",
      kind: "payment",
      stage: "approval",
      site: "akasaair.com",
      since: NOW,
      expiresAt: NOW + 8 * 60_000,
      ...over,
    });
    expect(
      waitItem(
        wait({ merchant: "Akasa Air", amount: "5412.00", currency: "INR" })
      )
    ).toEqual({
      item_id: "wait:1",
      kind: "waiting",
      at: (NOW + 2 * 60_000) / 1000,
      expires_at: (NOW + 8 * 60_000) / 1000,
      summary:
        "A payment of ₹5,412 to Akasa Air is waiting for the user's approval on the page sent.",
    });
    expect(
      waitItem(wait({ amount: "about 5k", currency: "INR" })).summary
    ).toBe(
      "A payment to akasaair is waiting for the user's approval on the page sent."
    );
  });

  it("names a payee that reads as a domain by its name alone", () => {
    const summary = waitItem({
      itemId: "wait:1",
      kind: "payment",
      stage: "approval",
      site: "amazon.in",
      merchant: "Amazon.in",
      amount: "499",
      currency: "INR",
      since: NOW,
      expiresAt: NOW + 30 * 60_000,
    }).summary;
    expect(summary).toBe(
      "A payment of ₹499 to amazon is waiting for the user's approval on the page sent."
    );
    expect(refusedTextRule(summary)).toBeNull();
  });

  it("names a site without its domain", () => {
    expect(siteName("akasaair.com")).toBe("akasaair");
    expect(siteName("www.booking.makemytrip.com")).toBe("makemytrip");
    expect(siteName("tickets.example.co.uk")).toBe("example");
    expect(siteName("localhost")).toBeNull();
  });

  it("lists waiting first, then due, then connect", async () => {
    fs.writeFileSync(
      path.join(dir, "zone.json"),
      JSON.stringify({ timezone: "UTC" })
    );
    writeLoops([
      { id: "L1", text: "Pay rent", due: "2026-10-09", status: "open" },
    ]);
    const { nudges } = agenda({
      waits: [
        gmail,
        {
          itemId: "wait:2",
          kind: "vault_card",
          stage: "page_sent",
          site: null,
          since: NOW,
          expiresAt: NOW + 20 * 60_000,
        },
      ],
    });
    expect((await nudges.build()).items.map((item) => item.kind)).toEqual([
      "waiting",
      "due",
      "connect",
    ]);
  });

  it("builds only summaries the server's deny-check lets through", () => {
    writeLoops([
      {
        id: "L1",
        text: "Passport renewal slot",
        due: "2026-10-09T10:30",
        status: "open",
      },
      {
        id: "L2",
        text: "Pay the electricity bill",
        due: "2026-10-09",
        status: "open",
      },
      {
        id: "L3",
        text: "Call mom",
        due: "2026-10-10T18:00+05:30",
        status: "open",
      },
    ]);
    const summaries = [
      ...dueAgendaItems(dir, NOW, "Asia/Kolkata").map((item) => item.summary),
      waitItem(gmail).summary,
      waitItem({ ...gmail, label: "Google Calendar" }).summary,
      ...(
        [
          { kind: "vault_login", stage: "page_sent", site: "akasaair.com" },
          {
            kind: "vault_login",
            stage: "page_sent",
            site: "accounts.example.co.uk",
          },
          { kind: "vault_card", stage: "page_sent", site: null },
          { kind: "vault_code", stage: "page_sent", site: null },
          {
            kind: "payment",
            stage: "approval",
            site: "akasaair.com",
            merchant: "Akasa Air",
            amount: "5412.00",
            currency: "INR",
          },
          {
            kind: "payment",
            stage: "approval",
            site: "store.example.com",
            amount: "1234567.89",
            currency: "USD",
          },
          {
            kind: "payment",
            stage: "approval",
            site: "amazon.in",
            merchant: "Amazon.in",
            amount: "499",
            currency: "INR",
          },
          { kind: "checkout", stage: "details", site: "akasaair.com" },
          { kind: "checkout", stage: "code", site: "akasaair.com" },
          {
            kind: "checkout",
            stage: "payment",
            site: "akasaair.com",
            merchant: "Akasa Air",
            amount: "18999.50",
            currency: "EUR",
          },
        ] as const
      ).map(
        (over) =>
          waitItem({
            itemId: "wait:1",
            since: NOW,
            expiresAt: NOW + 60_000,
            ...over,
          }).summary
      ),
    ];
    expect(summaries).toHaveLength(15);
    for (const summary of summaries)
      expect(refusedTextRule(summary), summary).toBeNull();
    // The port refuses what the server refuses.
    expect(refusedTextRule("Call (due 2026-10-09T10:30)")).toBe("digit_run");
    expect(refusedTextRule("Sign in to akasaair.com")).toBe("external_link");
  });
});

describe("what the loop hears with a user message", () => {
  it("the check-ins sent since, and a bare STOP, as tagged parts that are never the user's words", () => {
    const notes = nudgeNotes({
      id: "m1",
      text: "STOP",
      stop_keyword: true,
      nudges_sent: [
        { at: 1, text: "Your passport\n slot is today at 10:30." },
        { at: 2, text: "" },
      ],
    });
    expect(notes).toEqual([
      '[check-ins sent] Since the user\'s last message the app texted them: "Your passport slot is today at 10:30.". Their message may answer that.',
      expect.stringMatching(
        /^\[stop keyword\] .*change nothing until they say\.$/
      ),
    ]);
    // The loop's consent checks skip a part that opens with a host tag.
    for (const note of notes) expect(note).toMatch(/^\[[a-z][a-z -]*\] /);
  });

  it("nothing extra for a plain message", () => {
    expect(nudgeNotes({ id: "m1", text: "hi" })).toEqual([]);
  });

  it("asks for the check-in language on every turn while none is set, and posts a script's own meanwhile", async () => {
    const { nudges, posts } = agenda();
    nudges.start();
    // Before the server took an agenda, nothing is asked.
    expect(nudges.notes({ id: "m0", text: "hi" })).toEqual([]);
    nudges.polled({});
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    const asked = nudges.notes({ id: "m1", text: "안녕하세요 반갑습니다" });
    expect(asked).toEqual([
      expect.stringMatching(/^\[check-ins language\] .*op language/),
    ]);
    expect(nudges.notes({ id: "m2", text: "hello there" })).toEqual(asked);
    expect((await nudges.build()).lang).toBe("ko");
    writeLanguage("en");
    expect(nudges.notes({ id: "m3", text: "hello" })).toEqual([]);
    expect((await nudges.build()).lang).toBe("en");
    nudges.stop();
  });

  it("stops asking for the language after three calls that left none set this start", async () => {
    const { nudges, posts } = agenda();
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    for (let call = 0; call < 3; call += 1) {
      expect(nudges.notes({ id: `m${call}`, text: "hola" })).toHaveLength(1);
      nudges.languageCallEnded();
    }
    expect(nudges.notes({ id: "m9", text: "hola" })).toEqual([]);
    nudges.stop();
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    expect(nudges.notes({ id: "m10", text: "hola" })).toHaveLength(1);
    nudges.stop();
  });

  it("does not count a call that set the language", async () => {
    const { nudges, posts } = agenda();
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    writeLanguage("es");
    for (let call = 0; call < 5; call += 1) nudges.languageCallEnded();
    fs.writeFileSync(path.join(dir, "checkins.json"), "{}");
    expect(nudges.notes({ id: "m1", text: "hola" })).toHaveLength(1);
    nudges.stop();
  });

  it("has the linked greeting mention check-ins only when the server has them on", async () => {
    for (const enabled of [true, false]) {
      const { nudges, calls } = agenda({ enabled });
      nudges.start();
      nudges.polled({});
      await vi.waitFor(() =>
        expect(calls.some((body) => body.action === "checkins")).toBe(true)
      );
      await vi.waitFor(() =>
        expect(nudges.notes({ id: "l1", kind: "linked" }).length > 0).toBe(
          enabled
        )
      );
      nudges.stop();
    }
  });

  it("drops a due loop from the agenda once a check-in about it went", async () => {
    fs.writeFileSync(
      path.join(dir, "zone.json"),
      JSON.stringify({ timezone: "Asia/Kolkata" })
    );
    writeLoops([
      {
        id: "L1",
        text: "Morning call",
        due: "2026-10-09T09:00",
        status: "open",
      },
    ]);
    const { nudges } = agenda();
    nudges.start();
    expect((await nudges.build()).items).toHaveLength(1);
    nudges.notes({
      id: "m1",
      text: "done",
      nudges_sent: [{ at: NOW / 1000, text: "Your morning call is now." }],
    });
    expect((await nudges.build()).items).toEqual([]);
    nudges.stop();
  });

  it("says a note once across a batch of messages", async () => {
    const send = vi.fn(async () => true);
    let polls = 0;
    const phone = new PhoneLane(
      {
        call: (async (body: Record<string, unknown>) => {
          if (body.action !== "inbox") return { ok: true };
          polls += 1;
          if (polls > 1) await new Promise(() => {});
          return {
            messages: [
              { id: "m1", text: "hola" },
              { id: "m2", text: "otra cosa", stop_keyword: true },
            ],
          };
        }) as never,
        hasKey: () => true,
        openSession: async () => ({ workspaceId: "w", sessionId: "s" }),
        stop: async () => {},
        send,
        onAgentEvent: () => () => {},
        activity: () => {},
        resolveMedia: () => ({ ok: false, reason: "none" }),
        turnNotes: (entry) => [
          "[check-ins language] Set it.",
          ...nudgeNotes(entry),
        ],
        log: () => {},
      },
      { batchMs: 0 }
    );
    phone.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const text = (send.mock.calls[0] as unknown[])[2] as string;
    expect(text.match(/\[check-ins language\]/g)).toHaveLength(1);
    expect(text).toMatch(
      /^\[check-ins language\] Set it\.\n\nhola\n\n\[stop keyword\] /
    );
    phone.stop();
  });

  it("reaches the session ahead of the message, and each poll reports its zone", async () => {
    const send = vi.fn(async () => true);
    const polled = vi.fn();
    let polls = 0;
    const phone = new PhoneLane(
      {
        call: (async (body: Record<string, unknown>) => {
          if (body.action !== "inbox") return { ok: true };
          polls += 1;
          if (polls > 1) await new Promise(() => {});
          return {
            tz: "Asia/Kolkata",
            messages: [
              {
                id: "m1",
                text: "yes please",
                nudges_sent: [{ at: 1, text: "Gmail isn't connected yet." }],
              },
            ],
          };
        }) as never,
        hasKey: () => true,
        openSession: async () => ({ workspaceId: "w", sessionId: "s" }),
        stop: async () => {},
        send,
        onAgentEvent: () => () => {},
        activity: () => {},
        resolveMedia: () => ({ ok: false, reason: "none" }),
        onPolled: polled,
        turnNotes: nudgeNotes,
        log: () => {},
      },
      { batchMs: 0 }
    );
    phone.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(polled).toHaveBeenCalledWith(
      expect.objectContaining({ tz: "Asia/Kolkata" })
    );
    expect(send).toHaveBeenCalledWith(
      "w",
      "s",
      "[check-ins sent] Since the user's last message the app texted them: \"Gmail isn't connected yet.\". Their message may answer that.\n\nyes please",
      "m1"
    );
    phone.stop();
  });
});
