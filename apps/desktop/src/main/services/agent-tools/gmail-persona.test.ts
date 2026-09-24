import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./memory-store", () => ({ readEntries: vi.fn(() => []) }));

const store = await import("./memory-store");
const {
  EMAIL_PERSONA_MARKER,
  emailPersonaPrompt,
  hasEmailPersona,
  SENT_MAIL_SAMPLE,
} = await import("./gmail-persona");

afterEach(() => vi.mocked(store.readEntries).mockReturnValue([]));

describe("the Gmail persona", () => {
  it("is learned once: the marker line on a USER entry means it is already there", () => {
    expect(hasEmailPersona()).toBe(false);
    vi.mocked(store.readEntries).mockReturnValue([
      "Prefers dark mode",
      `${EMAIL_PERSONA_MARKER}\nWrites short, direct emails.`,
    ]);
    expect(hasEmailPersona()).toBe(true);
    expect(store.readEntries).toHaveBeenLastCalledWith("user");
  });

  it("asks for sent mail only, files one USER entry under the marker, and forbids touching mail", () => {
    const prompt = emailPersonaPrompt();
    expect(prompt).toContain(`${SENT_MAIL_SAMPLE} most recent emails I sent`);
    expect(prompt).toContain("`in:sent`");
    expect(prompt).toContain('target "user", action "add"');
    expect(prompt).toContain(EMAIL_PERSONA_MARKER);
    expect(prompt).toMatch(/never quote a message/);
    expect(prompt).toMatch(/do not draft, send, label or modify any mail/);
  });
});
