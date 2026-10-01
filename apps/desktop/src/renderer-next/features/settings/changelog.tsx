import { TextPart } from "@tanstack/ai-react/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { AreaPage, GroupCard, StatePill } from "#next/components/form-kit/page";
import { parseChangelog } from "#next/lib/changelog";
import { useAppContext } from "#next/lib/use-app-context";

import changelog from "../../../../../../CHANGELOG.md?raw";
export const ChangelogPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const info = useQuery(transport.orpc.system.info.queryOptions({ input: {} }));
  return (
    <AreaPage title={t("phase5.whatsNew")}>
      {parseChangelog(changelog).map((release) => (
        <GroupCard key={release.version}>
          <div className="flex items-center gap-3 p-3">
            <h2 className="text-sm font-semibold">{release.version}</h2>
            {release.version === info.data?.appVersion && (
              <StatePill>{t("phase5.thisVersion")}</StatePill>
            )}
            <time className="text-muted-foreground text-xs">
              {release.date}
            </time>
          </div>
          <div className="p-3">
            <TextPart content={release.body} role="assistant" />
          </div>
        </GroupCard>
      ))}
    </AreaPage>
  );
};
