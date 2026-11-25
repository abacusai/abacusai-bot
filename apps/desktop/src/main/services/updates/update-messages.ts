/** The update service's own answers, worded for the user. */
export const MANUAL_INSTALL_ERROR = "Install this update from a terminal";
export const TEST_BUILD_ERROR = "Test builds do not update.";
export const CHANGED_ERROR = "The update changed meanwhile";
export const BUSY_ERROR = "The app is busy";

/**
 * Shown as they are; any other failure is the updater's own, for the log.
 */
export const UPDATE_USER_MESSAGES: ReadonlySet<string> = new Set([
  MANUAL_INSTALL_ERROR,
  TEST_BUILD_ERROR,
  CHANGED_ERROR,
  BUSY_ERROR,
]);
