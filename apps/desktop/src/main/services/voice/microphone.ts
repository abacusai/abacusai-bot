import { systemPreferences } from "electron";

/**
 * macOS gates the microphone behind a one-time system prompt; asking here,
 * before getUserMedia, means a refusal reads as a permission problem rather
 * than an empty recording. Other platforms have no such gate.
 */
export const requestMicrophoneAccess = async (): Promise<boolean> => {
  if (process.platform !== "darwin") return true;
  if (systemPreferences.getMediaAccessStatus("microphone") === "granted")
    return true;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
};
