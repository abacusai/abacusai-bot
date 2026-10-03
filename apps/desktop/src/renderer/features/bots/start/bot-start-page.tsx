import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
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
export const BotStartPage = ({
  category = "featured",
}: {
  category?: BotTemplateCategory;
}) => {
  const { t } = useTranslation();
  const { bots } = useBots();
  const draft = useBotDraft();
  const navigate = useAppNavigate();
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
  const connected = Object.entries(connectors.data ?? {})
    .filter(([, row]) => row.state === "connected")
    .map(([id]) => id);
  const templates = orderedTemplateIds(category, connected)
    .map((id) => BOT_TEMPLATES.find((item) => item.id === id)!)
    .filter(Boolean);
  return (
    <div
      data-testid="bot-start"
      className="size-full overflow-auto"
      style={accentVars(look)}
    >
      <div className="mx-auto flex w-[calc(100%-48px)] max-w-[760px] flex-col items-center gap-5 py-8">
        {empty && (
          <>
            <h1 className="text-[22px] font-semibold">
              {t("bots.start.emptyTitle")}
            </h1>
            <p className="text-muted-foreground max-w-[420px] text-center text-[13px]">
              {t("bots.start.emptyBody")}
            </p>
          </>
        )}
        <motion.div layoutId="bot-draft-avatar">
          <BotAvatar
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
              <BotAvatar look={{ ...look, shape }} size={24} />
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
          <InputGroup className="bg-muted h-[52px] rounded-full">
            <InputGroupInput
              autoFocus={empty}
              aria-label={t("bots.form.name")}
              data-tour="bots-name-input"
              placeholder={t("bots.start.namePlaceholder")}
              value={values.name}
              maxLength={30}
              className="text-center"
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
        <div className="flex w-full flex-col gap-3">
          <p className="text-muted-foreground text-[13px]">
            {t("bots.start.templates")}
          </p>
          {!empty && (
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
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
                  <ToggleGroupItem key={id} value={id}>
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
          )}
          <div
            className={
              empty
                ? "flex flex-wrap justify-center gap-2"
                : "grid grid-cols-3 gap-2"
            }
          >
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => pick(template.id)}
                data-slot="bot-template"
                aria-describedby={`template-${template.id}`}
                className={`bg-card hover:bg-muted flex text-left ${empty ? "items-center gap-2 rounded-full px-3 py-2" : "flex-col gap-2 rounded-2xl p-3.5"}`}
              >
                <span className="flex items-center gap-2">
                  <BotAvatar
                    look={resolveLook({
                      name: template.name,
                      avatarShape: template.avatarShape,
                      avatarColor: template.avatarColor,
                    })}
                    size={empty ? 24 : 32}
                  />
                  <span className="text-sm font-medium">
                    {t(`bots.templates.${template.id}.name`)}
                  </span>
                </span>
                <span
                  id={`template-${template.id}`}
                  className={
                    empty
                      ? "sr-only"
                      : "text-muted-foreground line-clamp-2 min-h-9 text-[13px]"
                  }
                >
                  {t(`bots.templates.${template.id}.description`)}
                </span>
                {!empty && template.connectors && (
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    {t("bots.start.uses")}
                    {template.connectors.map((id) => (
                      <ConnectorMark key={id} id={id} size={12} />
                    ))}
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
