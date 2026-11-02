import { beforeAll } from "vitest";

import { probeGrammars } from "../lang.js";

// The agent settles its grammars at startup (main.ts); a suite starts settled too.
beforeAll(() => probeGrammars());
