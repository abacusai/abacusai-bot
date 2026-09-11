import { ipcMain } from "electron";

import { UpdateService } from "./update-service";

export function registerUpdateHandlers(updateService: UpdateService): void {
  ipcMain.handle("update:check", async () => {
    return updateService.checkForUpdates();
  });

  ipcMain.handle("update:install", async () => {
    return updateService.installUpdate();
  });

  ipcMain.handle("update:get-status", () => {
    return updateService.getStatus();
  });
}
