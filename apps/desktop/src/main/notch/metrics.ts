import { execFile } from "node:child_process";

import type { DisplayGeometry, Rect } from "./geometry";
export interface ProbedScreen {
  frame: Rect;
  displayId?: number;
  leftArea?: Rect | null;
  rightArea?: Rect | null;
  menuBarHeight?: number;
  scaleFactor?: number;
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
 var top = s.safeAreaInsets.top;
 var left = top > 0 ? rect(s.auxiliaryTopLeftArea) : null;
 var right = top > 0 ? rect(s.auxiliaryTopRightArea) : null;
 screens.push({displayId:ObjC.unwrap(s.deviceDescription.objectForKey("NSScreenNumber")),frame:rect(s.frame),top:top,left:left ? left.width : 0,right:right ? right.width : 0,leftArea:left,rightArea:right,menuBarHeight:s.frame.origin.y+s.frame.size.height-s.visibleFrame.origin.y-s.visibleFrame.size.height,scaleFactor:s.backingScaleFactor});
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
    for (const s of value.screens) {
      for (const area of [s.leftArea, s.rightArea]) {
        if (
          area &&
          (![area.x, area.y, area.width, area.height].every(Number.isFinite) ||
            area.width < 0 ||
            area.height < 0)
        )
          throw new Error("area");
      }
      if (s.top > s.frame.height) throw new Error("inset");
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
export const metricsFromProbe = (s: ProbedScreen) => {
  const x = s.leftArea ? s.leftArea.x + s.leftArea.width - s.frame.x : s.left;
  const right = s.rightArea
    ? s.rightArea.x - s.frame.x
    : s.frame.width - s.right;
  return s.top > 0 && x > 0 && right > x && right < s.frame.width
    ? { x, width: right - x, height: s.top }
    : null;
};
export const matchScreens = (
  screens: ProbedScreen[],
  displays: DisplayGeometry[],
  primaryHeight: number
) =>
  new Map(
    displays.flatMap((d) => {
      const s = screens.find(
        (s) =>
          (s.displayId === undefined || s.displayId === d.id) &&
          s.frame.x === d.bounds.x &&
          s.frame.width === d.bounds.width &&
          s.frame.height === d.bounds.height &&
          primaryHeight - (s.frame.y + s.frame.height) === d.bounds.y
      );
      return s ? [[d.id, metricsFromProbe(s)] as const] : [];
    })
  );
export const metricsCacheKey = (d: DisplayGeometry & { scaleFactor: number }) =>
  `${d.id}:${d.bounds.x},${d.bounds.y}:${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}`;
export const devMetrics = (value: string | undefined, packaged: boolean) => {
  if (packaged) return null;
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  return match && +match[1]! > 0 && +match[2]! > 0
    ? { width: +match[1]!, height: +match[2]! }
    : null;
};
