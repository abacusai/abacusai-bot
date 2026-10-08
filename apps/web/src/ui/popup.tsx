import { Children, isValidElement, type ReactNode } from "react";

export const popupPositioning = {
  collisionPadding: 8,
  collisionAvoidance: { side: "flip", align: "shift", fallbackAxisSide: "end" },
} as const;

export const popupItemTitle = (children: ReactNode): string =>
  Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      if (isValidElement<{ children?: ReactNode }>(child))
        return popupItemTitle(child.props.children);
      return "";
    })
    .filter(Boolean)
    .join(" ");

export const popupItemChildren = (children: ReactNode): ReactNode =>
  Children.map(children, (child) =>
    typeof child === "string" || typeof child === "number" ? (
      <span className="popup-label" title={String(child)}>
        {child}
      </span>
    ) : (
      child
    )
  );
