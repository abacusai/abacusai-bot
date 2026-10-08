import "./styles/app.css";
import { flushSync } from "react-dom";

import { BootScreen, BootAvatar } from "#renderer/components/boot-avatar";

import { root } from "./render-root";

flushSync(() => root.render(<BootScreen />));
void import("./main").catch((error: unknown) => {
  console.error("[renderer] module load failed", error);
  root.render(
    <div
      role="alert"
      className="bg-background text-foreground flex h-dvh items-center justify-center"
    >
      <BootAvatar stage="error" />
    </div>
  );
});
