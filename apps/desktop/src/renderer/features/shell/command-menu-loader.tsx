import { useStore } from "@tanstack/react-store";
import { lazy, Suspense, useState } from "react";

import { shellStore } from "./shell-store";

const Dialog = lazy(() =>
  import("./command-menu").then((module) => ({ default: module.CommandMenu }))
);

/** Keep the dialog mounted after first use so its exit and focus restoration run. */
export const CommandMenu = () => {
  const open = useStore(shellStore, (state) => state.commandOpen);
  const [used, setUsed] = useState(false);
  if (open && !used) setUsed(true);
  if (!open && !used) return null;
  return (
    <Suspense fallback={null}>
      <Dialog />
    </Suspense>
  );
};
