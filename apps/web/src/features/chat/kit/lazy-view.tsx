import { lazy, Suspense, type ComponentProps } from "react";

import type { ChatView as ChatViewComponent } from "./view";
const View = lazy(() =>
  import("./view").then((m) => ({ default: m.ChatView }))
);
/** Transcript presentation loads when a conversation is mounted. */
export const ChatView = (props: ComponentProps<typeof ChatViewComponent>) => (
  <Suspense fallback={null}>
    <View {...props} />
  </Suspense>
);
