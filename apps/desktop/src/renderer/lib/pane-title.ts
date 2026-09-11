import { useMatches } from "@tanstack/react-router";

type TitleKey =
  | string
  | ((params: Record<string, string>) => string | undefined);

type TitledMatch = {
  staticData: { titleKey?: TitleKey };
  params: Record<string, string>;
};

/**
 * The deepest matched route's own title, or undefined on the chat route.
 *
 * Pane destinations carry it in `staticData.titleKey`, the same field the
 * focused settings window builds its breadcrumb from. Deepest wins so a toolset
 * names itself rather than the list it came from.
 */
export const selectPaneTitleKey = (
  matches: readonly TitledMatch[]
): string | undefined =>
  [...matches]
    .reverse()
    .map((match) => {
      const { titleKey } = match.staticData;
      return typeof titleKey === "function" ? titleKey(match.params) : titleKey;
    })
    .find((key) => key != null);

export const usePaneTitleKey = (): string | undefined =>
  useMatches({
    select: (matches) =>
      selectPaneTitleKey(matches as unknown as readonly TitledMatch[]),
  });
