import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MODEL_CATALOG } from "#shared/models";

import { ProviderMark } from "./provider-mark";

describe("ProviderMark", () => {
  it("renders monochrome provider artwork as an image instead of a solid mask", () => {
    const { container } = render(
      <ProviderMark provider="anthropic" className="size-5" />
    );

    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("span")).toBeNull();
  });

  it("renders a deliberate mark for every provider in the model catalog", () => {
    const providers = [
      ...new Set(MODEL_CATALOG.map((model) => model.provider)),
    ];

    for (const provider of providers) {
      const { container, unmount } = render(
        <ProviderMark provider={provider} className="size-5" />
      );

      expect(container.firstElementChild, provider).not.toBeNull();
      expect(
        container.querySelector('[data-lucide="brain-circuit"]'),
        provider
      ).toBeNull();
      unmount();
    }
  });
});
