import { createFileRoute, notFound } from "@tanstack/react-router";

import { Gallery, GallerySearch, galleryEnabled } from "#next/features/gallery";

const GalleryRoute = () => {
  const search = Route.useSearch();
  return <Gallery search={search} />;
};

/** The dev gallery (spec 01 §10): dev builds and VITE_UI_GALLERY=1 only. */
export const Route = createFileRoute("/_bare/__ui")({
  beforeLoad: () => {
    if (!galleryEnabled()) throw notFound();
  },
  validateSearch: GallerySearch,
  component: GalleryRoute,
});
