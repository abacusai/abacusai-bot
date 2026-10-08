import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";

/** The account API owns identity; a pod's OS username is never a user label. */
export const accountIdentity = (
  account:
    | Pick<AbacusAccountInfo, "name" | "email" | "picture">
    | null
    | undefined
) => {
  const name = account?.name?.trim() || account?.email?.trim() || "";
  const words = name.split(/\s+/u).filter(Boolean);
  const initials =
    words.length > 1
      ? [...words[0]!][0]! + [...words.at(-1)!][0]!
      : [...name.split("@")[0]!].slice(0, 2).join("");
  return {
    name,
    initials: initials.toLocaleUpperCase() || "?",
    picture: account?.picture || undefined,
  };
};
