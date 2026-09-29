import { ArrowRight, Award, Gift, Link2, Monitor } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import logo from "../../assets/icon2.png";
import { Button } from "../ui";

/** Complete sentences let each language choose its own word order. */
const PROMISES = [
  { key: "Agent", icon: Award },
  { key: "Models", icon: Gift },
  { key: "Work", icon: Link2 },
  { key: "Local", icon: Monitor },
] as const;

/** The account's welcome, said once after it exists. */
export const WelcomeStep = ({
  onNext,
  dots,
}: {
  onNext: () => void;
  dots: ReactNode;
}): JSX.Element => {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-col items-center text-center"
      data-id="onboarding-welcome-connected"
    >
      <img src={logo} alt="" className="size-16 rounded-2xl shadow-sm" />

      <h1 className="text-foreground mt-7 text-4xl font-bold tracking-tight text-balance">
        {t("onboarding.connectedTitle")}
      </h1>

      <ul className="divide-border/60 mt-8 flex w-full flex-col divide-y text-left">
        {PROMISES.map(({ key, icon: Icon }) => (
          <li
            key={key}
            className="flex items-center gap-4 py-4"
            data-id={`onboarding-promise-${key.toLowerCase()}`}
          >
            <span className="bg-primary/10 dark:bg-primary/20 flex size-11 shrink-0 items-center justify-center rounded-xl">
              <Icon
                className="text-primary size-5"
                aria-hidden="true"
                strokeWidth={1.75}
              />
            </span>
            <span className="text-base leading-snug">
              {t(`onboarding.connectedPromise${key}Full`)}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-8 w-full">
        <Button
          size="lg"
          data-id="onboarding-welcome-continue"
          onClick={onNext}
          className="from-primary h-14 w-full bg-gradient-to-b to-violet-700 text-base font-semibold shadow-lg"
        >
          {t("onboarding.connectedCta")}
          <ArrowRight className="size-5" aria-hidden="true" />
        </Button>
      </div>

      <div className="mt-9">{dots}</div>
    </div>
  );
};
