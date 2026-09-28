/**
 * Only what the model puts inside <reply> reaches the other person.
 *
 * Told to keep its reasoning out of the reply, a model wrote "I don't have a
 * city for Ma saved… really I should just ask" and then the reply, and Ma
 * got both. Asking it to wrap the reply is something it does reliably, and
 * something the app can enforce.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readStoredMessageLog: () => [],
  writeStoredMessageLog: () => {},
}));

const { outgoingWords } = await import("./messaging-gateway-service");

describe("the words that go out", () => {
  it("are what is inside the reply tag, and nothing outside it", () => {
    expect(
      outgoingWords(
        "I don't have a city for Ma saved. I should just ask.\n\n" +
          "<reply>Hey! Which city are you in?</reply>"
      )
    ).toBe("Hey! Which city are you in?");
  });

  it("take the last tag when the model wrote more than one", () => {
    expect(
      outgoingWords("<reply>draft</reply> hmm no <reply>Hi Ma!</reply>")
    ).toBe("Hi Ma!");
  });

  it("keep a reply that spans lines", () => {
    expect(outgoingWords("<reply>\nHi Ma,\n\nall good here.\n</reply>")).toBe(
      "Hi Ma,\n\nall good here."
    );
  });

  it("send the whole text when there is no tag: a reply is never lost", () => {
    expect(outgoingWords("khawa hoyeche, tumi?")).toBe("khawa hoyeche, tumi?");
  });

  it("drop a stray thinking block when there is no tag", () => {
    expect(
      outgoingWords(
        "<thinking>she wants the weather; ask the city</thinking>\nWhich city?"
      )
    ).toBe("Which city?");
  });

  it("leave NO_REPLY recognisable", () => {
    expect(outgoingWords("<reply>NO_REPLY</reply>")).toBe("NO_REPLY");
    expect(outgoingWords("NO_REPLY")).toBe("NO_REPLY");
  });
});
