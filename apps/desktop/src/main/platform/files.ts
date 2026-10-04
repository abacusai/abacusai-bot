export interface HostFileOperations {
  trashItem(file: string): Promise<void>;
}
export const electronFileOperations: HostFileOperations = {
  trashItem: async (file) => {
    const { shell } = await import("electron");
    await shell.trashItem(file);
  },
};
