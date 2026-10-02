import { execFileSync } from "node:child_process";

import { processRoles } from "./perf-process-roles.mjs";

export const processTree = (pid, renderers = []) => {
  const rows =
    process.platform === "win32"
      ? JSON.parse(
          execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress",
            ],
            { encoding: "utf8" }
          )
        ).map((row) => ({
          pid: row.ProcessId,
          parent: row.ParentProcessId,
          rssBytes: Number(row.WorkingSetSize),
          command: row.CommandLine ?? "",
        }))
      : execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .map((line) => {
            const [, pid, parent, rss, command] =
              line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/) ?? [];
            return {
              pid: Number(pid),
              parent: Number(parent),
              rssBytes: Number(rss) * 1024,
              command,
            };
          });
  const included = new Set([pid]);
  for (let i = 0; i < rows.length; i++)
    for (const row of rows) if (included.has(row.parent)) included.add(row.pid);
  const descendants = rows.filter((row) => included.has(row.pid));
  const processes = descendants.map((row) => ({
    ...row,
    roles: processRoles(row, pid, renderers),
  }));
  if (
    !processes.some((r) => r.pid === pid) ||
    processes.some((r) => !Number.isFinite(r.rssBytes))
  )
    throw new Error("Missing process-tree RSS sample");
  return {
    rssBytes: processes.reduce((sum, r) => sum + r.rssBytes, 0),
    processes,
    rssBytesWithoutAgents: processes
      .filter((row) => !row.roles.includes("agent"))
      .reduce((sum, row) => sum + row.rssBytes, 0),
    companionRssBytes: processes
      .filter(
        (row) => row.roles.length === 1 && row.roles.includes("notch/companion")
      )
      .reduce((sum, row) => sum + row.rssBytes, 0),
    sharedRendererRssBytes: processes
      .filter(
        (row) =>
          row.roles.includes("renderer") &&
          row.roles.includes("notch/companion")
      )
      .reduce((sum, row) => sum + row.rssBytes, 0),
  };
};
