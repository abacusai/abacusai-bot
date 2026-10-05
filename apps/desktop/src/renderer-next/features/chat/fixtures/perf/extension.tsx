/**
 * The chat gallery extension plus the Electron gates' bench fixtures
 * (`bench-*`, spec 02 §13 R2-T16/R2-T31). The bench is its own lazy chunk.
 */
import { lazy, Suspense } from "react";

import { chatGallerySections } from "../../gallery/sections";

const Bench = lazy(async () => ({
  default: (await import("./bench")).ChatBench,
}));

const View = (props: {
  fixture: string;
  step: number | undefined;
  play: boolean;
}) =>
  props.fixture.startsWith("bench-") ? (
    <Suspense fallback={null}>
      <Bench id={props.fixture} />
    </Suspense>
  ) : (
    <chatGallerySections.View {...props} />
  );

export const chatGalleryWithBench = { View };
