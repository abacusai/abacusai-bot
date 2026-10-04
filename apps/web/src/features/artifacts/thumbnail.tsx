import { useQuery } from "@tanstack/react-query";
import { Image, File, Link } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAppContext } from "#renderer/lib/use-app-context";
import type { ArtifactRow } from "@abacus-ai/contract/contract/rows";

import { dirname } from "./data";
export const ArtifactThumbnail = ({ artifact }: { artifact: ArtifactRow }) => {
  const { transport } = useAppContext();
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || artifact.kind !== "image") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [artifact.kind]);
  const image = useQuery({
    ...transport.orpc.files.readImageAsDataUrl.queryOptions({
      input: {
        filePath: artifact.location,
        hostRoot: dirname(artifact.location),
      },
    }),
    enabled: near && artifact.kind === "image",
    staleTime: 300000,
    retry: false,
  });
  return (
    <div
      ref={ref}
      data-artifact-thumbnail={artifact.kind}
      data-requested={near ? "true" : "false"}
      className="bg-muted flex h-24 w-full items-center justify-center overflow-hidden"
    >
      {image.data ? (
        <img
          src={image.data.dataUrl}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      ) : artifact.kind === "image" ? (
        <Image aria-hidden />
      ) : artifact.kind === "link" ? (
        <Link aria-hidden />
      ) : (
        <File aria-hidden />
      )}
    </div>
  );
};
