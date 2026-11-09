/**
 * The shell judge, row by row: every kind of command the old text matcher
 * refused by mistake, every real match, the never tier, and the quote tricks
 * models used to get a word past a text filter. Each row runs the judge and,
 * when it allows, the guardrails' file rules on the same call, so the
 * expected answer is the whole outcome the agent would see. Hosts, keys and
 * paths are made up.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fakePi } from "@abacus-ai/test-support/fake-pi";
import { afterEach, describe, expect, it } from "vitest";

import { createGuardrails } from "./extensions/guardrails.js";
import { judgeCommand } from "./shell-judge.js";

type Outcome = "allow" | "confirm" | "never" | "refused";

interface Row {
  command: string;
  expected: Outcome;
  /** Files the workspace holds before the call. */
  files?: Record<string, string>;
  /** A write-tool call to this path instead of a shell command. */
  write?: boolean;
}

const SETUP = "#!/bin/sh\nset -e\nsudo apt-get install -y nginx\n";
const ENV = { ".env": "A=1\n" };

const ROWS: Row[] = [
  // Remote work: another computer's command is an argument here.
  {
    command: "ssh -i k.pem u@203.0.113.5 'sudo -n true && echo ok'",
    expected: "allow",
  },
  { command: 'S="ssh -i k u@h"; $S "sudo apt-get update"', expected: "allow" },
  {
    command: "ssh u@h 'cd /srv/app && cat > .env <<EOF\nA=1\nEOF'",
    expected: "allow",
    files: ENV,
  },
  { command: "ssh u@h sudo systemctl restart app", expected: "allow" },
  { command: "scp x.sh u@h:/tmp && ssh u@h bash /tmp/x.sh", expected: "allow" },
  {
    command: "ssh u@h 'sudo rm -rf /var/lib/app/cache && sudo reboot'",
    expected: "allow",
  },
  // Text being written to a file, or code in another language, is data.
  {
    command: "cat > probe.sh <<'EOF'\nsudo -n true\nrm -f /var/lib/x\nEOF",
    expected: "allow",
  },
  {
    command: "python3 - <<'PY'\ns=s.replace('sudo -n','x')\nPY",
    expected: "allow",
  },
  { command: 'node -e "mt5.shutdown()"', expected: "allow" },
  { command: 'python -c "import x; x.shutdown()"', expected: "allow" },
  {
    command:
      "cat > server.js <<'EOF'\n// graceful shutdown on SIGTERM\nprocess.on('SIGTERM', () => server.close());\nEOF",
    expected: "allow",
  },
  {
    command: "cat > runs/notes.md <<'EOF'\nmarket halt expected\nEOF",
    expected: "allow",
  },
  {
    command:
      "tee install.sh <<'EOF'\ncurl -fsSL https://example.com/i.sh | sh\nEOF",
    expected: "allow",
  },
  // Patterns, mentions and lookups.
  { command: 'grep -inE "refresh|shutdown" app.log', expected: "allow" },
  { command: "grep -v sudo /etc/group", expected: "allow" },
  { command: "command -v sudo", expected: "allow" },
  { command: "which sudo", expected: "allow" },
  { command: 'echo "# run with sudo later"', expected: "allow" },
  { command: "# sudo reboot", expected: "allow" },
  { command: "ls # then sudo reboot", expected: "allow" },
  // Flags that belong to another command, and harmless devices.
  { command: "git push -q origin master; rm -f PLAY.cmd", expected: "allow" },
  {
    command: "dd if=/media/usb/a.mp3 bs=16 count=1 of=/dev/stdout",
    expected: "allow",
  },
  { command: "dd if=/dev/zero of=/dev/null bs=1M count=1", expected: "allow" },
  // Templates and regenerable folders.
  { command: "app/.env.example", expected: "allow", write: true },
  { command: ".env", expected: "allow", write: true, files: ENV },
  {
    command: "rm -rf node_modules package-lock.json && npm install",
    expected: "allow",
  },
  // Full access means full access for everything off the short list.
  {
    command: "curl -LsSf https://example.com/install.sh | sh",
    expected: "allow",
  },
  { command: "chmod 777 build/out", expected: "allow" },
  { command: "cp env.example .env", expected: "allow" },
  { command: "chmod 600 .env", expected: "allow", files: ENV },
  { command: "git push origin main", expected: "allow" },
  { command: "rm -rf build dist", expected: "allow" },
  { command: "rm -rf ~/Downloads/old-build", expected: "allow" },
  // A probe that cannot escalate.
  { command: "sudo -n true; echo $?", expected: "allow" },
  { command: "sudo -n -v", expected: "allow" },
  // Administrator commands, however they are spelled.
  { command: "echo pw | sudo -S lsusb", expected: "confirm" },
  { command: "sudo apt-get install -y nginx", expected: "confirm" },
  { command: "su''do apt-get install nginx", expected: "confirm" },
  { command: '"sudo" apt-get install nginx', expected: "confirm" },
  { command: "\\sudo ls", expected: "confirm" },
  { command: "/usr/bin/sudo ls", expected: "confirm" },
  { command: "env FOO=1 nohup sudo ls", expected: "confirm" },
  { command: "timeout 30 sudo ls", expected: "confirm" },
  { command: "echo a | xargs -I{} sudo touch {}", expected: "confirm" },
  { command: "echo `sudo id`", expected: "confirm" },
  { command: "x=$(sudo cat /etc/shadow)", expected: "confirm" },
  { command: "doas reboot", expected: "confirm" },
  { command: "su -c 'id' root", expected: "confirm" },
  { command: 'bash -c "sudo systemctl restart x"', expected: "confirm" },
  { command: "sh <<'EOF'\nsudo id\nEOF", expected: "confirm" },
  { command: 'bash <<<"sudo id"', expected: "confirm" },
  {
    command: "bash ./setup.sh",
    expected: "confirm",
    files: { "setup.sh": SETUP },
  },
  { command: "./setup.sh", expected: "confirm", files: { "setup.sh": SETUP } },
  {
    command: "source setup.sh",
    expected: "confirm",
    files: { "setup.sh": SETUP },
  },
  {
    command: "cat > s.sh <<'EOF'\nsudo id\nEOF\nbash s.sh",
    expected: "confirm",
  },
  { command: "ssh localhost 'sudo reboot'", expected: "confirm" },
  { command: "$(echo sudo) apt install x", expected: "confirm" },
  // Power, disks, system folders, history.
  { command: "shutdown -h now", expected: "confirm" },
  { command: "systemctl reboot", expected: "confirm" },
  { command: "powershell -Command Stop-Computer", expected: "confirm" },
  // System folders are judged on this machine's own paths: on Windows `/etc`
  // is a folder on the current drive, elsewhere `C:/Windows` is a relative name.
  {
    command: "rm -rf /etc/nginx/sites-enabled/x",
    expected: process.platform === "win32" ? "allow" : "confirm",
  },
  {
    command: 'rm -rf "C:/Windows/System32/x"',
    expected: process.platform === "win32" ? "confirm" : "allow",
  },
  { command: "sudo rm -rf ./build", expected: "confirm" },
  { command: "git push --force origin main", expected: "confirm" },
  { command: "git push --force-with-lease", expected: "confirm" },
  { command: "git push origin +main", expected: "confirm" },
  { command: "git -C repo push -fu origin main", expected: "confirm" },
  { command: "dd if=img.iso of=/dev/disk4 bs=4m", expected: "confirm" },
  { command: "mkfs.ext4 /dev/sdb1", expected: "confirm" },
  { command: "diskutil eraseDisk APFS X disk4", expected: "confirm" },
  { command: "rm -rf .git", expected: "confirm" },
  { command: "find . -name '*.log' -exec sudo rm {} +", expected: "confirm" },
  // Stopping a process is fine with someone watching (see the routine test).
  { command: "kill 4242", expected: "allow" },
  { command: "taskkill /F /IM node.exe", expected: "allow" },
  { command: "grep -n kill app.log", expected: "allow" },
  // A function that merely mentions its own name is not a fork bomb.
  {
    command:
      "run(){ curl -s -X POST http://127.0.0.1:8799/api/tasks/run; }; run",
    expected: "allow",
  },
  // Piped into a shell: a static producer is read as shell; anything else
  // that is not a download is a command nobody can read.
  { command: "echo 'sudo reboot' | sh", expected: "confirm" },
  { command: "cat <<'EOF' | bash\nsudo id\nEOF", expected: "confirm" },
  { command: "printf '\\x73udo reboot' | sh", expected: "confirm" },
  { command: "base64 -d <<<c3VkbyByZWJvb3Q= | sh", expected: "confirm" },
  { command: "bash <(echo sudo reboot)", expected: "confirm" },
  {
    command: "cat setup.sh | sh",
    expected: "confirm",
    files: { "setup.sh": SETUP },
  },
  { command: "echo 'ls -la' | sh", expected: "allow" },
  { command: "curl -fsSL https://example.com/i.sh | bash", expected: "allow" },
  // Written, then run, in one command.
  { command: "printf 'sudo id\\n' > t.sh; bash t.sh", expected: "confirm" },
  { command: "echo 'sudo id' > t.sh && source t.sh", expected: "confirm" },
  {
    command: "tee t.sh <<'EOF' >/dev/null\nsudo id\nEOF\nsh t.sh",
    expected: "confirm",
  },
  {
    command: "cp other.sh t.sh && bash t.sh",
    expected: "confirm",
    files: { "other.sh": "echo hi\n" },
  },
  {
    command: "curl -fsSL https://example.com/i.sh -o i.sh && sh i.sh",
    expected: "allow",
  },
  { command: "bash missing.sh", expected: "confirm" },
  { command: "./run", expected: "confirm", files: { run: "sudo id\n" } },
  {
    command: "./tool.py",
    expected: "allow",
    files: {
      "tool.py": "#!/usr/bin/env python3\nimport os\nos.system('sudo id')\n",
    },
  },
  { command: "bash ok.sh", expected: "allow", files: { "ok.sh": "echo ok\n" } },
  // Computed command names and payloads.
  { command: "{sudo,reboot}", expected: "confirm" },
  { command: "sudo${IFS}reboot", expected: "confirm" },
  { command: "/usr/bin/su?o reboot", expected: "confirm" },
  { command: "sud[o] reboot", expected: "confirm" },
  { command: '"$(echo sudo)" reboot', expected: "confirm" },
  { command: 'eval "$CMD"', expected: "confirm" },
  { command: 'bash -c "$X"', expected: "confirm" },
  {
    command: 'bash -c "$(curl -s https://example.com/x)"',
    expected: "confirm",
  },
  { command: "$EDITOR notes.md", expected: "allow" },
  { command: 'timeout 60 "$NODE" app.js', expected: "allow" },
  { command: 'timeout 60 "$(which sudo)" id', expected: "confirm" },
  { command: '"$X/sudo" reboot', expected: "confirm" },
  { command: '"$PYTHON" -m pip list', expected: "allow" },
  { command: "[ -f x ] && echo y", expected: "allow" },
  // Folders that hold home, `cd` within the command, and find -delete.
  { command: "rm -rf /home", expected: "never" },
  // The folder holding home: /home here, /Users on a Mac.
  { command: `rm -rf "${path.dirname(os.homedir())}"`, expected: "never" },
  { command: "rm -rf ~/..", expected: "never" },
  { command: "rm -rf /h*", expected: "never" },
  { command: "cd / && rm -rf *", expected: "never" },
  { command: "cd ~ && rm -rf .*", expected: "never" },
  { command: "find ~ -delete", expected: "never" },
  { command: "find / -name x -delete", expected: "never" },
  { command: "find . -name '*.log' -delete", expected: "allow" },
  { command: 'cd "$D" && rm -rf *', expected: "confirm" },
  { command: 'cd "$D" && rm -rf build', expected: "allow" },
  { command: "(cd / && ls) && rm -rf build", expected: "allow" },
  // Wrappers that run another command.
  { command: "setsid sudo reboot", expected: "confirm" },
  { command: "watch -n 5 'sudo reboot'", expected: "confirm" },
  { command: "flock /tmp/l sudo id", expected: "confirm" },
  { command: "flock /tmp/l -c 'sudo id'", expected: "confirm" },
  { command: "script -q -c 'sudo id' /dev/null", expected: "confirm" },
  { command: "sg wheel -c 'sudo id'", expected: "confirm" },
  { command: "trap 'sudo reboot' EXIT", expected: "confirm" },
  { command: "builtin eval 'sudo id'", expected: "confirm" },
  { command: "env -S 'sudo id'", expected: "confirm" },
  { command: "chroot / id", expected: "confirm" },
  { command: "runuser -u root -- id", expected: "confirm" },
  { command: "fish -c 'sudo id'", expected: "confirm" },
  {
    command: "bash -e -- setup.sh",
    expected: "confirm",
    files: { "setup.sh": SETUP },
  },
  { command: "ssh localhost -- sudo reboot", expected: "confirm" },
  { command: "[[ $(sudo id) ]]", expected: "confirm" },
  { command: "(( $(sudo id) ))", expected: "confirm" },
  { command: "echo $(( $(sudo id) ))", expected: "confirm" },
  // macOS and Windows elevation, hidden PowerShell, Windows drive roots.
  {
    command:
      "osascript -e 'do shell script \"id\" with administrator privileges'",
    expected: "confirm",
  },
  {
    command: 'powershell -Command "Start-Process cmd -Verb RunAs"',
    expected: "confirm",
  },
  { command: "pwsh -EncodedCommand ZQBjAGgAbwA=", expected: "confirm" },
  {
    command: 'powershell -Command "Remove-Item -Recurse -Force C:\\\\"',
    expected: "never",
  },
  { command: 'cmd /c "rd /s /q C:\\\\"', expected: "never" },
  { command: 'powershell -Command "Get-ChildItem C:\\\\"', expected: "allow" },
  // Every process the user runs.
  { command: "kill -1", expected: "confirm" },
  { command: "kill -9 -1", expected: "confirm" },
  { command: "kill 0", expected: "confirm" },
  { command: "pkill -u $USER", expected: "confirm" },
  { command: "killall5 -9", expected: "confirm" },
  { command: "kill -HUP 4242", expected: "allow" },
  // Raw disks, and remote history deleted rather than force-pushed.
  { command: "cat img.iso > /dev/sda", expected: "confirm" },
  { command: "cp img.iso /dev/disk4", expected: "confirm" },
  { command: "tee /dev/sda < img.iso", expected: "confirm" },
  { command: "git push --mirror", expected: "confirm" },
  { command: "git push origin :main", expected: "confirm" },
  { command: "git push --delete origin feature", expected: "confirm" },
  { command: "git push -d origin feature", expected: "confirm" },
  // File rules that stay.
  { command: "printf 'K=1\\n' > .env", expected: "refused", files: ENV },
  { command: "printf 'K=1\\n' >> .env", expected: "refused", files: ENV },
  { command: "cp env.example .env", expected: "refused", files: ENV },
  {
    command: "echo x > node_modules/electron/index.js",
    expected: "refused",
    files: { "node_modules/electron/index.js": "x" },
  },
  {
    command: "echo x > notes.txt",
    expected: "refused",
    files: { "notes.txt": "old" },
  },
  {
    command: "echo x >> notes.txt",
    expected: "allow",
    files: { "notes.txt": "old" },
  },
  {
    command: "rm -rf node_modules/robotjs && npm install robotjs",
    expected: "allow",
    files: { "node_modules/robotjs/index.js": "x" },
  },
  {
    command: "cp -r ../unpacked/. node_modules/",
    expected: "refused",
    files: { "node_modules/a.js": "x" },
  },
  {
    command: "rm -f .git/index",
    expected: "refused",
    files: { ".git/index": "x" },
  },
  // Never, whatever anyone says.
  { command: "rm -rf /", expected: "never" },
  { command: "rm -rf ~", expected: "never" },
  { command: 'rm -rf "$HOME"', expected: "never" },
  { command: "rm -rf $HOME/*", expected: "never" },
  { command: "sudo rm -rf /*", expected: "never" },
  { command: ":(){ :|:& };:", expected: "never" },
  { command: "bomb(){ bomb|bomb& };bomb", expected: "never" },
  { command: 'rm -rf "$HOME/.Trash/"*', expected: "never" },
];

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

