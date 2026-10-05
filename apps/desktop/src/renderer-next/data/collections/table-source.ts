/**
 * Where the collections' `db.*` procedures come from: this document's
 * transport, unless a source was installed (tests, and the dev fixture tables
 * while main's `db.*` still answers UNAVAILABLE; see data/dev-db).
 */
import { getTransport, type AppClient } from "#next/data/transport";

import type { IpcTableClient } from "./ipc-collection-options";

export type DbClient = AppClient["db"];

export type DbSource = () => Promise<DbClient>;

export const transportDbSource: DbSource = async () =>
  (await getTransport()).client.db;

/** One table of a source, typed for the adapter. */
export const tableOf =
  <Row, Key extends string = string>(
    source: DbSource,
    name: keyof DbClient
  ): (() => Promise<IpcTableClient<Row, Key>>) =>
  async () =>
    (await source())[name] as unknown as IpcTableClient<Row, Key>;
