import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import type { NotchLayout } from "#shared/contract/notch";

import { notchOutline } from "./outline";

/** The only painted surface. Children never add a second black silhouette. */
export const NotchSurface = ({
  layout,
  shape,
  reduced,
  expanded,
  style,
  ...props
}: ComponentProps<"div"> & {
  layout: NotchLayout;
  shape: { width: number; height: number };
  reduced: boolean;
  expanded: boolean;
}) => (
  <div
    {...props}
    className="notch-shape"
    data-mode={layout.mode}
    data-reduced={reduced}
    data-expanded={expanded}
    style={{
      ...style,
      width: shape.width,
      height: shape.height,
      clipPath: layout.mode === "notch" ? notchOutline() : undefined,
    }}
  />
);

/** Equal flexible ears keep the fixed camera exclusion centered during resizing. */
export const NotchHeader = ({
  layout,
  left,
  right,
}: {
  layout: NotchLayout;
  left: ReactNode;
  right: ReactNode;
}) => (
  <div className="notch-wings" style={{ height: layout.notch?.height ?? 36 }}>
    {left}
    {layout.notch && (
      <div
        aria-hidden="true"
        style={{ width: layout.notch.width, flexShrink: 0 }}
      />
    )}
    {right}
  </div>
);

/** Reveal controls only when the growing surface can contain their full layout. */
export const NotchBody = ({
  children,
  shape,
  reduced,
}: {
  children: ReactNode;
  shape: { width: number; height: number };
  reduced: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(reduced);
  useLayoutEffect(() => {
    const surface = ref.current?.parentElement;
    if (!surface) return;
    const measure = () => {
      const bounds = surface.getBoundingClientRect();
      setReady(
        reduced ||
          (bounds.width >= shape.width - 0.5 &&
            bounds.height >= shape.height - 0.5)
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [shape.width, shape.height, reduced]);
  return (
    <div
      ref={ref}
      className="notch-body"
      style={{ visibility: ready ? "visible" : "hidden" }}
    >
      {children}
    </div>
  );
};
