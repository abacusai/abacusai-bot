import "./assets/main.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "./components/common/error-boundary";
import { initI18n } from "./i18n";
import { installActivityBeacon } from "./lib/activity-beacon";
import { installUiContinuity } from "./lib/ui-continuity";
import { queryClient } from "./providers/query-provider";
import { createAppRouter } from "./router";
import { installLogCollector } from "./utils/log-collector";

// Before render, so startup failures land in the buffer Dump logs writes out.
installLogCollector();

// The throttled signal main gates a renderer swap on.
installActivityBeacon();

// Focus, caret, and scroll ride a renderer swap through these globals.
installUiContinuity();

// Backstop for what escapes React's boundary (handlers, async, rejections).
// Logged locally only; nothing is reported off the machine.
window.addEventListener("error", (event) => {
  console.error("[uncaught]", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[unhandled rejection]", event.reason);
});

// Awaited: rendering first would flash English at anyone not reading English.
await initI18n();

const router = createAppRouter(queryClient);

createRoot(document.getElementById("root")!, {
  // The global 'error' listener catches these too but without the component
  // stack; for "Maximum update depth exceeded" the JS stack only shows the
  // setState site, while componentStack names the subtree that was rendering.
  onUncaughtError: (error, errorInfo) => {
    console.error(
      "[react] uncaught render error:",
      error,
      errorInfo.componentStack
    );
  },
}).render(
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </ErrorBoundary>
);
