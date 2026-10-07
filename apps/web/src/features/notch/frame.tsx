import type { NotchLayout } from "@abacus-ai/contract/contract/notch";
import { NOTCH_SPACING as spacing } from "@abacus-ai/contract/contract/notch-spacing";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import {
  createContext,
  use,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { notch } from "#renderer/lib/motion";

import { shellClip } from "./shell-clip";
import {
  hasCamera,
  headerHeight,
  MIN_HEADER_HEIGHT,
  spacingStyle,
} from "./spacing";

const ShellReady = createContext(true);

/** The only painted surface. Children never add a second black silhouette. */
export const NotchSurface = ({
  layout,
  shape,
  reduced,
  expanded,
  style,
  children,
  ...props
}: ComponentProps<"div"> & {
  layout: NotchLayout;
  shape: { width: number; height: number };
  reduced: boolean;
  expanded: boolean;
}) => {
  const width = useMotionValue(shape.width);
  const height = useMotionValue(shape.height);
  const [ready, setReady] = useState(reduced);
  const [previous, setPrevious] = useState(shape);
  if (previous.width !== shape.width || previous.height !== shape.height) {
    setPrevious(shape);
    setReady(false);
  }
  const clipPath = useTransform([width, height], ([w, h]) =>
    shellClip(Number(w), Number(h), layout.maxShape.width, hasCamera(layout))
  );
  useLayoutEffect(() => {
    if (reduced) {
      width.set(shape.width);
      height.set(shape.height);
      return;
    }
    const transition = notch.surfaceSpring;
    const w = animate(width, shape.width, transition);
    const h = animate(height, shape.height, transition);
    let live = true;
    void Promise.all([w, h]).then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
      w.stop();
      h.stop();
    };
  }, [width, height, shape.width, shape.height, reduced]);
  return (
    <div
      {...props}
      className="notch-surface"
      style={{
        ...spacingStyle(layout),
        ...style,
        width: layout.maxShape.width,
        height: layout.maxShape.height,
      }}
    >
      <motion.div
        className="notch-shape"
        data-mode={layout.mode}
        data-reduced={reduced}
        data-expanded={expanded}
        style={{
          clipPath,
          width: layout.maxShape.width,
          height: layout.maxShape.height,
        }}
      >
        <div
          style={{
            width: shape.width,
            height: shape.height,
            marginInline: "auto",
          }}
        >
          <ShellReady value={ready || reduced}>{children}</ShellReady>
        </div>
      </motion.div>
    </div>
  );
};

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
  const ready = use(ShellReady);
  return (
    <motion.div
      className="notch-wings"
      initial={false}
      animate={{ opacity: ready ? 1 : 0 }}
      transition={{ duration: reduced ? 0 : 0.12 }}
      style={{
        height: headerHeight(layout),
        visibility: ready ? "visible" : "hidden",
      }}
    >
      {left}
      {hasCamera(layout) && (
        <div
          aria-hidden="true"
          data-slot="notch-camera-clearance"
          style={{
            width: layout.notch!.width + spacing.cameraClearance * 2,
            flexShrink: 0,
            alignSelf: "stretch",
          }}
        />
      )}
      {right}
    </motion.div>
  );
};

/** Reveal controls only when the growing surface can contain their full layout. */
export const NotchBody = ({
  children,
  shape,
  reduced,
  onHeight,
  headerHeight = MIN_HEADER_HEIGHT,
}: {
  children: ReactNode;
  shape: { width: number; height: number };
  reduced: boolean;
  onHeight?(height: number): void;
  headerHeight?: number;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const ready = use(ShellReady);
  useLayoutEffect(() => {
    const body = ref.current;
    const content = body?.firstElementChild as HTMLElement | null;
    if (!body || !content) return;
    const measure = () =>
      onHeight?.(
        Math.ceil(content.getBoundingClientRect().height) + spacing.bottom
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [onHeight, children]);
  return (
    <motion.div
      ref={ref}
      className="notch-body"
      initial={{ opacity: reduced ? 1 : 0 }}
      animate={{ opacity: ready ? 1 : 0 }}
      transition={{
        duration: reduced ? 0 : 0.15,
        delay: ready && !reduced ? 0.05 : 0,
      }}
      style={{
        visibility: ready ? "visible" : "hidden",
        pointerEvents: ready ? "auto" : "none",
        maxHeight: shape.height - headerHeight,
      }}
    >
      {children}
    </motion.div>
  );
};
