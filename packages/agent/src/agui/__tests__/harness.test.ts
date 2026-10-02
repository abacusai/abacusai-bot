import { expect, it } from "vitest";

import { maskVolatile, normalizeAgui } from "./harness.js";

it("masks JSON-escaped Windows session files without rewriting the golden", () => {
  const ready = {
    type: "ready",
    model: "fake/fake-1",
    mode: "DEFAULT",
    agentSessionId: "random-session-id",
    agentSessionFile: "C:\\Users\\runner\\session.jsonl",
  };
  const bytes = `${JSON.stringify(ready)}\n`;
  expect(maskVolatile(bytes, [])).toBe(
    `${JSON.stringify({ ...ready, agentSessionId: "<SESSION_ID_1>", agentSessionFile: "<SESSION_FILE_1>" })}\n`
  );
});

it("masks Windows session files in AG-UI ready events and state snapshots", () => {
  const value = {
    agentSessionId: "random-session-id",
    agentSessionFile: String.raw`C:\Users\runner\session.jsonl`,
  };
  const events = [
    { type: "CUSTOM", name: "session.ready", value },
    { type: "STATE_SNAPSHOT", snapshot: value },
  ];
  const bytes = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  const expected = {
    agentSessionId: "<SESSION_ID_1>",
    agentSessionFile: "<SESSION_FILE_1>",
  };
  expect(normalizeAgui(bytes, [])).toBe(
    [
      { ...events[0], value: expected },
      { ...events[1], snapshot: expected },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n"
  );
});
