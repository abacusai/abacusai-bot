/** Spec 06 §2 parity locations. Acceptance evidence is in reports/06-implementation.md. */
export const PHASE6_NOTCH_PARITY = [
  {
    id: "NT1",
    status: "Parity (phases 3\u20134) + Changed (F19)",
    consumer: "src/renderer-next/lib/notify.ts#notifyAttention",
    owner: "phase-6",
  },
  {
    id: "NT2",
    status: "Parity (05)",
    consumer: "src/main/index.ts#appOperations",
    owner: "phase-6",
  },
  {
    id: "NT3",
    status:
      'Changed (canvas `TourNotch` "Close the window and your bots keep going")',
    consumer: "src/main/index.ts#notifyTaskRunningInBackground",
    owner: "phase-6",
  },
  {
    id: "NT4",
    status: "New (PLAN)",
    consumer: "src/main/notch/controller.ts#NotchController",
    owner: "phase-6",
  },
  {
    id: "NT5",
    status: "Changed (PLAN Sound; phases 3/5)",
    consumer: "src/renderer-next/lib/sound.ts#createSoundPlayer",
    owner: "phase-6",
  },
  {
    id: "NT6",
    status: "Parity (ported)",
    consumer: "src/renderer-next/lib/voice/use-dictation.ts#useDictation",
    owner: "phase-6",
  },
  {
    id: "NT7",
    status: "New (canvas; 05 reserved)",
    consumer:
      "src/renderer-next/features/settings/companion.tsx#CompanionSettings",
    owner: "other-phase",
  },
] as const;
