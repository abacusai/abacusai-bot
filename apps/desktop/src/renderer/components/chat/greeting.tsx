import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { displayName, useAccountStore } from "../../stores/account-store";

const TIME_GREETING_KEYS: Record<string, string[]> = {
  dawn: [
    "greeting.dawn.1",
    "greeting.dawn.2",
    "greeting.dawn.3",
    "greeting.dawn.4",
    "greeting.dawn.5",
  ],
  earlyMorning: [
    "greeting.earlyMorning.1",
    "greeting.earlyMorning.2",
    "greeting.earlyMorning.3",
    "greeting.earlyMorning.4",
    "greeting.earlyMorning.5",
  ],
  midMorning: [
    "greeting.midMorning.1",
    "greeting.midMorning.2",
    "greeting.midMorning.3",
    "greeting.midMorning.4",
    "greeting.midMorning.5",
  ],
  lunch: [
    "greeting.lunch.1",
    "greeting.lunch.2",
    "greeting.lunch.3",
    "greeting.lunch.4",
    "greeting.lunch.5",
  ],
  afternoon: [
    "greeting.afternoon.1",
    "greeting.afternoon.2",
    "greeting.afternoon.3",
    "greeting.afternoon.4",
    "greeting.afternoon.5",
  ],
  earlyEvening: [
    "greeting.earlyEvening.1",
    "greeting.earlyEvening.2",
    "greeting.earlyEvening.3",
    "greeting.earlyEvening.4",
    "greeting.earlyEvening.5",
  ],
  evening: [
    "greeting.evening.1",
    "greeting.evening.2",
    "greeting.evening.3",
    "greeting.evening.4",
    "greeting.evening.5",
  ],
  night: [
    "greeting.night.1",
    "greeting.night.2",
    "greeting.night.3",
    "greeting.night.4",
    "greeting.night.5",
  ],
  lateNight: [
    "greeting.lateNight.1",
    "greeting.lateNight.2",
    "greeting.lateNight.3",
    "greeting.lateNight.4",
    "greeting.lateNight.5",
  ],
  preDawn: [
    "greeting.preDawn.1",
    "greeting.preDawn.2",
    "greeting.preDawn.3",
    "greeting.preDawn.4",
    "greeting.preDawn.5",
  ],
};

const getTimeRangeKey = (): string => {
  const hour = new Date().getHours();

  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 9) return "earlyMorning";
  if (hour >= 9 && hour < 12) return "midMorning";
  if (hour >= 12 && hour < 14) return "lunch";
  if (hour >= 14 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 19) return "earlyEvening";
  if (hour >= 19 && hour < 21) return "evening";
  if (hour >= 21 && hour < 24) return "night";
  if (hour >= 0 && hour < 3) return "lateNight";
  return "preDawn";
};

const getRandomGreetingKey = (): string => {
  const timeKey = getTimeRangeKey();
  const greetings = TIME_GREETING_KEYS[timeKey];
  const randomIndex = Math.floor(Math.random() * greetings.length);
  return greetings[randomIndex];
};

export const Greeting = () => {
  const { t } = useTranslation();
  const greetingKey = useMemo(() => getRandomGreetingKey(), []);
  // Absent when nobody has signed in (a supported state); the greeting then
  // reads as it always did.
  const account = useAccountStore((state) => state.account);
  const { data: abacusAccount } = useAbacusAccountQuery();
  const name = displayName(account, abacusAccount);

  return (
    <>
      <style>
        {`
          @keyframes reveal-text {
            from { clip-path: inset(0 100% 0 0); }
            to { clip-path: inset(0 0 0 0); }
          }
        `}
      </style>
      <h1
        data-id={"greeting"}
        className="text-foreground flex w-full min-w-0 items-center justify-center text-center text-2xl font-light break-words sm:text-4xl"
        style={{
          animation: "reveal-text 0.8s ease-out forwards",
        }}
      >
        {name != null ? `${t(greetingKey)}, ${name}` : t(greetingKey)}
      </h1>
    </>
  );
};
