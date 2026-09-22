import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";

export type PullRequestMediaPreview = {
  readonly type: "image" | "video";
  readonly src: string;
  readonly name: string;
};

export function PullRequestMediaDialog({
  preview,
  onClose,
}: {
  readonly preview: PullRequestMediaPreview;
  readonly onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const zoomIn = () => setZoom((current) => Math.min(8, current * 1.5));
  const zoomOut = () => setZoom((current) => Math.max(1, current / 1.5));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      aria-label={`Expanded ${preview.type} preview`}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
    >
      <button
        aria-hidden
        className="absolute inset-0 cursor-default"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div className="relative z-10 flex max-h-full max-w-[92vw] flex-col items-center">
        <Button
          aria-label={`Close ${preview.type} preview`}
          className="absolute right-0 -top-10 text-white hover:bg-white/10 hover:text-white"
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={onClose}
        >
          <XIcon />
        </Button>
        {preview.type === "image" ? (
          <>
            <div
              aria-label={`${preview.name}, zoomable image`}
              className="max-h-[86vh] max-w-[92vw] overflow-auto rounded-lg bg-background shadow-2xl"
              role="region"
            >
              <img
                alt={preview.name}
                className="block max-h-[86vh] max-w-[92vw] origin-center select-none transition-transform"
                draggable={false}
                src={preview.src}
                style={{ transform: `scale(${zoom})` }}
                onClick={() => setZoom((current) => (current === 1 ? 2 : 1))}
              />
            </div>
            <div className="mt-2 flex items-center gap-1 text-white">
              <Button
                aria-label="Zoom out"
                disabled={zoom === 1}
                size="icon-xs"
                type="button"
                variant="ghost"
                onClick={zoomOut}
              >
                <MinusIcon />
              </Button>
              <span className="min-w-12 text-center text-xs tabular-nums">
                {Math.round(zoom * 100)}%
              </span>
              <Button
                aria-label="Zoom in"
                disabled={zoom === 8}
                size="icon-xs"
                type="button"
                variant="ghost"
                onClick={zoomIn}
              >
                <PlusIcon />
              </Button>
            </div>
          </>
        ) : (
          <video
            className="max-h-[86vh] max-w-[92vw] rounded-lg border border-border/70 bg-black shadow-2xl"
            controls
            src={preview.src}
          />
        )}
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-white/80">
          {preview.name}
        </p>
      </div>
    </div>
  );
}
