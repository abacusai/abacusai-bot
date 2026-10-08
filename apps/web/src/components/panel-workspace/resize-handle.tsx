import { ResizableHandle } from "#renderer/ui/resizable";

/** Shared side-panel gutter: keyboard resizing, hover grip and reset. */
export const PanelResizeHandle = ({ onReset }: { onReset(): void }) => (
  <ResizableHandle
    data-pane-gutter=""
    disableDoubleClick
    onDoubleClick={onReset}
    className="w-(--pane-inset) shrink-0 bg-transparent focus-visible:ring-0"
  />
);
