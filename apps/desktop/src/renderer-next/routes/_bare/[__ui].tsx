import { createFileRoute, notFound } from "@tanstack/react-router";

import { botsGallerySections, isBotsGalleryFixture } from "#next/features/bots";
import { chatGallerySections } from "#next/features/chat";
import { Gallery, GallerySearch, galleryEnabled } from "#next/features/gallery";

const extension = {
  Nav: (props: { fixture: string | undefined }) => (
    <>
      <botsGallerySections.Nav {...props} />
      <chatGallerySections.Nav {...props} />
    </>
  ),
  View: (props: {
    fixture: string;
    step: number | undefined;
    play: boolean;
  }) =>
    isBotsGalleryFixture(props.fixture) ? (
      <botsGallerySections.View {...props} />
    ) : (
      <chatGallerySections.View {...props} />
    ),
};
const GalleryRoute = () => {
  const search = Route.useSearch();
  return <Gallery search={search} extension={extension} />;
};

/** The dev gallery (spec 01 §10): dev builds and VITE_UI_GALLERY=1 only. */
export const Route = createFileRoute("/_bare/__ui")({
  beforeLoad: () => {
    if (!galleryEnabled()) throw notFound();
  },
  validateSearch: GallerySearch,
  component: GalleryRoute,
});
