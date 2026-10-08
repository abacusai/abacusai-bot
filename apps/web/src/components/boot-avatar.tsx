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
import { i18n } from "#renderer/lib/i18n";
import { springs, useMotionPreference } from "#renderer/lib/motion";

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
const PRODUCT_NAME = "AbacusAI Bot";
const appName = () =>
  i18n.isInitialized ? i18n.t("shell.appName") : PRODUCT_NAME;
const LOOK = defaultLook("AbacusAI Bot");
interface Home {
  element: HTMLElement;
  mood: AvatarMood;
  size: number;
  look: Look;
  reduced: boolean;
  overlay: boolean;
  onPoke?: () => void;
}
const Homes = createContext<((home: Home) => () => void) | null>(null);

export const BootAvatarHost = ({ children }: { children: ReactNode }) => {
  const [homes, setHomes] = useState<Home[]>([]);
  const live = useRef<HTMLDivElement>(null);
  const previous = useRef<DOMRect | null>(null);
  const wasOverlay = useRef(false);
  const settleUntil = useRef(0);
  const flight = useRef<{ stop(): void } | null>(null);
  useEffect(() => () => flight.current?.stop(), []);
  const home = homes.filter((item) => item.overlay).at(-1) ?? homes.at(-1);
  const [register] = useState(() => (next: Home) => {
    setHomes((all) => [...all, next]);
    return () => setHomes((all) => all.filter((item) => item !== next));
  });
  useLayoutEffect(() => {
    if (!home || !live.current) return;
    const element = live.current;
    const move = (fly = true) => {
      const to = home.element.getBoundingClientRect();
      const from = element.getBoundingClientRect();
      flight.current?.stop();
      element.style.transform = `translate(${to.x}px, ${to.y}px) scale(${to.width / 96})`;
      element.style.opacity = "1";
      if (home.overlay || wasOverlay.current)
        settleUntil.current = performance.now() + 250;
      const dialogChange = performance.now() < settleUntil.current;
      wasOverlay.current = home.overlay;
      if (dialogChange && !home.reduced) {
        flight.current = animate(
          element,
          { opacity: [0, 1] },
          { duration: 0.12 }
        );
      } else if (
        fly &&
        previous.current &&
        !home.reduced &&
        from.width &&
        Math.abs(from.x - to.x) +
          Math.abs(from.y - to.y) +
          Math.abs(from.width - to.width) >
          1
      ) {
        flight.current = animate(
          element,
          {
            transform: [
              `translate(${from.x}px, ${from.y}px) scale(${from.width / 96})`,
              element.style.transform,
            ],
          },
          springs.surface
        );
      }
      previous.current = to;
    };
    const delay = home.overlay ? setTimeout(move, 200) : null;
    if (!home.overlay) move();
    else element.style.opacity = "0";
    const follow = () => move(false);
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => {
      if (delay != null) clearTimeout(delay);
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
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
            data-avatar-scene
            className="titlebar-nodrag fixed top-0 left-0 size-24 origin-top-left"
            style={{ zIndex: home.overlay ? 60 : 20 }}
            onPointerDown={home.onPoke}
          >
            <BotAvatar
              followPointer={false}
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
  locationKey,
  reduce,
  overlay = false,
}: {
  stage?: BootStage;
  mood?: AvatarMood;
  size?: number;
  look?: Look;
  brand?: boolean;
  onPoke?: () => void;
  locationKey?: string;
  reduce?: boolean;
  overlay?: boolean;
}) => {
  const register = use(Homes);
  const element = useRef<HTMLSpanElement>(null);
  const preference = useMotionPreference();
  const reduced = reduce ?? preference === "reduced";
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
        overlay,
        onPoke,
      });
  }, [register, pose, size, look, reduced, onPoke, locationKey, overlay]);
  return (
    <div data-slot="boot-avatar" className="flex flex-col items-center gap-4">
      <span
        ref={element}
        className="inline-flex shrink-0"
        style={{ width: size, height: size }}
      >
        {!register && (
          <BotAvatar
            followPointer={false}
            look={look}
            mood={pose}
            size={size}
            animate={!reduced}
          />
        )}
      </span>
      {brand && (
        <div className="text-foreground flex items-center gap-2 text-sm font-medium">
          <BotAppMark size={22} />
          <span>{appName()}</span>
        </div>
      )}
    </div>
  );
};

export const BootScreen = () => (
  <div
    role="status"
    aria-label={appName()}
    className="bg-background text-foreground flex h-dvh items-center justify-center"
  >
    <BootAvatar />
  </div>
);
