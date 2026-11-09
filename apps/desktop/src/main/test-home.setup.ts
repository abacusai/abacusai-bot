import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Each test file gets its own app home: state files written there (the chat
// outbox, the lanes' watermarks) never reach the developer's real home or
// leak from one file into the next. A test that sets its own still wins.
process.env.ABACUSAI_BOT_HOME ??= fs.mkdtempSync(
  path.join(os.tmpdir(), "abacusai-bot-test-home-")
);
