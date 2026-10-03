import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";
export const ListeningControls = ({
  state,
  level,
  end,
  cancel,
}: {
  state: string;
  level: number;
  end(): void;
  cancel(): void;
}) => {
  const { t } = useTranslation();
  return (
    <div className="notch-listening">
      <h2 role="status">
        {t(
          state === "transcribing"
            ? "notch.listening.transcribing"
            : "notch.listening.title"
        )}
      </h2>
      <div className="notch-wave" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((n) => (
          <span key={n} style={{ height: 8 + level * (16 + n * 3) }} />
        ))}
      </div>
      <div className="flex gap-2">
        <Button disabled={state !== "recording"} onClick={end}>
          {t("notch.listening.end")}
        </Button>
        <Button variant="ghost" onClick={cancel}>
          {t("common.cancel")}
        </Button>
      </div>
      {state === "error" && <p role="alert">{t("notch.listening.error")}</p>}
    </div>
  );
};
