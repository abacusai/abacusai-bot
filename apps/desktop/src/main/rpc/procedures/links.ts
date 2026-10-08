import { LinkPreviews } from "../../services/links/preview";
import { impl } from "./impl";

const previews = new LinkPreviews();
export const linksRouter = impl.links.router({
  preview: impl.links.preview.handler(({ input, context }) =>
    context.deps.tables.prefsStore.get().showLinkPreviews === false
      ? null
      : previews.get(input.url)
  ),
});
