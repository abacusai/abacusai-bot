import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render } from "@testing-library/react";
import { expect, it } from "vitest";

import company from "#renderer/assets/abacusai.svg";
import bot from "#renderer/assets/bot-icon.png";

import { BotAppMark, AppBrandMark } from "./index";

it("uses the packaged bot artwork for product chrome and keeps the company mark distinct", () => {
  const { container } = render(
    <>
      <BotAppMark size={40} />
      <AppBrandMark size={20} />
    </>
  );
  const product = container.querySelector('[data-slot="bot-app-mark"]')!;
  expect(product.getAttribute("width")).toBe("40");
  expect(product.getAttribute("height")).toBe("40");
  expect(product.querySelector("image")!.getAttribute("href")).toBe(bot);
  expect(
    container
      .querySelector('[data-slot="app-brand-mark"] image')!
      .getAttribute("href")
  ).toBe(company);
  const web = resolve(import.meta.dirname, "../../..");
  expect(readFileSync(resolve(web, "src/assets/bot-icon.png"))).toEqual(
    readFileSync(resolve(web, "../desktop/build/icons/128x128.png"))
  );
});
