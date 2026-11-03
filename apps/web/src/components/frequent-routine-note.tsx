/**
 * What a frequent schedule costs, said where it is picked: every fire is a
 * full run that spends credits, so hourly or faster adds up within days.
 */
import { frequentFiresPerDay } from "@abacus-ai/contract/routines/cron";
import { useTranslation } from "react-i18next";

export const FrequentRoutineNote = ({
  schedule,
}: {
  schedule: string | null;
}) => {
  const { t, i18n } = useTranslation();
  const fires = schedule == null ? null : frequentFiresPerDay(schedule);
  if (fires == null) return null;
  return (
    <p data-testid="routine-frequent" className="text-muted-foreground text-xs">
      {t("routines.frequent", {
        times: new Intl.NumberFormat(i18n.language).format(fires),
      })}
    </p>
  );
};
