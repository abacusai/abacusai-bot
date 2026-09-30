import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#next/components/bot-avatar";
import {
  ConnectorMark,
  CONNECTOR_MARK_IDS,
} from "#next/components/connector-mark";
import {
  AVATAR_SHAPES,
  AVATAR_PALETTE,
  AVATAR_ACCESSORIES,
  LIFECYCLE_MOODS,
  defaultLook,
} from "#next/lib/bots/avatar";
import { DEFAULT_CHECK_IN } from "#next/lib/bots/check-in";
import { Button } from "#next/ui/button";

import { CheckInFields } from "../check-in/fields";
import { useBots } from "../data/queries";
import { BotSetupForm } from "../form/bot-form";
import { useBotModelBinding } from "../model/picker";
import { DetailsTab, MemoryTab, FilesTab } from "../panel/bot-side-panel";
import { BotsSidebar, BotsStrip } from "../sidebar/bots-sidebar";
import { BotStartPage } from "../start/bot-start-page";
const ids = [
  "bots-avatar",
  "bots-connector-marks",
  "bots-sidebar",
  "bots-start",
  "bots-setup",
  "bots-panel",
  "bots-memory",
  "bots-files",
  "bots-check-in",
  "bots-chat",
] as const;
const Nav = ({ fixture }: { fixture: string | undefined }) => {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <Button
          key={id}
          variant={fixture === id ? "secondary" : "ghost"}
          onClick={() =>
            void navigate({
              to: "/__ui",
              search: (previous) => ({ ...previous, fixture: id }),
            })
          }
        >
          {id}
        </Button>
      ))}
    </div>
  );
};
const PanelGallery = ({ kind }: { kind: string }) => {
  const { bots } = useBots();
  const bot = bots[0];
  const binding = useBotModelBinding(
    bot?.model ?? null,
    () => {},
    bot ? `model:${bot.id}` : undefined
  );
  if (!bot) return null;
  return (
    <div className="w-[360px] rounded-xl border">
      {kind === "bots-memory" ? (
        <MemoryTab bot={bot} />
      ) : kind === "bots-files" ? (
        <FilesTab bot={bot} workspaceRoot={null} onClosePreview={() => {}} />
      ) : (
        <DetailsTab
          bot={bot}
          binding={binding}
          modelInComposer={false}
          setTab={() => {}}
        />
      )}
    </div>
  );
};
const CheckGallery = () => {
  const [value, setValue] = useState(DEFAULT_CHECK_IN);
  return (
    <div className="max-w-[420px]">
      <CheckInFields value={value} onChange={setValue} />
    </div>
  );
};
const View = ({
  fixture,
}: {
  fixture: string;
  step: number | undefined;
  play: boolean;
}) => {
  const { t } = useTranslation();
  const look = defaultLook("Assistant");
  if (fixture === "bots-avatar")
    return (
      <div className="flex flex-wrap gap-5">
        {AVATAR_SHAPES.map((shape) => (
          <div key={shape} className="flex flex-col items-center gap-2">
            <BotAvatar look={{ ...look, shape }} size={56} />
            <span className="text-xs">{t(`bots.avatar.shapes.${shape}`)}</span>
          </div>
        ))}
        {AVATAR_PALETTE.map(({ id, hex }) => (
          <BotAvatar key={id} look={{ ...look, color: hex }} size={36} />
        ))}
        {AVATAR_ACCESSORIES.map((accessory) => (
          <BotAvatar key={accessory} look={{ ...look, accessory }} size={56} />
        ))}
        {LIFECYCLE_MOODS.map((mood) => (
          <BotAvatar key={mood} look={look} mood={mood} size={56} />
        ))}
      </div>
    );
  if (fixture === "bots-connector-marks")
    return (
      <div className="flex flex-wrap gap-4">
        {CONNECTOR_MARK_IDS.map((id) => (
          <div key={id} className="flex gap-2">
            <ConnectorMark id={id} size={16} />
            <ConnectorMark id={id} size={28} />
            <ConnectorMark id={id} size={40} />
          </div>
        ))}
      </div>
    );
  if (fixture === "bots-sidebar")
    return (
      <div className="bg-sidebar flex h-[600px] gap-4">
        <div className="w-[280px]">
          <BotsSidebar />
        </div>
        <div className="w-[88px]">
          <BotsStrip />
        </div>
      </div>
    );
  if (fixture === "bots-start")
    return (
      <div className="h-[700px]">
        <BotStartPage />
      </div>
    );
  if (fixture === "bots-setup")
    return (
      <div className="h-[700px]">
        <BotSetupForm load={async () => {}} />
      </div>
    );
  if (fixture === "bots-check-in") return <CheckGallery />;
  return <PanelGallery kind={fixture} />;
};
export const botsGallerySections = { Nav, View };
export const isBotsGalleryFixture = (fixture: string) =>
  ids.some((id) => id === fixture);
