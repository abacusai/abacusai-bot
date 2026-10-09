import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, expect, it } from "vitest";

const agent = fileURLToPath(new URL("..", import.meta.url));
const homes: string[] = [];
const pins = {
  x64: [
    "w64u",
    "6e263d154d8548d1eb936f65d1d8312c80df31c45974e48d6335e4dcc0f4f34c",
  ],
  arm64: [
    "w64a",
    "e67f873d19d58c535cc9f0c4965ffd622e19b7bab87e3da89cb2185fb54464d7",
  ],
} as const;

afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});

function fixture(arch: keyof typeof pins) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "busybox-vendor-"));
  homes.push(home);
  const write = (name: string, body: string) => {
    const dest = path.join(home, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  };
  write("package.json", '{"type":"module"}');
  fs.cpSync(path.join(agent, "scripts"), path.join(home, "scripts"), {
    recursive: true,
  });
  fs.cpSync(
    path.join(agent, "assets/busybox"),
    path.join(home, "assets/busybox"),
    { recursive: true }
  );
  const config = "node_modules/@abacus-ai/config";
  write(
    `${config}/package.json`,
    '{"type":"module","exports":{"./vendor-fetch":"./vendor-fetch.js"}}'
  );
  fs.copyFileSync(
    path.join(agent, "../config/vendor-fetch.js"),
    path.join(home, config, "vendor-fetch.js")
  );
  const cache = `node_modules/.cache/vendor-tools/win32-${arch}`;
  for (const file of [
    "rg.exe",
    "fd.exe",
    "mxc/wxc-exec.exe",
    "mxc/plm.exe",
    "mxc/winhttp-proxy-shim.exe",
  ])
    write(`${cache}/${file}`, "unrelated cached tool");
  write(
    "offline.mjs",
    `import fs from 'node:fs'; globalThis.fetch = async () => { fs.appendFileSync(process.env.BUSYBOX_VENDOR_REQUEST_LOG, 'request\\n'); return new Response('Forbidden', {status:403, statusText:'Forbidden'}); };`
  );
  return {
    home,
    payload: path.join(
      home,
      "assets/busybox",
      `busybox-${pins[arch][0]}-FRP-6075-g169694ebd.exe`
    ),
    cached: path.join(home, cache, "busybox.exe"),
    shipped: path.join(home, "vendor/busybox.exe"),
    run: () =>
      spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(path.join(home, "offline.mjs")).href,
          path.join(home, "scripts/download-tools.js"),
          "--platform=win32",
          `--arch=${arch}`,
        ],
        {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            BUSYBOX_VENDOR_REQUEST_LOG: path.join(home, "requests"),
          },
        }
      ),
  };
}

it.each(["x64", "arm64"] as const)(
  "stages the pinned %s shell without reaching the blocked release host",
  (arch) => {
    const f = fixture(arch);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const body = fs.readFileSync(f.shipped);
    expect(createHash("sha256").update(body).digest("hex")).toBe(pins[arch][1]);
    expect(fs.existsSync(path.join(f.home, "requests"))).toBe(false);
  }
);

it("replaces stale cached BusyBox bytes with the verified payload", () => {
  const f = fixture("x64");
  fs.writeFileSync(f.cached, "wrong cached executable");
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(f.shipped)).toEqual(fs.readFileSync(f.payload));
});

it.each(["missing", "corrupt"] as const)(
  "refuses a %s payload even when a cache exists",
  (failure) => {
    const f = fixture("arm64");
    fs.copyFileSync(f.payload, f.cached);
    if (failure === "missing") fs.unlinkSync(f.payload);
    else fs.writeFileSync(f.payload, "tampered executable");
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      failure === "missing" ? "ENOENT" : "checksum mismatch"
    );
    expect(fs.existsSync(f.shipped)).toBe(false);
    expect(fs.existsSync(path.join(f.home, "requests"))).toBe(false);
  }
);
