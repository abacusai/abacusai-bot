import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { platformSystem } from "#platform/system";
import { GroupCard } from "#renderer/components/form-kit/page";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Badge } from "#renderer/ui/badge";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";
import { ScrollArea } from "#renderer/ui/scroll-area";
import { Skeleton } from "#renderer/ui/skeleton";

interface LicensePackage {
  name: string;
  version: string;
  license: string;
  url?: string;
  textHash: string;
  review?: string;
}
interface LicenseData {
  packages: LicensePackage[];
  texts: Record<string, string>;
  /** False when the build ships no Chromium of its own (web), so there are no runtime notices to link. */
  runtimeNotices?: boolean;
}
const asset = (name: string) =>
  IS_ELECTRON
    ? new URL(`./licenses/${name}`, window.location.href).href
    : `${import.meta.env.BASE_URL}licenses/${name}`;
async function loadLicenses(): Promise<LicenseData> {
  const response = await fetch(asset("licenses.json"));
  if (!response.ok) throw new Error("License data unavailable");
  return response.json() as Promise<LicenseData>;
}

export function Licenses() {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(40);
  const query = useDeferredValue(search.trim().toLowerCase());
  const data = useQuery({
    queryKey: ["open-source-licenses"],
    queryFn: loadLicenses,
    staleTime: Infinity,
  });
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!data.isPending) list.current?.scrollIntoView({ block: "start" });
  }, [data.isPending]);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (value: string, id: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
    } catch {
      setCopied(null);
    }
  };
  const matches = (data.data?.packages ?? []).filter((entry) =>
    `${entry.name} ${entry.version} ${entry.license}`
      .toLowerCase()
      .includes(query)
  );
  const groups = new Map<string, LicensePackage[]>();
  for (const entry of matches.slice(0, limit)) {
    const group = groups.get(entry.license) ?? [];
    group.push(entry);
    groups.set(entry.license, group);
  }
  return (
    <section
      ref={list}
      aria-label={t("settings.licenses.title")}
      className="flex min-w-0 flex-col gap-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {t("settings.licenses.title")}
        </h2>
        <div className="flex flex-wrap gap-2">
          <a
            className="text-muted-foreground text-xs underline underline-offset-4"
            href={asset("THIRD_PARTY_NOTICES.txt")}
            download="THIRD_PARTY_NOTICES.txt"
          >
            {t("settings.licenses.notices")}
          </a>
          {data.data?.runtimeNotices !== false && (
            <a
              className="text-muted-foreground text-xs underline underline-offset-4"
              href={asset("LICENSES.chromium.html")}
              download="LICENSES.chromium.html"
            >
              {t("settings.licenses.runtime")}
            </a>
          )}
        </div>
      </div>
      <Input
        aria-label={t("settings.licenses.search")}
        placeholder={t("settings.licenses.search")}
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setLimit(40);
        }}
      />
      {data.isPending ? (
        <Skeleton className="h-32" />
      ) : data.isError ? (
        <div role="alert" className="flex items-center gap-2">
          <p>{t("settings.licenses.failed")}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void data.refetch()}
          >
            {t("phase5.retry")}
          </Button>
        </div>
      ) : (
        <>
          <p role="status" className="text-muted-foreground text-xs">
            {t("settings.licenses.count", { count: matches.length })}
          </p>
          <ScrollArea className="[&>[data-slot=scroll-area-viewport]]:scroll-fade-y h-[min(52vh,480px)]">
            <div className="flex flex-col gap-4 py-3 pr-3">
              {[...groups].map(([license, entries]) => (
                <GroupCard key={license} title={license}>
                  {entries.map((entry) => {
                    const id = `${entry.name}@${entry.version}`;
                    return (
                      <details key={id} className="min-w-0 px-3 py-2">
                        <summary className="focus-visible:outline-ring cursor-pointer rounded-sm text-xs">
                          <span className="ml-2 font-medium break-words">
                            {entry.name}
                          </span>{" "}
                          <span className="text-muted-foreground mr-2">
                            {entry.version}
                          </span>
                          <Badge variant="secondary">{entry.license}</Badge>
                        </summary>
                        <div className="mt-3 flex flex-col gap-3">
                          {entry.review && (
                            <p className="text-muted-foreground text-xs">
                              {entry.review}
                            </p>
                          )}
                          {entry.url && (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                                {entry.url}
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={t("settings.licenses.copyLink", {
                                  name: entry.name,
                                })}
                                onClick={() => void copy(entry.url!, id)}
                              >
                                {copied === id
                                  ? t("settings.licenses.copied")
                                  : t("phase5.copy")}
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                aria-label={t("settings.licenses.openLink", {
                                  name: entry.name,
                                })}
                                onClick={() =>
                                  void platformSystem(
                                    transport.client
                                  ).openExternal({ url: entry.url! })
                                }
                              >
                                {t("settings.licenses.open")}
                              </Button>
                            </div>
                          )}
                          <pre
                            className="bg-muted text-muted-foreground max-h-64 overflow-auto rounded-md p-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
                            tabIndex={0}
                            aria-label={t("settings.licenses.text", {
                              name: entry.name,
                            })}
                          >
                            {data.data.texts[entry.textHash]}
                          </pre>
                        </div>
                      </details>
                    );
                  })}
                </GroupCard>
              ))}
              {matches.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  {t("settings.licenses.empty")}
                </p>
              )}
              {matches.length > limit && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setLimit((value) => value + 40)}
                >
                  {t("settings.licenses.more")}
                </Button>
              )}
            </div>
          </ScrollArea>
        </>
      )}
    </section>
  );
}
