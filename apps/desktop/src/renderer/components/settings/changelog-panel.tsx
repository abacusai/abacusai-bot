import { useQuery } from "@tanstack/react-query";
import { useMemo, type JSX } from "react";
import { useTranslation } from "react-i18next";

import changelogText from "../../../../../../CHANGELOG.md?raw";
import { parseChangelog } from "../../lib/changelog";
import { Markdown } from "../common/markdown";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageLead,
} from "../layout/focused-page";
import { Badge } from "../ui/badge";

/**
 * What's new: every release, newest first, the running one marked. The text
 * is CHANGELOG.md bundled at build time (see lib/changelog.ts).
 */
export const ChangelogPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const releases = useMemo(() => parseChangelog(changelogText), []);
  const version = useQuery({
    queryKey: ["app-version"],
    queryFn: () => window.api.getAppVersion(),
    staleTime: Infinity,
  });

  return (
    <FocusedPage data-id="changelog-panel">
      <FocusedPageBody>
        <FocusedPageLead description={t("changelog.subtitle")} />
        {releases.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("changelog.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {releases.map((release) => {
              const current = version.data === release.version;
              return (
                <section
                  key={release.version}
                  className="border-border bg-sidebar/40 rounded-xl border p-4"
                  data-id={`changelog-release-${release.version}`}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <h2 className="text-foreground text-base font-semibold">
                      {release.version}
                    </h2>
                    {current && (
                      <Badge data-id="changelog-current">
                        {t("changelog.current")}
                      </Badge>
                    )}
                    {release.date != null && (
                      <span className="text-muted-foreground text-xs">
                        {release.date}
                      </span>
                    )}
                  </div>
                  <div className="text-sm">
                    <Markdown content={release.body} />
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </FocusedPageBody>
    </FocusedPage>
  );
};
