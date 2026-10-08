import { createRoot, type Root } from "react-dom/client";

import { BootAvatarHost } from "#renderer/components/boot-avatar";

const container = document.getElementById("root");
if (!container) throw new Error("renderer: #root is missing");
const reactRoot = createRoot(container, {
  onUncaughtError: (error) => console.error("[renderer] render error", error),
});

export const root: Root = {
  ...reactRoot,
  render: (children) =>
    reactRoot.render(<BootAvatarHost>{children}</BootAvatarHost>),
  unmount: () => reactRoot.unmount(),
};
