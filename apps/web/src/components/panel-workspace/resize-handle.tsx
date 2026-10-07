import { ResizableHandle } from "#renderer/ui/resizable";

/** Shared side-panel gutter: keyboard resizing, hover grip and reset. */
export const PanelResizeHandle = ({ onReset }: { onReset(): void }) => (
  <ResizableHandle
    data-pane-gutter=""
    withHandle
    disableDoubleClick
    onDoubleClick={onReset}
    className="[&>div]:bg-foreground/20 w-(--pane-inset) shrink-0 bg-transparent [&>div]:opacity-0 hover:[&>div]:opacity-100 data-[separator=active]:[&>div]:opacity-100"
  />
);
