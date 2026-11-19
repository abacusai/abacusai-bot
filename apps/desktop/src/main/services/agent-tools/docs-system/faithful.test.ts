import { describe, expect, it } from "vitest";

import { unsupportedNumbers } from "./faithful";

const brief =
  "Pintura da fachada, 420 m² a R$ 28,00; 18 grades a R$ 150,00; lavagem R$ 1.900,00. Desconto de 5%. Validade de 15 dias. Prazo 20 dias úteis.";

describe("numbers the brief does not support", () => {
  // Live (E smoke): the model gave the quote a number of its own, "2026/114".
  it("finds a number that is in neither the brief nor the code's sums", () => {
    expect(
      unsupportedNumbers("Orçamento nº 2026/114 · Validade 15 dias", {
        brief,
        computed: [],
        today: "15 November 2026",
      })
    ).toEqual(["114"]);
  });

  // Round 2: "28% of revenue is roughly ₹7.7 lakh a month" (it is about ₹2.3
  // lakh) passed as a "simple derivation". A worked-out number is now either
  // computed by code (data-calc) or sent back.
  it("does not accept a derivation the code did not compute", () => {
    expect(
      unsupportedNumbers(
        "Tiffinly keeps roughly ₹7.7 lakh a month; growth 8.4%",
        {
          brief:
            "₹8.3 lakh monthly revenue, we keep 28%. Revenue 186,400 (Q2 171,900).",
          computed: [],
          today: "15 November 2026",
        }
      )
    ).toEqual(["7.7", "8.4"]);
    expect(
      unsupportedNumbers("roughly ₹2.3 lakh a month", {
        brief: "₹8.3 lakh monthly revenue, we keep 28%.",
        computed: [2.3],
        today: "15 November 2026",
      })
    ).toEqual([]);
  });
});
