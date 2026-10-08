import { animate } from "motion/react";
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { BotAppMark } from "#renderer/components/app-icon";
import { BotAvatar } from "#renderer/components/bot-avatar";
import { subscribeClock } from "#renderer/components/bot-avatar/clock";
import {
  defaultLook,
  type AvatarMood,
  type Look,
} from "#renderer/lib/bots/avatar";
import { durations, easings, useMotionPreference } from "#renderer/lib/motion";

export type BootStage =
  | "waking"
  | "starting"
  | "installing"
  | "updating"
  | "connecting"
  | "reconnecting"
  | "waiting"
  | "error"
  | "open";
export const bootMood = (stage: BootStage): AvatarMood =>
  (
    ({
      waking: "asleep",
      starting: "waiting",
      installing: "focused",
      updating: "working",
      connecting: "working",
      reconnecting: "waiting",
      waiting: "waiting",
      error: "blocked",
      open: "happy",
    }) as const
  )[stage];
const LOOK = defaultLook("AbacusAI Bot");
interface Home {
  element: HTMLElement;
  mood: AvatarMood;
  size: number;
  look: Look;
  reduced: boolean;
  onPoke?: () => void;
}
const Homes = createContext<((home: Home) => () => void) | null>(null);

export const BootAvatarHost = ({ children }: { children: ReactNode }) => {
  const [homes, setHomes] = useState<Home[]>([]);
  const live = useRef<HTMLDivElement>(null);
  const previous = useRef<DOMRect | null>(null);
  const home = homes.at(-1);
  const [register] = useState(() => (next: Home) => {
    setHomes((all) => [...all, next]);
    return () => setHomes((all) => all.filter((item) => item !== next));
  });
  useLayoutEffect(() => {
    if (!home || !live.current) return;
    const element = live.current;
    const move = () => {
      const to = home.element.getBoundingClientRect();
      const from = element.getBoundingClientRect();
      element.style.transform = `translate(${to.x}px, ${to.y}px) scale(${to.width / 96})`;
      if (previous.current && !home.reduced && from.width) {
        void animate(
          element,
          {
            transform: [
              `translate(${from.x}px, ${from.y}px) scale(${from.width / 96})`,
              element.style.transform,
            ],
          },
          { duration: durations.layout / 1000, ease: easings.standard }
        );
      }
      previous.current = to;
    };
    move();
    window.addEventListener("resize", move);
    window.addEventListener("scroll", move, true);
    return () => {
      window.removeEventListener("resize", move);
      window.removeEventListener("scroll", move, true);
    };
  }, [home]);
  return (
    <Homes value={register}>
      {children}
      {home &&
        createPortal(
          <div
            ref={live}
            data-slot="boot-avatar-live"
            className="titlebar-nodrag fixed top-0 left-0 z-40 size-24 origin-top-left"
            onPointerDown={home.onPoke}
          >
            <BotAvatar
              look={home.look}
              mood={home.mood}
              size={96}
              animate={!home.reduced && home.size > 24}
            />
          </div>,
          document.body
        )}
    </Homes>
  );
};

export const BootAvatar = ({
  stage = "waking",
  mood,
  size = 88,
  look = LOOK,
  brand = true,
  onPoke,
}: {
  stage?: BootStage;
  mood?: AvatarMood;
  size?: number;
  look?: Look;
  brand?: boolean;
  onPoke?: () => void;
}) => {
  const register = use(Homes);
  const element = useRef<HTMLSpanElement>(null);
  const reduced = useMotionPreference() === "reduced";
  const [wake, setWake] = useState(0);
  useEffect(() => {
    if (stage !== "waking" || reduced) return;
    const start = performance.now() / 1000;
    return subscribeClock((seconds, visible) => {
      if (visible) setWake(Math.floor((seconds - start) / 2) % 3);
    });
  }, [stage, reduced]);
  const pose =
    mood ??
    (stage === "waking"
      ? (["asleep", "thinking", "working"] as const)[wake]!
      : bootMood(stage));
  useLayoutEffect(() => {
    if (element.current && register)
      return register({
        element: element.current,
        mood: pose,
        size,
        look,
        reduced,
        onPoke,
      });
  }, [register, pose, size, look, reduced, onPoke]);
  return (
    <div data-slot="boot-avatar" className="flex flex-col items-center gap-4">
      <span
        ref={element}
        className="inline-flex shrink-0"
        style={{ width: size, height: size }}
      >
        {!register && (
          <BotAvatar look={look} mood={pose} size={size} animate={!reduced} />
        )}
      </span>
      {brand && (
        <div className="text-foreground flex items-center gap-2 text-sm font-medium">
          <BotAppMark size={22} />
          <span>AbacusAI Bot</span>
        </div>
      )}
    </div>
  );
};

export const BootScreen = () => (
  <div
    role="status"
    aria-label="AbacusAI Bot"
    className="bg-background text-foreground flex h-dvh items-center justify-center"
  >
    <BootAvatar />
  </div>
);
