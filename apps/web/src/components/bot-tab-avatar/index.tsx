import { eq, useLiveQuery } from "@tanstack/react-db";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { useCollections } from "#renderer/data/db";
import { defaultLook, resolveLook } from "#renderer/lib/bots/avatar";
/** Tiny identities are static and do not consume the character clock's leases. */
export const BotTabAvatar = ({ botId }: { botId?: string }) => {
  const collections = useCollections();
  const { data } = useLiveQuery({
    query: (q) =>
      botId
        ? q
            .from({ bot: collections.bots })
            .where(({ bot }) => eq(bot.id, botId))
            .findOne()
        : undefined,
  });
  return (
    <BotAvatar
      look={data ? resolveLook(data) : defaultLook("AbacusAI")}
      size={18}
      animate={false}
    />
  );
};
