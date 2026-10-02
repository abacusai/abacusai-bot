/**
 * The dev cockpit (spec 01 §7.10): Router, Query, Collections, Hotkeys and
 * Pacer panels in one TanStack Devtools shell. Loaded lazily only when
 * `import.meta.env.DEV`, so production builds contain none of it. No server
 * event bus: it would listen on another port, which the CSP blocks.
 */
import { TanStackDevtools } from "@tanstack/react-devtools";
import { HotkeysDevtoolsPanel } from "@tanstack/react-hotkeys-devtools";
import { PacerDevtoolsPanel } from "@tanstack/react-pacer-devtools";
import { useQueryClient } from "@tanstack/react-query";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { useRouter } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";

import { useCollections, type Collections } from "#next/data/collections";
import { useCollectionStatus } from "#next/data/collections/status";

const CollectionRow = ({
  name,
  collection,
}: {
  name: string;
  collection: Collections[keyof Collections];
}) => {
  const status = useCollectionStatus(collection);
  const sync = collection.utils.status();
  return (
    <tr>
      <td>{name}</td>
      <td>{status}</td>
      <td>{collection.size}</td>
      <td>{sync.epoch?.slice(0, 8) ?? "-"}</td>
      <td>
        {sync.receivedSeq}/{sync.appliedSeq}
      </td>
      <td>
        <button type="button" onClick={() => void collection.utils.resync()}>
          resync
        </button>
      </td>
    </tr>
  );
};

/** F10: no published DB devtools yet; status, rows, epoch, seqs, resync. */
export const CollectionsPanel = ({
  collections,
}: {
  collections: Collections;
}) => (
  <table style={{ fontSize: 12, width: "100%" }}>
    <thead>
      <tr>
        <th>table</th>
        <th>status</th>
        <th>rows</th>
        <th>epoch</th>
        <th>received/applied</th>
        <th />
      </tr>
    </thead>
    <tbody>
      {(Object.keys(collections) as Array<keyof Collections>).map((name) => (
        <CollectionRow key={name} name={name} collection={collections[name]} />
      ))}
    </tbody>
  </table>
);

export const Devtools = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const collections = useCollections();
  return (
    <TanStackDevtools
      eventBusConfig={{ connectToServerBus: false }}
      plugins={[
        {
          name: "Router",
          render: <TanStackRouterDevtoolsPanel router={router} />,
        },
        {
          name: "Query",
          render: <ReactQueryDevtoolsPanel client={queryClient} />,
        },
        {
          name: "Collections",
          render: <CollectionsPanel collections={collections} />,
        },
        { name: "Hotkeys", render: <HotkeysDevtoolsPanel /> },
        { name: "Pacer", render: <PacerDevtoolsPanel /> },
      ]}
    />
  );
};
