import type { AppClient } from "#renderer/data/transport/types";
import { i18n } from "#renderer/lib/i18n";
export const uploadFiles = async (files: File[]): Promise<string[]> => {
  const { refreshUploadToken } =
    await import("#renderer/features/shell/connect/services");
  let host = await refreshUploadToken();
  const body = new FormData();
  files.forEach((file) => body.append("files", file, file.name));
  const token = host.token;
  const upload = () =>
    fetch(`${host.origin}/upload`, {
      method: "POST",
      credentials: "include",
      headers: { Authorization: `Bearer ${host.token}` },
      body,
    });
  let response = await upload();
  if ([401, 403].includes(response.status)) {
    host = await refreshUploadToken(true, token);
    response = await upload();
  }
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
  const [snapshot, workspaces] = await Promise.all([
    client.files.treeRoot({}),
    client.db.workspaces.snapshot({}),
  ]);
  const root = workspaces.rows.find((row) => row.isActive)?.path;
  if (!root) throw new Error("Select a workspace before choosing a folder");
  return new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog");
    const list = document.createElement("div");
    const title = document.createElement("p");
    title.textContent = i18n.t("web.files.select");
    let selected = root;
    let history = [root];
    let navigation = 0;
    let closed = false;
    const up = document.createElement("button");
    up.textContent = "Up";
    const home = document.createElement("button");
    home.textContent = "Root";
    const done = (path: string | null) => {
      closed = true;
      navigation++;
      dialog.remove();
      resolve(path);
    };
    const browse = async (path: string) => {
      const request = ++navigation;
      const children = await client.files.treeChildren({ directoryPath: path });
      if (closed || request !== navigation) return;
      selected = path;
      up.disabled = history.length === 1;
      list.replaceChildren();
      title.textContent = path;
      for (const child of children.filter(
        (child) => child.kind === "directory"
      )) {
        const button = document.createElement("button");
        button.textContent = child.name;
        button.onclick = () => {
          history.push(child.absolutePath);
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
    up.disabled = true;
    title.textContent = root;
    up.onclick = () => {
      if (history.length <= 1) return;
      history.pop();
      void browse(history[history.length - 1]!).catch(reject);
    };
    home.onclick = () => {
      history = [root];
      void browse(root).catch(reject);
    };
    dialog.append(title, up, home, list, choose, cancel);
    document.body.append(dialog);
    dialog.showModal();
    for (const child of snapshot.fileTree.filter(
      (child) => child.kind === "directory"
    )) {
      const button = document.createElement("button");
      button.textContent = child.name;
      button.onclick = () => {
        history.push(child.absolutePath);
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
  let objectUrl: string | undefined;
  const cleanup = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    dialog.remove();
  };
  close.onclick = cleanup;
  dialog.append(close);
  if (/\.pdf$/i.test(path)) {
    const { hostFiles } = await import("./host-files");
    const blob = await hostFiles.blob(input);
    objectUrl = URL.createObjectURL(
      new Blob([blob], { type: "application/pdf" })
    );
    const frame = document.createElement("iframe");
    frame.title = path;
    frame.src = objectUrl;
    dialog.append(frame);
  } else if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i.test(path)) {
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
  dialog.addEventListener("close", cleanup, { once: true });
  dialog.addEventListener("cancel", cleanup, { once: true });
  document.body.append(dialog);
  dialog.showModal();
};
