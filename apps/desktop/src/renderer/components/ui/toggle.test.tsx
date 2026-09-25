/**
 * The switch every on/off control in the app renders.
 *
 * Worth pinning rather than eyeballing, because the connector bugs users
 * actually reported were about this control's *state* rather than its looks: a
 * toggle that stays disabled cannot be switched back on, and `disabled` here is
 * driven by whether a save is in flight. The accessible name matters for the
 * same reason it exists: the switch shows no text of its own, so without it
 * there is nothing to find it by.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Switch } from "./switch";

describe("Switch", () => {
  it("exposes itself as a switch with its state and name", () => {
    render(
      <Switch
        checked
        aria-label="Messaging enabled"
        onCheckedChange={() => {}}
        onClick={(event) => event.stopPropagation()}
      />
    );

    const toggle = screen.getByRole("switch", { name: "Messaging enabled" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("reports the value it is being moved to, not the one it had", () => {
    const onChange = vi.fn();
    render(
      <Switch
        checked={false}
        aria-label="Slack"
        onCheckedChange={onChange}
        onClick={(event) => event.stopPropagation()}
      />
    );

    screen.getByRole("switch", { name: "Slack" }).click();

    expect(onChange.mock.calls[0]?.[0]).toBe(true);
  });

  it("turns off from on", () => {
    const onChange = vi.fn();
    render(
      <Switch
        checked
        aria-label="Slack"
        onCheckedChange={onChange}
        onClick={(event) => event.stopPropagation()}
      />
    );

    screen.getByRole("switch", { name: "Slack" }).click();

    expect(onChange.mock.calls[0]?.[0]).toBe(false);
  });

  it("does not fire while disabled", () => {
    // A save in flight is what disables it. The connector reports were about
    // this state outliving the save that armed it.
    const onChange = vi.fn();
    render(
      <Switch
        checked={false}
        disabled
        aria-label="Slack"
        onCheckedChange={onChange}
        onClick={(event) => event.stopPropagation()}
      />
    );

    screen.getByRole("switch", { name: "Slack" }).click();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not activate the row it sits in", () => {
    // Switches sit inside clickable rows; toggling one must not also select the
    // row behind it.
    const onRowClick = vi.fn();
    const onChange = vi.fn();
    render(
      <div onClick={onRowClick}>
        <Switch
          checked={false}
          aria-label="Slack"
          onCheckedChange={onChange}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    );

    screen.getByRole("switch", { name: "Slack" }).click();

    expect(onChange).toHaveBeenCalledOnce();
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
