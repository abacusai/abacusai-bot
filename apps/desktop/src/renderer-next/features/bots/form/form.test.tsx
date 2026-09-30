/** R3-T10,T16,T17,T18: schema output, real form timing and persistence stages. */
import { FormApi, FieldApi, revalidateLogic } from "@tanstack/react-form";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDb, type Db } from "#next/data/db";
import { FixtureDb, fixtureTransport } from "#next/data/fixture-db/fixture-db";
import { fixtureBots } from "#next/data/fixture-db/rows";
import { CHECK_IN_PROMPT, NAME_ONLY_MISSION } from "#next/lib/bots/check-in";

import {
  getDraft,
  clearDraft,
  selectTemplate,
  updateDraft,
} from "./draft-store";
import {
  BotFormSchema,
  valuesForBot,
  editedPatch,
  type BotFormValues,
} from "./schema";
import { submitCreate, persistCheckIn, submitEdit } from "./submit";
let db: Db | undefined;
afterEach(async () => {
  db?.stop();
  if (db)
    await Promise.all(Object.values(db.collections).map((c) => c.cleanup()));
  clearDraft();
  vi.restoreAllMocks();
});
const setup = async () => {
  const feed = new FixtureDb({ bots: fixtureBots() });
  db = createDb(fixtureTransport(feed));
  await Promise.all([
    db.collections.bots.preload(),
    db.collections.routines.preload(),
    db.collections.sessions.preload(),
  ]);
  return db;
};
const values = (): BotFormValues => ({
  ...valuesForBot(fixtureBots()[0]!, null),
  name: "  Helper  ",
  instructions: "  ",
  description: "  Role  ",
  look: {
    shape: "blob" as const,
    color: "#123456",
    accessory: "none" as const,
  },
});
describe("schema and real TanStack Form", () => {
  it("parses trimmed output and accepts compliant custom colours", () => {
    const parsed = v.parse(BotFormSchema, values());
    expect(parsed.name).toBe("Helper");
    expect(parsed.instructions).toBe("");
    expect(parsed.description).toBe("Role");
    expect(parsed.look.color).toBe("#123456");
  });
  it("ignores inactive time values but rejects an empty active time", () => {
    expect(
      v.safeParse(BotFormSchema, {
        ...values(),
        checkIn: { ...values().checkIn, time: "" },
      }).success
    ).toBe(true);
    expect(
      v.safeParse(BotFormSchema, {
        ...values(),
        checkIn: { ...values().checkIn, preset: "daily", time: "" },
      }).success
    ).toBe(false);
  });
  it("runs only dynamic validation on blur, then on change after submission", async () => {
    const initial = { ...values(), name: "" };
    const submitted = vi.fn();
    const form = new FormApi({
      defaultValues: initial,
      validationLogic: revalidateLogic({
        mode: "blur",
        modeAfterSubmission: "change",
      }),
      validators: { onDynamic: BotFormSchema },
      onSubmit: submitted,
    });
    form.mount();
    const name = new FieldApi({ form, name: "name" });
    name.mount();
    expect(name.state.meta.errors).toEqual([]);
    name.handleChange("");
    expect(name.state.meta.errors).toEqual([]);
    name.handleBlur();
    expect(name.state.meta.errors.length).toBeGreaterThan(0);
    await form.handleSubmit();
    expect(submitted).not.toHaveBeenCalled();
    name.handleChange("Ready");
    expect(name.state.meta.errors).toEqual([]);
  });
  it("remote setFieldValue options have no validation, touched or listener effects over successive updates", () => {
    const listener = vi.fn();
    const form = new FormApi({
      defaultValues: values(),
      validationLogic: revalidateLogic({
        mode: "blur",
        modeAfterSubmission: "change",
      }),
      validators: { onDynamic: BotFormSchema },
    });
    form.mount();
    const name = new FieldApi({
      form,
      name: "name",
      listeners: { onChange: listener },
    });
    name.mount();
    for (const value of ["Remote 1", "Remote 2"])
      form.setFieldValue("name", value, {
        dontUpdateMeta: true,
        dontValidate: true,
        dontRunListeners: true,
      });
    expect(name.state.meta.isTouched).toBe(false);
    expect(name.state.meta.errors).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    name.handleBlur();
    const baseline = form.state.values;
    expect(editedPatch(form.state.values, baseline)).toEqual({});
  });
  it("does not write a mapped legacy look on an unrelated edit", () => {
    const baseline = valuesForBot(fixtureBots()[0]!, null);
    expect(editedPatch({ ...baseline, name: "Renamed" }, baseline)).toEqual({
      name: "Renamed",
    });
  });
});
describe("draft and staged creation", () => {
  it("template replaces the typed name with its translated name and keeps a stable client id", () => {
    const id = getDraft().id;
    updateDraft({ values: { ...getDraft().values, name: "Typed" } });
    selectTemplate("chief-of-staff", "Chef de cabinet");
    expect(getDraft().values.name).toBe("Chef de cabinet");
    expect(getDraft().values.instructions).not.toBe("");
    expect(getDraft().id).toBe(id);
  });
  it("persists bot and check-in before readiness and navigation; readiness rejection cannot create twice", async () => {
    const db = await setup();
    const draft = getDraft();
    const parsed = v.parse(BotFormSchema, {
      ...values(),
      checkIn: { ...values().checkIn, preset: "weekdays" },
    });
    const order: string[] = [];
    const transport = {
      client: {
        bots: {
          openChat: vi.fn(async () => {
            order.push("open");
            throw new Error("host down");
          }),
        },
      },
    } as never;
    const deps = {
      db,
      transport,
      load: vi.fn(async () => {}),
      navigate: vi.fn(async () => {
        order.push("navigate");
      }),
      routineName: "Helper check-in",
      checkInFailed: vi.fn(),
    };
    await submitCreate(deps, draft, parsed, () => {
      order.push("persisted");
    });
    expect(db.collections.bots.get(draft.id)?.description).toBe(
      NAME_ONLY_MISSION
    );
    expect(
      db.collections.routines.toArray.find((r) => r.botId === draft.id)?.prompt
    ).toBe(CHECK_IN_PROMPT);
    expect(order).toEqual(["persisted", "persisted", "open", "navigate"]);
    const count = db.collections.bots.size;
    await submitCreate(deps, draft, parsed, () => {});
    expect(db.collections.bots.size).toBe(count);
    expect(db.collections.routines.size).toBe(1);
  });
  it("pause-only and schedule changes keep enabled independent", async () => {
    const db = await setup();
    const bot = fixtureBots()[0]!;
    const draft = {
      ...values().checkIn,
      preset: "daily" as const,
      enabled: false,
    };
    await persistCheckIn(db, bot, null, draft, "Check-in");
    const before = db.collections.routines.toArray[0]!;
    expect(before.enabled).toBe(false);
    await persistCheckIn(
      db,
      bot,
      before,
      { ...draft, time: "10:15" },
      "Check-in"
    );
    expect(db.collections.routines.get(before.id)?.enabled).toBe(false);
    const update = vi.spyOn(db.collections.routines, "update");
    await persistCheckIn(
      db,
      bot,
      db.collections.routines.get(before.id)!,
      { ...draft, time: "10:15", enabled: true },
      "Check-in"
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(db.collections.routines.get(before.id)?.schedule).toBe(
      "15 10 * * *"
    );
    expect(db.collections.routines.get(before.id)?.enabled).toBe(true);
  });
  it("round-trips accessories through create and update collections", async () => {
    const db = await setup();
    const draft = getDraft();
    const deps = {
      db,
      transport: {
        client: {
          bots: {
            openChat: vi.fn(async () => {
              throw new Error("offline");
            }),
            announceChange: vi.fn(),
          },
        },
      } as never,
      load: vi.fn(),
      navigate: vi.fn(),
      routineName: "Check",
      checkInFailed: vi.fn(),
    };
    const parsed = v.parse(BotFormSchema, {
      ...values(),
      look: { ...values().look, accessory: "glasses" },
    });
    await submitCreate(deps, draft, parsed, () => {});
    const bot = db.collections.bots.get(draft.id)!;
    expect(bot.avatarAccessory).toBe("glasses");
    const baseline = valuesForBot(bot, null);
    await submitEdit(
      deps,
      bot,
      null,
      { ...baseline, look: { ...baseline.look, accessory: "none" } },
      baseline
    );
    expect(db.collections.bots.get(bot.id)?.avatarAccessory).toBe("none");
  });
  it("pause-only edit preserves another window's schedule", async () => {
    const db = await setup();
    const bot = fixtureBots()[0]!;
    await persistCheckIn(
      db,
      bot,
      null,
      { ...values().checkIn, preset: "daily" },
      "Check"
    );
    const routine = db.collections.routines.toArray[0]!;
    const baseline = valuesForBot(bot, routine);
    await persistCheckIn(
      db,
      bot,
      routine,
      { ...baseline.checkIn, time: "10:00" },
      "Check"
    );
    await submitEdit(
      {
        db,
        transport: { client: { bots: { announceChange: vi.fn() } } } as never,
        load: vi.fn(),
        navigate: vi.fn(),
        routineName: "Check",
        checkInFailed: vi.fn(),
      },
      bot,
      db.collections.routines.get(routine.id)!,
      { ...baseline, checkIn: { ...baseline.checkIn, enabled: false } },
      baseline
    );
    expect(db.collections.routines.get(routine.id)?.schedule).toBe(
      "0 10 * * *"
    );
    expect(db.collections.routines.get(routine.id)?.enabled).toBe(false);
  });
  it.each([
    ["pause", false],
    ["pause", true],
    ["schedule", false],
    ["schedule", true],
    ["already-saved", false],
  ] as const)(
    "%s edit preserves remote leaves during persistence with baseline sync %s",
    async (edit, syncBaseline) => {
      const feed = new FixtureDb({ bots: fixtureBots() });
      const transport = await fixtureTransport(feed)();
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const update = transport.client.db.bots.update;
      const delayed = vi
        .spyOn(transport.client.db.bots, "update")
        .mockImplementation(async (...args) => {
          await pending;
          return update(...args);
        });
      db = createDb(async () => transport);
      await Promise.all([
        db.collections.bots.preload(),
        db.collections.routines.preload(),
        db.collections.sessions.preload(),
      ]);
      const bot = fixtureBots()[0]!;
      await persistCheckIn(
        db,
        bot,
        null,
        { ...values().checkIn, preset: "daily", time: "09:00" },
        "Check"
      );
      const routine = db.collections.routines.toArray[0]!;
      const baseline = valuesForBot(bot, routine);
      const submitted = {
        ...baseline,
        persona: "Edited persona",
        checkIn: {
          ...baseline.checkIn,
          ...(edit === "pause" ? { enabled: false } : { time: "11:00" }),
        },
      };
      const announceChange = vi.fn(async () => {});
      const saving = submitEdit(
        {
          db,
          transport: { client: { bots: { announceChange } } } as never,
          load: vi.fn(),
          navigate: vi.fn(),
          routineName: "Check",
          checkInFailed: vi.fn(),
        },
        bot,
        routine,
        submitted,
        baseline
      );
      await vi.waitFor(() => expect(delayed).toHaveBeenCalledOnce());
      const routineUpdate = vi.spyOn(db.collections.routines, "update");
      const remotePatch =
        edit === "pause"
          ? { schedule: "0 10 * * *" }
          : edit === "already-saved"
            ? { schedule: "0 11 * * *", enabled: false }
            : { enabled: false };
      feed.updateRow(feed.routines, routine.id, remotePatch);
      await vi.waitFor(() =>
        expect(db!.collections.routines.get(routine.id)).toMatchObject(
          remotePatch
        )
      );
      if (syncBaseline)
        baseline.checkIn = valuesForBot(
          bot,
          db.collections.routines.get(routine.id)!
        ).checkIn;
      release();
      await saving;
      expect(db.collections.bots.get(bot.id)?.persona).toBe("Edited persona");
      expect(db.collections.routines.get(routine.id)).toMatchObject({
        schedule: edit === "pause" ? "0 10 * * *" : "0 11 * * *",
        enabled: false,
      });
      if (edit === "already-saved")
        expect(routineUpdate).not.toHaveBeenCalled();
      expect(announceChange).toHaveBeenCalledOnce();
      expect(announceChange).toHaveBeenCalledWith({
        id: bot.id,
        notice:
          edit === "pause"
            ? { persona: true }
            : { persona: true, checkIn: "every day at 11:00" },
      });
    }
  );
  it("edit announces mission only, and stores NAME_ONLY_MISSION for whitespace instructions", async () => {
    const db = await setup();
    const bot = fixtureBots()[0]!;
    const baseline = valuesForBot(bot, null);
    const announceChange = vi.fn(async () => {});
    const transport = { client: { bots: { announceChange } } } as never;
    await submitEdit(
      {
        db,
        transport,
        load: vi.fn(),
        navigate: vi.fn(),
        routineName: "Check",
        checkInFailed: vi.fn(),
      },
      bot,
      null,
      v.parse(BotFormSchema, { ...baseline, instructions: "  " }),
      { ...baseline, instructions: "Old mission" }
    );
    expect(db.collections.bots.get(bot.id)?.description).toBe(
      NAME_ONLY_MISSION
    );
    expect(announceChange).toHaveBeenCalledWith({
      id: bot.id,
      notice: { mission: true },
    });
  });
});
