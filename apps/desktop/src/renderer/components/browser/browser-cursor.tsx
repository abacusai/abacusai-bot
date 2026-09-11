import { useEffect, useRef, useState, type JSX } from "react";

// A soft triangular pick, all corners rounded: no sharp points or tail.

const CURSOR_SVG = (
  <svg
    width="28"
    height="28"
    viewBox="0 0 28 28"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={{
      filter:
        "drop-shadow(0 2px 4px rgba(0,0,0,0.28)) drop-shadow(0 0.5px 1px rgba(0,0,0,0.18))",
    }}
  >
    {/* 3 outward convex edges with rounded corners, 1 inward concave edge */}
    <path
      d="M5.5 3.5 C4.2 2.8 3 3.8 3.2 5.2 L6.5 21 C6.8 22.2 8.2 22.6 9.1 21.7 L13 17.5 C13.3 17.2 13.8 17.1 14.2 17.3 L19.5 20.5 C20.7 21.2 22 20.2 21.6 18.8 L15.5 3.8 C15.1 2.6 13.5 2.3 12.8 3.3 L10 7.5 C9.7 8 9 8.1 8.5 7.7 Z"
      fill="rgba(100, 80, 255, 0.94)"
      stroke="white"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </svg>
);

const RIPPLE_DURATION = 400;

interface CursorState {
  targetX: number;
  targetY: number;
  visible: boolean;
  clicking: boolean;
}

export const BrowserCursor = ({
  cursorEvents,
}: {
  cursorEvents:
    | { type: "move"; x: number; y: number }
    | { type: "click" }
    | { type: "hide" }
    | null;
}): JSX.Element | null => {
  const [state, setState] = useState<CursorState>({
    targetX: 0,
    targetY: 0,
    visible: false,
    clicking: false,
  });
  const posRef = useRef({ x: 0, y: 0 });
  const velRef = useRef({ x: 0, y: 0 });
  const animRef = useRef<number>(0);
  const cursorRef = useRef<HTMLDivElement>(null);
  const lastEventRef = useRef<typeof cursorEvents>(null);

  useEffect(() => {
    if (cursorEvents == null || cursorEvents === lastEventRef.current) return;
    lastEventRef.current = cursorEvents;

    if (cursorEvents.type === "move") {
      setState((s) => ({
        ...s,
        targetX: cursorEvents.x,
        targetY: cursorEvents.y,
        visible: true,
      }));
    } else if (cursorEvents.type === "click") {
      setState((s) => ({ ...s, clicking: true }));
      setTimeout(
        () => setState((s) => ({ ...s, clicking: false })),
        RIPPLE_DURATION
      );
    } else if (cursorEvents.type === "hide") {
      setState((s) => ({ ...s, visible: false }));
    }
  }, [cursorEvents]);

  // Animation loop with slight randomness so the motion reads as human.
  useEffect(() => {
    if (!state.visible) {
      cancelAnimationFrame(animRef.current);
      return;
    }

    let lastTime = performance.now();

    const animate = (now: number): void => {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      const pos = posRef.current;
      const vel = velRef.current;
      const dx = state.targetX - pos.x;
      const dy = state.targetY - pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 0.5 && Math.abs(vel.x) < 0.3 && Math.abs(vel.y) < 0.3) {
        pos.x = state.targetX;
        pos.y = state.targetY;
        vel.x = 0;
        vel.y = 0;
        if (cursorRef.current) {
          cursorRef.current.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
        }
        return;
      }

      // Spring force toward target
      const stiffness = 180;
      const damping = 22;

      let fx = stiffness * dx - damping * vel.x;
      let fy = stiffness * dy - damping * vel.y;

      // A slight perpendicular force curves the path instead of a straight line.
      if (dist > 8) {
        const perpX = -dy / (dist + 0.01);
        const perpY = dx / (dist + 0.01);
        const wobble =
          Math.sin(now * 0.004) * 0.15 + Math.sin(now * 0.007) * 0.08;
        const deviationStrength = Math.min(dist * 0.4, 60);
        fx += perpX * wobble * deviationStrength;
        fy += perpY * wobble * deviationStrength;
      }

      // Micro-jitter, very subtle.
      if (dist > 3) {
        fx += (Math.random() - 0.5) * 12;
        fy += (Math.random() - 0.5) * 12;
      }

      vel.x += fx * dt;
      vel.y += fy * dt;
      pos.x += vel.x * dt;
      pos.y += vel.y * dt;

      if (cursorRef.current) {
        cursorRef.current.style.transform = `translate(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px)`;
      }

      animRef.current = requestAnimationFrame(animate);
    };

    // If cursor was hidden, snap to position first
    if (posRef.current.x === 0 && posRef.current.y === 0) {
      posRef.current = { x: state.targetX, y: state.targetY };
      velRef.current = { x: 0, y: 0 };
    }

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [state.visible, state.targetX, state.targetY]);

  if (!state.visible) return null;

  return (
    <div
      ref={cursorRef}
      className="pointer-events-none absolute top-0 left-0"
      style={{
        zIndex: 9999,
        transform: `translate(${posRef.current.x}px, ${posRef.current.y}px)`,
        transition: "opacity 0.2s ease",
        opacity: state.visible ? 1 : 0,
        willChange: "transform",
      }}
    >
      {CURSOR_SVG}
      {state.clicking && (
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: 0,
            height: 0,
            background: "rgba(100, 80, 255, 0.2)",
            animation: `mcp-ripple ${RIPPLE_DURATION}ms ease-out forwards`,
          }}
        />
      )}
      <style>{`
        @keyframes mcp-ripple {
          0% { width: 0; height: 0; opacity: 0.7; }
          100% { width: 40px; height: 40px; opacity: 0; }
        }
      `}</style>
    </div>
  );
};
