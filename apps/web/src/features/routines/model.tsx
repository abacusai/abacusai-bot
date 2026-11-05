import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { isCostlyModel } from "@abacus-ai/contract/models";
import { useTranslation } from "react-i18next";

import { useAppContext } from "#renderer/lib/use-app-context";

import { ModelPicker, useBotModelBinding } from "../bots/model/picker";
import { isHosted } from "./hosted";
import { showSaveFailure } from "./hosted-sync";

/**
 * The model a routine runs on, with the picker to change it. A hosted routine
 * has no model of its own (the server keeps none), so its row only names what
 * it runs on; a hosted reminder runs no model at all.
 */
export const RoutineModel = ({ row }: { row: RoutineRow }) => {
  const { t } = useTranslation();
  const { db, transport } = useAppContext();
  const value = row.model ?? null;
  const binding = useBotModelBinding(
    value,
    (model) =>
      void db.collections.routines
        .update(row.id, (d) => {
          d.model = model;
        })
        .isPersisted.promise.catch((error: unknown) =>
          showSaveFailure(error, transport, t)
        ),
    undefined,
    { planDefault: true }
  );
  if (row.hosted?.kind === "reminder") return null;
  const hosted = isHosted(row);
  const costly = binding.effective != null && isCostlyModel(binding.effective);
  return (
    <section
      aria-label={t("routines.model.label")}
      className="flex flex-col gap-1.5 text-xs"
    >
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3">
        <span className="text-muted-foreground">
          {t("routines.model.label")}
        </span>
        {hosted ? (
          <span className="min-w-0 truncate">{binding.label}</span>
        ) : (
          <div className="min-w-0">
            <ModelPicker binding={binding} />
          </div>
        )}
      </div>
      {hosted ? (
        <p className="text-muted-foreground">{t("routines.model.hosted")}</p>
      ) : (
        value === null && (
          <p className="text-muted-foreground">
            {t("routines.model.followsDefault", { model: binding.label })}
          </p>
        )
      )}
      {costly && (
        <p
          data-testid="routine-costly-model"
          className="text-[var(--chat-status-attention)]"
        >
          {t("routines.model.costly", { model: binding.label })}
        </p>
      )}
    </section>
  );
};
