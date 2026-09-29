/**
 * `os.tmpdir()` means different things per platform, and on Linux it is shared
 * with every other local account. The narrowing that needs is a question about
 * a file's owner, so it lives in local-open-guard and is tested there.
 */
import os from "os";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { abacusBotHome, botDefaultWorkspace, userTempDir } from "./paths";

const realPlatform = process.platform;

const asPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
};

afterEach(() => {
  asPlatform(realPlatform);
});

describe("the temp area the app treats as the user's", () => {
  it("is the platform temp directory, which is where scratch files land", () => {
    // Somewhere else would be a location nothing writes to: the agent puts its
    // scratch files in os.tmpdir(), and a link to one of them has to open. Who
    // may open what inside it is local-open-guard's question, not this one.
    for (const platform of ["darwin", "win32", "linux"] as const) {
      asPlatform(platform);
      expect(userTempDir()).toBe(os.tmpdir());
    }
  });
});

/**
 * Where a bot works when nobody has said where.
 *
 * It used to be the user's home directory. Read and write of everything they
 * own, granted to every bot for want of anywhere better to stand. A bot has no
 * project to be pointed at the way a session does, so it gets a directory of
 * its own inside the app's home rather than the run of the machine.
 */
describe("the default workspace for a bot", () => {
  const previousHome = process.env.ABACUSAI_BOT_HOME;

  afterEach(() => {
    if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
    else process.env.ABACUSAI_BOT_HOME = previousHome;
  });

  it("is inside the app's own home, not the user's", () => {
    process.env.ABACUSAI_BOT_HOME = "/tmp/abacus-home";

    // Everything through path.join, nothing as a literal or a prefix check:
    // Windows renders the same locations with backslashes while the env
    // value keeps its forward slashes, and the identity under test is the
    // location, not the separator.
    expect(botDefaultWorkspace()).toBe(path.join(abacusBotHome(), "bot-home"));
    expect(botDefaultWorkspace()).not.toBe(os.homedir());
  });

  it("follows the profile, like everything else under there", () => {
    // Per-profile because the home it hangs off is: two accounts on one
    // machine must not share a bot's scratch directory.
    process.env.ABACUSAI_BOT_HOME = "/tmp/abacus-home/profiles/one";
    const first = botDefaultWorkspace();
    process.env.ABACUSAI_BOT_HOME = "/tmp/abacus-home/profiles/two";

    expect(botDefaultWorkspace()).not.toBe(first);
  });
});
