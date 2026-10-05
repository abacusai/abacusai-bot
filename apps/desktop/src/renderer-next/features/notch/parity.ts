/** Spec 06 §2 parity locations. Acceptance evidence is in reports/06-implementation.md. */
export const PHASE6_NOTCH_PARITY = [
  {
    id: "NT1",
    status: "Parity (phases 3\u20134) + Changed (F19)",
    consumer: "lib/notify.ts",
    owner: "phase-6",
  },
  {
    id: "NT2",
    status: "Parity (05)",
    consumer: "../main/index.ts",
    owner: "phase-6",
  },
  {
    id: "NT3",
    status:
      'Changed (canvas `TourNotch` "Close the window and your bots keep going")',
    consumer: "../main/index.ts",
    owner: "phase-6",
  },
  {
    id: "NT4",
    status: "New (PLAN)",
    consumer: "../main/notch/controller.ts",
    owner: "phase-6",
  },
  {
    id: "NT5",
    status: "Changed (PLAN Sound; phases 3/5)",
    consumer: "lib/sound.ts",
    owner: "phase-6",
  },
  {
    id: "NT6",
    status: "Parity (ported)",
    consumer: "lib/voice/use-dictation.ts",
    owner: "phase-6",
  },
  {
    id: "NT7",
    status: "New (canvas; 05 reserved)",
    consumer: null,
    owner: "other-phase",
  },
] as const;
