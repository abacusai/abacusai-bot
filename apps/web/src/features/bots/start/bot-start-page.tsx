import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { ConnectorMark } from "#renderer/components/connector-mark";
import {
  defaultLook,
  resolveLook,
  accentVars,
  START_SHAPES,
  type Look,
} from "#renderer/lib/bots/avatar";
import {
  BOT_TEMPLATES,
  BOT_TEMPLATE_CATEGORIES,
  orderedTemplateIds,
  type BotTemplateCategory,
} from "#renderer/lib/bots/templates";
import { useSharedElementName } from "#renderer/lib/navigation/shared-element";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "#renderer/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "#renderer/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "#renderer/ui/toggle-group";

import { useBots, botsQueries } from "../data/queries";
import { useBotsTransport } from "../data/transport";
import { useBotDraft, updateDraft, selectTemplate } from "../form/draft-store";
import { templateColumns } from "./template-columns";
export const BotStartPage = ({
  category = "featured",
}: {
  category?: BotTemplateCategory;
}) => {
  const { t } = useTranslation();
  const { bots } = useBots();
  const draft = useBotDraft();
  const navigate = useAppNavigate();
  // The name pill is this page's composer: it morphs into the bot chat's.
  const composerStyle = useSharedElementName("composer", "composer");
  const transport = useBotsTransport();
  const connectors = useQuery(botsQueries(transport.orpc).connectorStatuses());
  const values = draft.values;
  const look = values.look;
  const empty = bots.length === 0;
  const setup = (): void => {
    if (values.name.trim())
      void navigate({ to: "/bots/new", search: { step: "setup", category } });
  };
  const pick = (id: string): void => {
    selectTemplate(id, t(`bots.templates.${id}.name`));
    void navigate({
      to: "/bots/new",
      search: { step: "setup", template: id, category },
    });
  };
  // Ranked by what was connected when the gallery mounted (cached, or none
  // yet): statuses that arrive later would move cards under the pointer,
  // so they rank the next visit instead.
  const [connected] = useState(() =>
    Object.entries(connectors.data ?? {})
      .filter(([, row]) => row.state === "connected")
      .map(([id]) => id)
  );
  const templates = orderedTemplateIds(category, connected)
    .map((id) => BOT_TEMPLATES.find((item) => item.id === id)!)
    .filter(Boolean);
  return (
    <div
      data-testid="bot-start"
      className="size-full overflow-auto"
      style={accentVars(look)}
    >
      <div className="content-col page-column items-center">
        {/* The hero (canvas BotNew): avatar, shapes and the name pill sit
            centred in a fixed band above the templates, so the page reads
            as a composed whole rather than content pushed to the top. */}
        <div
          data-slot="bot-start-hero"
          className="phone:min-h-0 phone:py-0 flex min-h-[360px] w-full flex-col items-center justify-center gap-5 py-6"
        >
          {empty && (
            <>
              <h1 className="page-title text-center">
                {t("bots.start.emptyTitle")}
              </h1>
              <p className="text-muted-foreground max-w-[420px] text-center text-[13px]">
                {t("bots.start.emptyBody")}
              </p>
            </>
          )}
          <motion.div layoutId="bot-draft-avatar">
            <BotAvatar
              animate
              look={look}
              size={96}
              mood={values.name ? "happy" : "asleep"}
            />
          </motion.div>
          <ToggleGroup
            value={[look.shape]}
            aria-label={t("bots.form.shape")}
            onValueChange={(items) => {
              if (items[0])
                updateDraft({
                  lookPicked: true,
                  values: {
                    ...values,
                    look: { ...look, shape: items[0] as Look["shape"] },
                  },
                });
            }}
          >
            {START_SHAPES.map((shape) => (
              <ToggleGroupItem
                key={shape}
                value={shape}
                aria-label={t(`bots.avatar.shapes.${shape}`)}
                className="size-8 p-1"
              >
                <BotAvatar
                  interactive={false}
                  look={{ ...look, shape }}
                  size={24}
                />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <form
            className="w-full max-w-[480px]"
            onSubmit={(event) => {
              event.preventDefault();
              setup();
            }}
          >
            <InputGroup
              className="bg-muted h-[52px] rounded-full border-0 pl-3"
              style={composerStyle}
            >
              <InputGroupInput
                autoFocus={empty}
                aria-label={t("bots.form.name")}
                data-tour="bots-name-input"
                placeholder={t("bots.start.namePlaceholder")}
                value={values.name}
                maxLength={30}
                className="h-9 text-center text-[15px] md:text-[15px]"
                onChange={(event) => {
                  const name = event.target.value;
                  updateDraft({
                    values: {
                      ...values,
                      name,
                      look: draft.lookPicked ? look : defaultLook(name),
                    },
                  });
                }}
              />
              <InputGroupAddon align="inline-end">
                <Button
                  type="submit"
                  size="icon"
                  className="bot-accent-control rounded-full"
                  aria-label={t("bots.start.setup", { name: values.name })}
                  disabled={!values.name.trim()}
                >
                  <ArrowRight />
                </Button>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </div>
        <div className="flex w-full flex-col gap-3">
          {/* One row (canvas BotNew): the label leads, the category tabs
              trail; phones stack them. */}
          <div className="phone:flex-col phone:items-stretch flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-muted-foreground text-[13px]">
              {t("bots.start.templates")}
            </p>
            <div className="phone:flex-nowrap phone:ms-0 ms-auto flex flex-wrap items-center gap-2">
              <ToggleGroup
                className="phone:min-w-0 phone:flex-nowrap phone:overflow-x-auto phone:[scrollbar-width:none] phone:pe-6 phone:[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)] flex-wrap"
                value={[category]}
                onValueChange={(items) => {
                  if (items[0])
                    void navigate({
                      to: "/bots/new",
                      search: { category: items[0] as BotTemplateCategory },
                    });
                }}
              >
                {(
                  [
                    "featured",
                    "personal-assistant",
                    "productivity",
                    "research",
                  ] as const
                ).map((id) => (
                  <ToggleGroupItem
                    key={id}
                    value={id}
                    className="phone:shrink-0"
                  >
                    {t(`bots.start.categories.${id}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="ghost" size="sm" />}
                >
                  {t("bots.start.more")}
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {BOT_TEMPLATE_CATEGORIES.filter(
                    (id) =>
                      ![
                        "featured",
                        "personal-assistant",
                        "productivity",
                        "research",
                      ].includes(id)
                  ).map((id) => (
                    <DropdownMenuItem
                      key={id}
                      onClick={() =>
                        void navigate({
                          to: "/bots/new",
                          search: { category: id },
                        })
                      }
                    >
                      {t(`bots.start.categories.${id}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {/* A symmetric grid (tokens.css): 3 or 4 equal columns, whichever
              divides the count, else the fuller last row, centred. Phones
              list templates as rows: avatar, then name and purpose. */}
          <div
            data-slot="bot-template-grid"
            style={
              { "--cols": templateColumns(templates.length) } as CSSProperties
            }
          >
            {templates.map((template, index) => (
              <button
                key={template.id}
                type="button"
                onClick={() => pick(template.id)}
                data-slot="bot-template"
                aria-describedby={`template-${template.id}`}
                style={{ "--rise-i": Math.min(index, 8) } as CSSProperties}
                className="bg-card hover:bg-muted phone-rise phone:grid phone:grid-cols-[40px_minmax(0,1fr)] phone:gap-x-3 phone:gap-y-1 phone:rounded-2xl phone:p-3 phone:active:bg-muted flex min-w-0 flex-col gap-2 rounded-xl border p-3.5 text-left"
              >
                <span className="phone:contents flex items-center gap-2">
                  <span className="phone:row-span-3 phone:self-center flex">
                    <BotAvatar
                      animate
                      look={resolveLook({
                        name: template.name,
                        avatarShape: template.avatarShape,
                        avatarColor: template.avatarColor,
                      })}
                      size={32}
                    />
                  </span>
                  <span className="text-sm font-medium">
                    {t(`bots.templates.${template.id}.name`)}
                  </span>
                </span>
                <span
                  id={`template-${template.id}`}
                  className="text-muted-foreground phone:min-h-0 line-clamp-2 min-h-9 text-[13px]"
                >
                  {t(`bots.templates.${template.id}.description`)}
                </span>
                {template.connectors && (
                  <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    {t("bots.start.uses")}
                    <span className="flex items-center gap-1">
                      {template.connectors.map((id) => (
                        <ConnectorMark key={id} id={id} size={22} />
                      ))}
                    </span>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
