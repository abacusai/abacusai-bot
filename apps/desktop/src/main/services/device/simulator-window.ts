/**
 * macOS window capture for the iOS Simulator mirror: find the Simulator's
 * window for desktopCapturer, and open the privacy panes it depends on.
 */
import type {
  GetSimulatorWindowSourceRequest,
  GetSimulatorWindowSourceResult,
} from "#shared/contracts";

export async function getSimulatorWindowSource(
  request: GetSimulatorWindowSourceRequest
): Promise<GetSimulatorWindowSourceResult> {
  try {
    const { desktopCapturer, systemPreferences } = await import("electron");
    // Without Screen Recording permission capture returns black frames.
    const screenPermission = (
      process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("screen")
        : "granted"
    ) as GetSimulatorWindowSourceResult["screenPermission"];
    // A non-zero thumbnail is what makes macOS show the Screen Recording
    // prompt and return real window titles; zero-size gives blank titles.
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 150, height: 150 },
      fetchWindowIcons: false,
    });
    const deviceName = request.deviceName?.toLowerCase() ?? "";
    // Titles vary by Xcode version ("iPhone 17 Pro Max – iOS 26.5" with an
    // en- or em-dash, or no OS suffix), so match generously, then fall back
    // to any window owned by the Simulator process.
    const first = (
      deviceName !== "" ? deviceName.split(/\s*[–—-]\s*/)[0] : ""
    ).trim();
    const match =
      (deviceName !== ""
        ? sources.find((s) => s.name.toLowerCase().includes(deviceName))
        : undefined) ??
      (first !== ""
        ? sources.find((s) => s.name.toLowerCase().includes(first))
        : undefined) ??
      sources.find((s) => /\s[–—-]\s*iOS\s/i.test(s.name)) ??
      sources.find((s) => /iphone|ipad/i.test(s.name)) ??
      sources.find((s) => s.name === "Simulator") ??
      sources.find((s) => /simulator/i.test(s.name));
    if (match == null) {
      const names = sources.map((s) => s.name).filter((n) => n !== "");
      return {
        screenPermission,
        error:
          screenPermission !== "granted"
            ? "Screen Recording permission is required to mirror the simulator."
            : `Simulator window not found among open windows: [${names.join(" | ")}]. Make sure the Simulator app is running (not minimized).`,
      };
    }
    return { sourceId: match.id, screenPermission };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Opens the macOS Screen Recording privacy pane. */
export async function openScreenRecordingSettings(): Promise<void> {
  if (process.platform !== "darwin") return;
  const { shell } = await import("electron");
  await shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  );
}

/** Opens the macOS Accessibility pane; the mirror's AX window control needs it. */
export async function openAccessibilitySettings(): Promise<void> {
  if (process.platform !== "darwin") return;
  const { shell } = await import("electron");
  await shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  );
}
