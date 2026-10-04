import type { AppClient } from "#renderer/data/transport/types";
import { i18n } from "#renderer/lib/i18n";
export const uploadFiles = async (files: File[]): Promise<string[]> => {
  const { browserConnection } =
    await import("#renderer/features/shell/connect/services");
  const host = browserConnection();
  const body = new FormData();
  files.forEach((file) => body.append("files", file, file.name));
  const response = await fetch(`${host.origin}/upload`, {
    method: "POST",
    credentials: "include",
    headers: { Authorization: `Bearer ${host.token}` },
    body,
  });
  if (!response.ok) throw new Error(`Upload failed (${response.status})`);
  const value = (await response.json()) as { paths?: unknown };
  if (
    !Array.isArray(value.paths) ||
    !value.paths.every((path) => typeof path === "string")
  )
    throw new Error("Invalid upload response");
  return value.paths;
};
export const pickHostFolder = async (
  client: AppClient
): Promise<string | null> => {
  const snapshot = await client.files.treeRoot({});
  return new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog");
    const list = document.createElement("div");
    const title = document.createElement("p");
    title.textContent = i18n.t("web.files.select");
    let selected = "";
    const done = (path: string | null) => {
      dialog.remove();
      resolve(path);
    };
    const browse = async (path: string) => {
      selected = path;
      const children = await client.files.treeChildren({ directoryPath: path });
      list.replaceChildren();
      title.textContent = path;
      for (const child of children.filter(
        (child) => child.kind === "directory"
      )) {
        const button = document.createElement("button");
        button.textContent = child.name;
        button.onclick = () => {
          void browse(child.absolutePath).catch((error) => {
            dialog.remove();
            reject(error);
          });
        };
        list.append(button);
      }
    };
    const choose = document.createElement("button");
    choose.textContent = i18n.t("web.files.open");
    choose.onclick = () => {
      if (selected) done(selected);
    };
    const cancel = document.createElement("button");
    cancel.textContent = i18n.t("web.files.cancel");
    cancel.onclick = () => done(null);
    dialog.addEventListener("cancel", () => done(null), { once: true });
    dialog.append(title, list, choose, cancel);
    document.body.append(dialog);
    dialog.showModal();
    for (const child of snapshot.fileTree.filter(
      (child) => child.kind === "directory"
    )) {
      const button = document.createElement("button");
      button.textContent = child.name;
      button.onclick = () => {
        void browse(child.absolutePath).catch((error) => {
          dialog.remove();
          reject(error);
        });
      };
      list.append(button);
    }
  });
};
export const viewHostFile = async (
  client: AppClient,
  path: string
): Promise<void> => {
  const info = await client.system.info({});
  const input = { filePath: path, hostRoot: info.paths.home };
  const dialog = document.createElement("dialog");
  const close = document.createElement("button");
  close.textContent = i18n.t("common.close");
  close.onclick = () => dialog.remove();
  dialog.append(close);
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) {
    const image = document.createElement("img");
    image.src = (await client.files.readImageAsDataUrl(input)).dataUrl;
    dialog.append(image);
  } else {
    const text = document.createElement("pre");
    text.textContent = /\.pptx$/i.test(path)
      ? JSON.stringify((await client.files.readPptx(input)).deck, null, 2)
      : (await client.files.readText(input)).content;
    dialog.append(text);
  }
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
};
