import { createContext, useContext, type JSX, type ReactNode } from "react";

type PreviewLinkHandler = ((href: string) => void) | null;

const PreviewLinkContext = createContext<PreviewLinkHandler>(null);

export const PreviewLinkProvider = ({
  onLinkClick,
  children,
}: {
  onLinkClick: (href: string) => void;
  children: ReactNode;
}): JSX.Element => (
  <PreviewLinkContext.Provider value={onLinkClick}>
    {children}
  </PreviewLinkContext.Provider>
);

export const usePreviewLinkHandler = (): PreviewLinkHandler =>
  useContext(PreviewLinkContext);
