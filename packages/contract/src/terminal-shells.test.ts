import * as v from "valibot";
import { expect, it } from "vitest";

import { TerminalShellIdSchema } from "./contract/terminal";
import { TERMINAL_SHELLS } from "./terminal-shells";

it("accepts every shell a menu can offer", () => {
  for (const { id } of TERMINAL_SHELLS)
    expect(v.safeParse(TerminalShellIdSchema, id).success, id).toBe(true);
  expect(v.safeParse(TerminalShellIdSchema, "nope").success).toBe(false);
});
