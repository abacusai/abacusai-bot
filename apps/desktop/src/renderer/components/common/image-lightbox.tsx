import { X } from "lucide-react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../ui/dialog";

interface ImageLightboxProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  alt?: string;
}

export const ImageLightbox = ({
  isOpen,
  onClose,
  imageUrl,
  alt = "Image",
}: ImageLightboxProps): JSX.Element => {
  const { t } = useTranslation();

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] w-fit max-w-[calc(100vw-2rem)] bg-transparent p-0 ring-0 sm:max-w-[calc(100vw-2rem)]"
        data-id="image-lightbox"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 right-2 z-10 bg-black/30 text-white hover:bg-black/50 hover:text-white"
              data-id="image-lightbox-close-btn"
              aria-label={t("common.close")}
            />
          }
        >
          <X className="size-5" />
        </DialogClose>
        <img
          src={imageUrl}
          alt={alt}
          className="max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] rounded-lg object-contain shadow-2xl"
        />
      </DialogContent>
    </Dialog>
  );
};
