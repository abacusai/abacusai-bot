import type { NotchLayout } from "@abacus-ai/contract/contract/notch";
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

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
  reduced = false,
}: {
  layout: NotchLayout;
  left: ReactNode;
  right: ReactNode;
  reduced?: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(reduced);
  useLayoutEffect(() => {
    const surface = ref.current?.parentElement;
    if (!surface) return;
    const measure = () =>
      setFits(
        reduced ||
          Math.abs(
            surface.getBoundingClientRect().width -
              parseFloat(surface.style.width)
          ) < 0.5
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [layout, left, right, reduced]);
  return (
    <div
      ref={ref}
      className="notch-wings"
      style={{
        height: layout.notch?.height ?? 36,
        visibility: fits ? "visible" : "hidden",
      }}
    >
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
};

/** Reveal controls only when the growing surface can contain their full layout. */
export const NotchBody = ({
  children,
  shape,
  reduced,
  onHeight,
  headerHeight = 36,
}: {
  children: ReactNode;
  shape: { width: number; height: number };
  reduced: boolean;
  onHeight?(height: number): void;
  headerHeight?: number;
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
          (Math.abs(bounds.width - shape.width) < 0.5 &&
            Math.abs(bounds.height - shape.height) < 0.5)
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [shape.width, shape.height, reduced]);
  useLayoutEffect(() => {
    const body = ref.current;
    const content = body?.firstElementChild as HTMLElement | null;
    if (!body || !content) return;
    const measure = () =>
      onHeight?.(Math.ceil(content.getBoundingClientRect().height) + 24);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [onHeight, children]);
  return (
    <div
      ref={ref}
      className="notch-body"
      style={{
        visibility: ready ? "visible" : "hidden",
        maxHeight: shape.height - headerHeight,
      }}
    >
      {children}
    </div>
  );
};
