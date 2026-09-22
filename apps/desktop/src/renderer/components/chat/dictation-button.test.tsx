/**
 * The microphone button's three faces (dictate, stop, transcribing) and the
 * text it hands back.
 */
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DictationState } from "../../voice/use-dictation";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { percent?: number }) =>
      options?.percent == null ? key : `${key}:${options.percent}`,
  }),
}));

const dictation = vi.hoisted(() => ({
  state: {
    phase: "idle",
    level: 0,
    download: null,
    error: null,
  } as DictationState,
  toggle: vi.fn(),
  onText: null as ((text: string) => void) | null,
}));

vi.mock("../../voice/use-dictation", () => ({
  useDictation: (onText: (text: string) => void) => {
    dictation.onText = onText;
    return { ...dictation.state, toggle: dictation.toggle, cancel: () => {} };
  },
}));

const { DictationButton } = await import("./dictation-button");

const button = (): HTMLButtonElement => {
  const node = document.querySelector<HTMLButtonElement>(
    '[data-id="local-code-dictation-btn"]'
  );
  if (node == null) throw new Error("no dictation button");
  return node;
};

beforeEach(() => {
  dictation.state = { phase: "idle", level: 0, download: null, error: null };
  dictation.toggle.mockClear();
});

describe("the dictation button", () => {
  it("offers to dictate and toggles on click", () => {
    render(<DictationButton onText={() => {}} />);

    expect(button().getAttribute("aria-label")).toBe("workspace.voice.start");
    fireEvent.click(button());
    expect(dictation.toggle).toHaveBeenCalledTimes(1);
  });

  it("shows stop while recording", () => {
    dictation.state = { ...dictation.state, phase: "recording" };
    render(<DictationButton onText={() => {}} />);

    expect(button().getAttribute("aria-label")).toBe("workspace.voice.stop");
    expect(button().getAttribute("aria-pressed")).toBe("true");
  });

  it("waits, with the download percentage, while transcribing", () => {
    dictation.state = {
      ...dictation.state,
      phase: "transcribing",
      download: {
        file: "onnx/encoder_model_quantized.onnx",
        loadedBytes: 50,
        totalBytes: 200,
        done: false,
      },
    };
    render(<DictationButton onText={() => {}} />);

    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-label")).toBe(
      "workspace.voice.downloading:25"
    );
  });

  it("names the problem when the microphone was refused", () => {
    dictation.state = { ...dictation.state, error: "permission-denied" };
    render(<DictationButton onText={() => {}} />);

    expect(button().getAttribute("aria-label")).toBe(
      "workspace.voice.errors.permission-denied"
    );
  });

  it("hands the transcript to its owner", () => {
    const onText = vi.fn();
    render(<DictationButton onText={onText} />);

    dictation.onText?.("hello there");

    expect(onText).toHaveBeenCalledWith("hello there");
  });
});
