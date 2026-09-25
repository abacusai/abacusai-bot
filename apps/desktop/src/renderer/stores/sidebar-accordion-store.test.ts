/**
 * One section open at a time: the invariant the whole sidebar layout rests
 * on: the open section takes the height, so two open at once would mean
 * neither has it.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useSidebarAccordion } from "./sidebar-accordion-store";

const state = () => useSidebarAccordion.getState();

beforeEach(() => {
  useSidebarAccordion.setState({ openSection: "bots" });
});

describe("the sidebar accordion", () => {
  it("opens one section and folds the one that was open", () => {
    state().toggleSection("sessions");
    expect(state().openSection).toBe("sessions");

    state().toggleSection("routines");
    expect(state().openSection).toBe("routines");
  });

  it("folds the open section when its header is pressed again", () => {
    state().toggleSection("bots");
    expect(state().openSection).toBeNull();
  });

  it("reveals a section without folding it when it is already open", () => {
    state().revealSection("sessions");
    state().revealSection("sessions");
    expect(state().openSection).toBe("sessions");
  });
});
