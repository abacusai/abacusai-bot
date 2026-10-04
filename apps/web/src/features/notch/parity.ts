/** Spec 06 §2 parity locations. Acceptance evidence is in reports/06-implementation.md. */
export const PHASE6_NOTCH_PARITY = [
  {
    id: "NT1",
    status: "green",
    evidence: "R6-T40 located consumer; packaged acceptance remains open.",
    visible: false,
    consumer: "apps/web/src/lib/notify.ts#notifyAttention",
    owner: "phase-6",
  },
  {
    id: "NT2",
    status: "green",
    evidence: "R6-T40 located consumer; packaged acceptance remains open.",
    visible: false,
    consumer: "apps/desktop/src/main/index.ts#appOperations",
    owner: "phase-6",
  },
  {
    id: "NT3",
    status: "retired",
    reason:
      "The companion shows ongoing work; the background Task still running notification is removed.",
    visible: true,
    consumer:
      "retired: The companion shows ongoing work instead of a background system notification.",
    owner: "phase-6",
  },
  {
    id: "NT4",
    status: "green",
    evidence: "R6-T40 located consumer; packaged acceptance remains open.",
    visible: false,
    consumer: "apps/desktop/src/main/notch/controller.ts#NotchController",
    owner: "phase-6",
  },
  {
    id: "NT5",
    status: "green",
    evidence: "R6-T40 located consumer; packaged acceptance remains open.",
    visible: false,
    consumer: "apps/web/src/lib/sound.ts#createSoundPlayer",
    owner: "phase-6",
  },
  {
    id: "NT6",
    status: "green",
    evidence: "R6-T40 located consumer; packaged acceptance remains open.",
    visible: false,
    consumer: "apps/web/src/lib/voice/use-dictation.ts#useDictation",
    owner: "phase-6",
  },
  {
    id: "NT7",
    status: "green",
    evidence: "R6-T40 located consumer; packaged acceptance remains open.",
    visible: false,
    consumer: "apps/web/src/features/settings/companion.tsx#CompanionSettings",
    owner: "other-phase",
  },
] as const;
