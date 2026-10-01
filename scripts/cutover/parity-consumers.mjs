import fs from "node:fs";
import path from "node:path";

import { declaredSymbols } from "./parsed-source.mjs";
export const resolveConsumer = (consumer, desktop, tree = "renderer") => {
  if (typeof consumer !== "string" || !consumer)
    throw new Error("Empty parity consumer");
  if (consumer.startsWith("retired: ")) {
    if (!/[.!?]$/.test(consumer.slice(9).trim()))
      throw new Error("Retirement requires a sentence");
    return;
  }
  const [file, symbol, extra] = consumer.split("#");
  if (
    !symbol ||
    extra ||
    ![`src/${tree}/`, "src/main/"].some((prefix) => file.startsWith(prefix)) ||
    file.includes("..")
  )
    throw new Error(`Invalid parity consumer: ${consumer}`);
  const target = path.join(desktop, file);
  if (!fs.existsSync(target) || !declaredSymbols(target).has(symbol))
    throw new Error(`Unresolved parity consumer: ${consumer}`);
};
