import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  ConnectorMark,
  CONNECTOR_MARK_IDS,
} from "#renderer/components/connector-mark";
import { DEFAULT_CHECK_IN } from "#renderer/lib/bots/check-in";
import { Button } from "#renderer/ui/button";

import { CheckInFields } from "../check-in/fields";
import { useBots } from "../data/queries";
import { BotSetupForm } from "../form/bot-form";
import { useBotModelBinding } from "../model/picker";
import { DetailsTab, MemoryTab, FilesTab } from "../panel/bot-side-panel";
import { BotsSidebar, BotsStrip } from "../sidebar/bots-sidebar";
import { BotStartPage } from "../start/bot-start-page";
import { AvatarGallery, AvatarShapes } from "./avatars";
const ids = [
  "bots-avatar",
  "bots-avatar-shapes",
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
        <FilesTab
          bot={bot}
          workspaceRoot={null}
          tab={{ id: "files:gallery" }}
          onOpen={() => {}}
        />
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
  if (fixture === "bots-avatar") return <AvatarGallery />;
  if (fixture === "bots-avatar-shapes") return <AvatarShapes />;
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
