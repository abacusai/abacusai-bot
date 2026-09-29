/**
 * The pre-grant classifier, pinned from both sides: what a plainly written
 * benign line gets, and everything that must get nothing. The second half
 * matters more. It is the corpus of ways a command can look like one thing
 * and do another (chaining, substitution, quote games, wrappers, rc files,
 * boundary spellings), and each must leave the kernel to decide.
 */
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { classifyCommand, type IntentOptions } from "./intent.js";
import { canonicalize } from "./policy.js";

const HOME = "/Users/dev";
const WORKSPACE = "/Users/dev/proj";
const DESKTOP = path.join(HOME, "Desktop");

/** A small pretend filesystem: what exists, and which of those are dirs. */
function fixture(
  existing: readonly string[] = [],
  dirs: readonly string[] = [],
  ledger: readonly string[] = []
): IntentOptions {
  const files = new Set([HOME, DESKTOP, WORKSPACE, ...existing, ...dirs]);
  const folders = new Set([HOME, DESKTOP, WORKSPACE, ...dirs]);

  return {
    context: {
      workspaceRoot: WORKSPACE,
      writableTemp: [canonicalize("/tmp")],
      toolHomes: [path.join(HOME, ".npm"), path.join(HOME, ".cache")],
    },
    home: HOME,
    ledger: new Set(ledger),
    exists: (target) => files.has(target),
    isDirectory: (target) => folders.has(target),
  };
}

const classify = (
  command: string,
  options: IntentOptions = fixture(),
  cwd: string = WORKSPACE
) => classifyCommand(command, cwd, options);

const onPosix = process.platform !== "win32";

describe.skipIf(!onPosix)("what a concern reads like", () => {
  it("tells the user what to do with a line it cannot read", () => {
    // The card said "The command the command is not plain enough to read.",
    // a classifier's shrug, doubled. A predicate after "The command" now,
    // and one the user can act on.
    const intent = classify(
      'echo "local: $(git config --get credential.helper)"'
    );
    expect(intent.concerns).toHaveLength(1);
    expect(intent.concerns[0]).toMatch(/^uses shell substitutions/);
    expect(intent.concerns[0]).toContain("check the command itself");
  });
});

describe.skipIf(!onPosix)("what a benign line is granted", () => {
  it("a new file in the user's folders, by redirect, touch, tee or cp", () => {
    for (const command of [
      "echo hi > ~/Desktop/notes.txt",
      "touch ~/Desktop/notes.txt",
      "echo hi | tee ~/Desktop/notes.txt",
      "cp README.md ~/Desktop/notes.txt",
      "install -m 644 README.md ~/Desktop/notes.txt",
    ]) {
      const intent = classify(command);
      expect(intent.grants, command).toEqual([path.join(DESKTOP, "notes.txt")]);
      expect(intent.creates, command).toEqual([
        path.join(DESKTOP, "notes.txt"),
      ]);
      expect(intent.concerns, command).toEqual([]);
    }
  });

  it("a new directory beside the project, and then working inside it", () => {
    const app = path.join(HOME, "app");
    const intent = classify(
      `mkdir -p ${app} && cd ${app} && npm init -y && git init`
    );

    // The mkdir is granted; the later commands run from that directory,
    // which is the session's own once made.
    expect(intent.grants).toEqual([app]);
    expect(intent.creates).toEqual([app]);
    expect(intent.concerns).toEqual([]);
  });

  it("copying into an existing folder of the user's", () => {
    const intent = classify("cp -r dist ~/Desktop", fixture());
    expect(intent.grants).toEqual([DESKTOP]);
    expect(intent.creates).toEqual([]);
  });

  it("moving a workspace file out to a new name", () => {
    const intent = classify("mv build/report.pdf ~/Documents/report.pdf");
    expect(intent.grants).toEqual([path.join(HOME, "Documents", "report.pdf")]);
  });

  it("git clone into the user's folders, named or by repo", () => {
    expect(
      classify("git clone https://github.com/x/y.git ~/Desktop/y2").grants
    ).toEqual([path.join(DESKTOP, "y2")]);
    expect(
      classify("cd ~/Desktop && git clone https://github.com/x/y.git").grants
    ).toEqual([path.join(DESKTOP, "y")]);
  });

  it("changing or removing what this session made", () => {
    const own = path.join(DESKTOP, "notes.txt");
    const options = fixture([own], [], [own]);

    expect(classify(`rm ${own}`, options).grants).toEqual([own]);
    expect(classify(`echo more >> ${own}`, options).grants).toEqual([own]);
    expect(classify(`sed -i 's/a/b/' ${own}`, options).grants).toEqual([own]);
    expect(classify(`chmod 600 ${own}`, options).grants).toEqual([own]);
  });

  it("a trailing exit-status echo does not spoil the read", () => {
    const intent = classify('echo hi > ~/Desktop/notes.txt; echo "exit=$?"');
    expect(intent.grants).toEqual([path.join(DESKTOP, "notes.txt")]);
  });

  it("a create earlier in the same line counts as the session's own", () => {
    const own = path.join(DESKTOP, "tmp.txt");
    const intent = classify(`touch ${own} && echo x > ${own} && rm ${own}`);
    expect(intent.grants).toEqual([own]);
    expect(intent.concerns).toEqual([]);
  });

  it("says nothing about the workspace, scratch and tool homes", () => {
    for (const command of [
      "rm -rf node_modules",
      "echo x > /tmp/out.txt",
      "rm -rf ~/.npm/_cacache",
      "npm install",
      "git commit -am x",
    ]) {
      expect(classify(command), command).toEqual({
        grants: [],
        creates: [],
        concerns: [],
      });
    }
  });
});

