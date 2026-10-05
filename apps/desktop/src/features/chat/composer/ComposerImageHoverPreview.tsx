import { useCallback, useRef, type RefObject } from "react";
import { ImageHoverCard } from "../../../components/ImageHoverCard";
import type { ComposerImagePreviewController } from "./hooks/useComposerImagePreview";
import { useComposerImageHover } from "./hooks/useComposerImageHover";

/**
 * Hover preview for inline image chips. It stays a read-only card: clicking the
 * chip is what opens the modal preview.
 */
export function ComposerImageHover({ controller, editorRef }: {
  controller: ComposerImagePreviewController;
  editorRef: RefObject<HTMLDivElement | null>;
}) {
  const images = controller.images;
  // The controller hands back a fresh `images` array on every render, so keep
  // the lookup stable: the hover listeners must not detach while the pointer
  // still rests on a chip.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const idForToken = useCallback(
    (token: string) => imagesRef.current.find((image) => image.token === token)?.id ?? null,
    [],
  );
  const hover = useComposerImageHover(editorRef, idForToken);
  // The modal already shows the image; a card behind it would be noise.
  const target = controller.preview ? null : hover;
  const source = target ? controller.sources?.get(target.id) : undefined;
  return (
    <ImageHoverCard
      src={source?.status === "ready" ? source.src : null}
      anchor={target?.anchor ?? null}
    />
  );
}
