import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { renderApp } from "./app-harness";

export const mount = async (previews: Array<{ url: string }>) => {
  const os = implement(contract);
  const original = document.getElementById("root")!;
  original.style.display = "none";
  const app = await renderApp("/sessions/spreadsheet?tab=changes&view=split", {
    procedures: { links: { preview: os.links.preview.handler(({ input }) => previews.find((p) => p.url === input.url) as never ?? null) } },
  });
  Object.assign(app.view.container.style, { position: "fixed", inset: "0", zIndex: "80" });
  return app;
};