describe.skipIf(!onPosix)("what is destructive outside the workspace", () => {
  const existing = path.join(DESKTOP, "important.txt");

  it.each([
    ["deleting a file that is not the session's", `rm ${existing}`],
    ["deleting a folder", "rm -rf ~/Documents/old"],
    ["find -delete", "find ~/Desktop -name '*.log' -delete"],
    ["replacing an existing file", `echo x > ${existing}`],
    ["appending to an existing file", `echo x >> ${existing}`],
    ["tee over an existing file", `echo x | tee ${existing}`],
    ["sed in place", `sed -i 's/a/b/' ${existing}`],
    ["truncate", `truncate -s 0 ${existing}`],
    ["dd onto an existing file", `dd if=/dev/zero of=${existing}`],
    ["chmod", `chmod 777 ${existing}`],
    ["moving something of the user's away", `mv ${existing} /tmp/x`],
    ["rsync --delete onto a folder", "rsync -a --delete dist/ ~/Desktop/site"],
    ["cp onto an existing file", `cp README.md ${existing}`],
  ])("%s asks", (_label, command) => {
    const intent = classify(command, fixture([existing]));
    expect(intent.grants).toEqual([]);
    expect(intent.concerns.length).toBeGreaterThan(0);
  });

  it("one destructive step means no grant for the benign one beside it", () => {
    // The create's grant is its directory once widened, and the delete next
    // to it must not ride on that.
    const intent = classify(
      `touch ~/Desktop/new.txt && rm ${existing}`,
      fixture([existing])
    );
    expect(intent.grants).toEqual([]);
    expect(intent.concerns).toEqual([
      `deletes ${existing} (outside the workspace)`,
    ]);
  });
});

describe.skipIf(!onPosix)("what is never granted anywhere", () => {
  it.each([
    ["a dotfile", "echo x >> ~/.zshrc"],
    ["a new dotfile", "touch ~/.hushlogin"],
    ["the ssh directory", "touch ~/.ssh/authorized_keys"],
    ["home itself", "touch ~/x.txt"],
    ["~/Library", "touch ~/Library/LaunchAgents/x.plist"],
    ["/etc", "echo x > /etc/hosts"],
    ["/usr/local", "cp bin/tool /usr/local/bin/tool"],
    ["another volume", "touch /Volumes/Backup/x"],
    ["/opt", "mkdir -p /opt/app"],
  ])("%s", (_label, command) => {
    const intent = classify(command);
    expect(intent.grants).toEqual([]);
    expect(intent.concerns.length).toBeGreaterThan(0);
  });

  it("a workspace spelled like a sibling is not the workspace", () => {
    const intent = classify("echo x > /Users/dev/proj_evil/x.txt");
    // A user folder, so a create is fine, but only because it is one; it
    // must not have passed as the workspace.
    expect(intent.grants).toEqual(["/Users/dev/proj_evil/x.txt"]);
    expect(
      classify(
        "rm /Users/dev/proj_evil/x.txt",
        fixture(["/Users/dev/proj_evil/x.txt"])
      ).grants
    ).toEqual([]);
  });
});

describe.skipIf(!onPosix)(
  "what cannot be read with confidence gets nothing",
  () => {
    const own = path.join(DESKTOP, "notes.txt");

    it.each([
      ["command substitution", `touch ~/Desktop/$(whoami).txt`],
      ["backticks", "touch ~/Desktop/`whoami`.txt"],
      ["a variable in the path", "touch $HOME/Desktop/x.txt"],
      ["a variable in the verb", "$CMD ~/Desktop/x.txt"],
      ["brace expansion of a variable", "touch ${DIR}/x.txt"],
      ["process substitution", "cat <(ls) > ~/Desktop/x.txt"],
      ["eval", `eval "touch ${own}"`],
      ["sh -c", `sh -c "touch ${own}"`],
      ["bash -lc", `bash -lc "touch ${own}"`],
      ["python -c", `python3 -c "open('${own}','w')"`],
      ["node -e", `node -e "require('fs').writeFileSync('${own}','')"`],
      ["xargs", `echo ${own} | xargs touch`],
      ["find -exec", `find . -name x -exec touch ${own} \\;`],
      ["source", "source ./setup.sh"],
      [
        "a separator inside a quote",
        `echo "a; touch ${own}" > ~/Desktop/a.txt; rm ${own}`,
      ],
      ["an unbalanced quote", `touch ${own} "`],
      ["cd -", `cd - && touch x.txt`],
      ["sudo", `sudo touch ${own}`],
    ])("%s", (_label, command) => {
      const intent = classify(command);
      expect(intent.grants).toEqual([]);
      expect(intent.concerns.length).toBeGreaterThan(0);
    });

    it("wrapper laundering is stepped over, not trusted", () => {
      // env and nohup reach the real verb, which is then judged as itself.
      expect(classify(`env FOO=1 touch ${own}`).grants).toEqual([own]);
      expect(classify(`nohup rm ${own}`, fixture([own])).grants).toEqual([]);
    });

    it("a command that names no path outside the workspace gets nothing", () => {
      expect(classify("ls -la ~/Desktop")).toEqual({
        grants: [],
        creates: [],
        concerns: [],
      });
    });
  }
);
