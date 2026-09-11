/**
 * Every card in the catalog gets a mark of its own.
 *
 * The point of the table is that no connector falls back to the generic plug, so
 * the test that matters is the one nobody remembers to run by hand: add a
 * connector, forget its mark, and this fails rather than shipping a card that
 * looks like a placeholder.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CONNECTORS } from "../../connectors";
import { ConnectorLogo } from "./connector-logo";

describe("ConnectorLogo", () => {
  it.each(CONNECTORS.map((connector) => [connector.id, connector] as const))(
    "draws a mark for %s",
    (_id, connector) => {
      const { container } = render(<ConnectorLogo connector={connector} />);
      const drawn =
        container.querySelector("img") ??
        container.querySelector("svg") ??
        container.querySelector("span");

      expect(drawn).not.toBeNull();
      // The plug is the "no mark for this one" fallback, and nothing shipped
      // should be reaching it.
      expect(container.innerHTML).not.toContain("text-primary");
    }
  );

  it("paints both tiles: a colour for light, a colour for dark", () => {
    const notion = CONNECTORS.find((connector) => connector.id === "notion");
    const { container } = render(<ConnectorLogo connector={notion!} />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("style")).toContain("--mark-dark");
    expect(svg?.getAttribute("class")).toContain("dark:text-(--mark-dark)");
  });
});
