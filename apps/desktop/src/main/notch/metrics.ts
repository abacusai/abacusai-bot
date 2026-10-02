import { execFile } from "node:child_process";

import type { DisplayGeometry, Rect } from "./geometry";
export interface ProbedScreen {
  frame: Rect;
  top: number;
  left: number;
  right: number;
}
export type ProbeResult =
  | { kind: "ok"; screens: ProbedScreen[] }
  | {
      kind: "unavailable";
      reason: "selectors-unavailable" | "timeout" | "exit" | "parse";
    };
// Derived directly from AppKit NSScreen's struct fields, never inferred from model names.
export const METRICS_JXA = `ObjC['import']('AppKit');
function rect(r) { return {x:r.origin.x,y:r.origin.y,width:r.size.width,height:r.size.height}; }
var list = $.NSScreen.screens, screens = [], ok = true;
for (var i = 0; i < list.count; i++) {
 var s = list.objectAtIndex(i);
 if (!s.respondsToSelector('safeAreaInsets') || !s.respondsToSelector('auxiliaryTopLeftArea') || !s.respondsToSelector('auxiliaryTopRightArea')) { ok = false; break; }
 screens.push({frame:rect(s.frame),top:s.safeAreaInsets.top,left:s.auxiliaryTopLeftArea.size.width,right:s.auxiliaryTopRightArea.size.width});
}
JSON.stringify(ok ? {ok:true,screens:screens} : {ok:false,reason:'selectors-unavailable'});`;
export const parseProbe = (raw: string): ProbeResult => {
  try {
    const value = JSON.parse(raw) as {
      ok?: boolean;
      reason?: string;
      screens?: ProbedScreen[];
    };
    if (value.ok === false && value.reason === "selectors-unavailable")
      return { kind: "unavailable", reason: "selectors-unavailable" };
    if (value.ok !== true || !Array.isArray(value.screens))
      throw new Error("shape");
    for (const s of value.screens) {
      if (
        !s.frame ||
        ![
          s.frame.x,
          s.frame.y,
          s.frame.width,
          s.frame.height,
          s.top,
          s.left,
          s.right,
        ].every(Number.isFinite) ||
        s.frame.width <= 0 ||
        s.frame.height <= 0 ||
        s.top < 0 ||
        s.left < 0 ||
        s.right < 0 ||
        s.left + s.right > s.frame.width
      )
        throw new Error("screen");
    }
    return { kind: "ok", screens: value.screens };
  } catch {
    return { kind: "unavailable", reason: "parse" };
  }
};
export const probeNotchMetrics = (): Promise<ProbeResult> =>
  new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", METRICS_JXA],
      { timeout: 3000 },
      (error, stdout) =>
        resolve(
          error
            ? { kind: "unavailable", reason: error.killed ? "timeout" : "exit" }
            : parseProbe(stdout)
        )
    );
  });
export const metricsFromProbe = (s: ProbedScreen) =>
  s.top > 0 && s.left > 0 && s.right > 0 && s.frame.width > s.left + s.right
    ? { width: s.frame.width - s.left - s.right, height: s.top }
    : null;
export const matchScreens = (
  screens: ProbedScreen[],
  displays: DisplayGeometry[],
  primaryHeight: number
) =>
  new Map(
    displays.flatMap((d) => {
      const s = screens.find(
        (s) =>
          s.frame.x === d.bounds.x &&
          s.frame.width === d.bounds.width &&
          s.frame.height === d.bounds.height &&
          primaryHeight - (s.frame.y + s.frame.height) === d.bounds.y
      );
      return s ? [[d.id, metricsFromProbe(s)] as const] : [];
    })
  );
export const metricsCacheKey = (d: DisplayGeometry & { scaleFactor: number }) =>
  `${d.id}:${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}`;
export const devMetrics = (value: string | undefined, packaged: boolean) => {
  if (packaged) return null;
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  return match && +match[1]! > 0 && +match[2]! > 0
    ? { width: +match[1]!, height: +match[2]! }
    : null;
};