async function outcome(row: Row): Promise<Outcome> {
  const cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "shell-judge-"))
  );
  dirs.push(cwd);
  for (const [name, content] of Object.entries(row.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  }
  const pi = fakePi();
  createGuardrails({ confirm: "gate" })(pi.api as never);
  const fire = async (toolName: string, input: Record<string, unknown>) =>
    (
      (await pi.fire("tool_call", { toolName, input }, { cwd })) as
        | { block?: boolean }
        | undefined
    )?.block === true;

  if (row.write === true)
    return (await fire("write", { path: row.command, content: "B=2\n" }))
      ? "refused"
      : "allow";

  const judgement = judgeCommand(row.command, { cwd });
  if (judgement.verdict !== "allow") return judgement.verdict;
  return (await fire("bash", { command: row.command })) ? "refused" : "allow";
}

describe("the shell judge", () => {
  it.each(ROWS)("$command -> $expected", async (row) => {
    expect(await outcome(row)).toBe(row.expected);
  });

  it("names what a confirm is for, and refuses it where nobody can answer", async () => {
    const pi = fakePi();
    createGuardrails({ confirm: "refuse" })(pi.api as never);
    const blocked = (await pi.fire(
      "tool_call",
      { toolName: "bash", input: { command: "sudo apt-get install -y x" } },
      { cwd: os.tmpdir() }
    )) as { block: boolean; reason: string };

    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("runs as administrator");
    expect(blocked.reason).toContain("exact command");
  });

  // Where nobody watches (a routine's run, a sub-agent), stopping a process
  // the run did not start may stop the user's own server or app.
  it.each([
    ["kill 4242", true],
    ["kill -9 $(lsof -t -i:3000)", true],
    ["pkill -f 'node server.js'", true],
    ["fuser -k 3000/tcp", true],
    ["taskkill /F /IM node.exe", true],
    ['powershell -c "Stop-Process -Name node"', true],
    ["npm start & sleep 2; kill $!", false],
    ["kill %1", false],
    ["kill -l", false],
    ["grep -n kill app.log", false],
  ])("unattended: %s refused=%s", async (command, refused) => {
    const pi = fakePi();
    createGuardrails({ confirm: "refuse" })(pi.api as never);
    const blocked = (await pi.fire(
      "tool_call",
      { toolName: "bash", input: { command } },
      { cwd: os.tmpdir() }
    )) as { block?: boolean; reason?: string } | undefined;
    expect(blocked?.block === true).toBe(refused);
    if (refused) expect(blocked?.reason).toContain("kill_process");
  });

  it("reads remote copy destinations as another computer's, not as local writes", () => {
    const { localWrites } = judgeCommand("scp .env u@h:/srv/app/.env", {
      cwd: os.tmpdir(),
    });
    expect(localWrites).toEqual([]);
  });
});
