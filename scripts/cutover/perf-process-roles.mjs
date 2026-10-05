import { connect } from "./cdp.mjs";

/** Classify only descendants of the launched app, never an agent ancestor. */
export function processRoles(row, rootPid, renderers = []) {
  if (row.pid === rootPid) return ["main"];
  const roles = renderers.filter((r) => r.pid === row.pid).map((r) => r.role);
  if (roles.length) return [...new Set(roles)];
  if (/(?:[/\\]agent[/\\]|--thread-id)/.test(row.command)) return ["agent"];
  if (/--type=gpu-process/.test(row.command)) return ["GPU"];
  if (/--type=renderer/.test(row.command)) return ["renderer"];
  if (/--utility-sub-type=network/.test(row.command)) return ["network"];
  return ["utility"];
}

export async function electronRendererRoles(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) =>
    r.json()
  );
  const inspector = await connect(targets[0].webSocketDebuggerUrl);
  try {
    return await inspector.evaluate(
      `(() => { const {webContents} = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); return webContents.getAllWebContents().map(c => ({ pid: c.getOSProcessId(), role: c.getURL().includes('notch') ? 'notch/companion' : 'renderer' })); })()`
    );
  } finally {
    inspector.close();
  }
}
