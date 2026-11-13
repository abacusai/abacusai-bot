import { RESUME_CARD_AWAY_MS } from "@abacus-ai/contract/resume-card";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { markExternalOpen } from "#renderer/lib/navigation/external-open";

import { RESUME_LANDING_WAIT_MS, ResumeCardReturn } from "./resume-card";

const navigate = vi.fn();
const router = { latestLocation: { href: "/sessions/s-old" } };
let resultAt = 0;

vi.mock("#renderer/lib/navigation/use-app-navigate", () => ({
  useAppNavigate: () => navigate,
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
vi.mock("#renderer/data/db", () => ({
  useDb: () => ({
    collections: {
      prefs: {
        get: () => ({
          dismissals: {
            resumeCard: {
              sessionId: "s-1",
              resultAt,
              wroteAt: 0,
              closedAt: null,
            },
          },
        }),
      },
    },
  }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  navigate.mockClear();
  router.latestLocation.href = "/sessions/s-old";
  // A new result each test: the landing happens once per result.
  resultAt += 1;
  vi.setSystemTime(resultAt + RESUME_CARD_AWAY_MS + 1);
});

afterEach(() => {
  vi.useRealTimers();
});

const showWindow = () => act(() => window.dispatchEvent(new Event("focus")));
const waitOut = () =>
  act(() => vi.advanceTimersByTime(RESUME_LANDING_WAIT_MS + 1));

it("lands on home when the window shows after a long time away and nothing else opens", () => {
  render(<ResumeCardReturn />);
  showWindow();
  waitOut();
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: "/bots/new" })
  );
});

it("keeps the page anything opened meanwhile: the user's click, a notch cue, a notice", () => {
  render(<ResumeCardReturn />);
  showWindow();
  router.latestLocation.href = "/sessions/s-clicked";
  waitOut();
  expect(navigate).not.toHaveBeenCalled();
});

it("keeps the page an opener marked, even when it is the page already showing", () => {
  render(<ResumeCardReturn />);
  showWindow();
  markExternalOpen();
  waitOut();
  expect(navigate).not.toHaveBeenCalled();
});
