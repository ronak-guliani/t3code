import type { DevicePlatform, PreviewViewportSetting } from "@t3tools/contracts";

import {
  resolveFittedBrowserViewport,
  type BrowserViewportResizeDirection,
} from "~/browser/browserViewportLayout";
import type { BrowserSurfaceContentPresentation } from "~/browser/browserSurfaceStore";
import type { PreviewMiniPlayerPosition, PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";

import type { DeviceScreenSize } from "../device/deviceStream";

export const PREVIEW_MINI_PLAYER_EDGE_GAP = 12;
export const PREVIEW_MINI_PLAYER_CORNER_RADIUS = 12;
export const PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX = 48;
const PREVIEW_MINI_PLAYER_DEFAULT_BOX = { width: 320, height: 320 } as const;
const PREVIEW_MINI_PLAYER_MIN_SIZE = { width: 240, height: 150 } as const;

export interface PreviewMiniPlayerFrame extends PreviewMiniPlayerPosition, PreviewMiniPlayerSize {}

export function resolvePreviewMiniPlayerSourceSize(
  viewport: PreviewViewportSetting,
  fittedSourceContent: BrowserSurfaceContentPresentation | null,
  zoomFactor: number,
): PreviewMiniPlayerSize {
  const normalizedZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const fitted = resolveFittedBrowserViewport(viewport, fittedSourceContent, normalizedZoomFactor);
  return {
    width: fitted.width * normalizedZoomFactor,
    height: fitted.height * normalizedZoomFactor,
  };
}

export function resolveDeviceMiniPlayerSourceSize(
  platform: DevicePlatform,
  screen: DeviceScreenSize | null,
): PreviewMiniPlayerSize {
  if (!screen) {
    const width = 1_000;
    return { width, height: width / (platform === "ios" ? 9 / 19.5 : 9 / 20) };
  }
  const landscape =
    screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
  const long = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  return landscape ? { width: long, height: short } : { width: short, height: long };
}

export function resolveDeviceMiniPlayerCornerRadius(
  platform: DevicePlatform,
  player: PreviewMiniPlayerSize,
): number {
  if (platform !== "android") return PREVIEW_MINI_PLAYER_CORNER_RADIUS;
  return Math.max(
    PREVIEW_MINI_PLAYER_CORNER_RADIUS,
    Math.round(Math.min(player.width, player.height) * 0.14),
  );
}

const availableArea = (
  container: PreviewMiniPlayerSize,
  bottomInset: number,
): PreviewMiniPlayerSize => ({
  width: container.width - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
  height: container.height - Math.max(0, bottomInset) - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
});

function fitPreviewMiniPlayerWidth(
  desiredWidth: number,
  source: PreviewMiniPlayerSize,
  max: PreviewMiniPlayerSize,
): PreviewMiniPlayerSize {
  const aspectRatio = source.width / source.height;
  const width = Math.min(
    Math.max(
      desiredWidth,
      PREVIEW_MINI_PLAYER_MIN_SIZE.width,
      PREVIEW_MINI_PLAYER_MIN_SIZE.height * aspectRatio,
    ),
    source.width,
    Math.max(1, max.width),
    Math.max(1, max.height * aspectRatio),
  );
  return { width: Math.round(width), height: Math.round(width / aspectRatio) };
}

function defaultPreviewMiniPlayerWidth(source: PreviewMiniPlayerSize): number {
  return Math.min(
    PREVIEW_MINI_PLAYER_DEFAULT_BOX.width,
    (PREVIEW_MINI_PLAYER_DEFAULT_BOX.height * source.width) / source.height,
  );
}

export function clampPreviewMiniPlayerPosition(
  position: PreviewMiniPlayerPosition,
  container: PreviewMiniPlayerSize,
  player: PreviewMiniPlayerSize,
  bottomInset = 0,
): PreviewMiniPlayerPosition {
  const reservedBottomSpace = Math.max(0, bottomInset);
  const maxX = Math.max(
    PREVIEW_MINI_PLAYER_EDGE_GAP,
    container.width - player.width - PREVIEW_MINI_PLAYER_EDGE_GAP,
  );
  const maxY = Math.max(
    PREVIEW_MINI_PLAYER_EDGE_GAP,
    container.height - reservedBottomSpace - player.height - PREVIEW_MINI_PLAYER_EDGE_GAP,
  );
  return {
    x: Math.min(Math.max(position.x, PREVIEW_MINI_PLAYER_EDGE_GAP), maxX),
    y: Math.min(Math.max(position.y, PREVIEW_MINI_PLAYER_EDGE_GAP), maxY),
  };
}

export function resolvePreviewMiniPlayerFrame(input: {
  readonly width: number | null;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly source: PreviewMiniPlayerSize;
  readonly container: PreviewMiniPlayerSize;
  readonly bottomInset?: number;
}): PreviewMiniPlayerFrame {
  const { width, position, source, container, bottomInset = 0 } = input;
  const size = fitPreviewMiniPlayerWidth(
    width ?? defaultPreviewMiniPlayerWidth(source),
    source,
    availableArea(container, bottomInset),
  );
  const anchored = position ?? {
    x: container.width - PREVIEW_MINI_PLAYER_EDGE_GAP - size.width,
    y: PREVIEW_MINI_PLAYER_EDGE_GAP,
  };
  return { ...clampPreviewMiniPlayerPosition(anchored, container, size, bottomInset), ...size };
}

export function resizePreviewMiniPlayer(input: {
  readonly start: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection;
  readonly delta: PreviewMiniPlayerPosition;
  readonly source: PreviewMiniPlayerSize;
  readonly container: PreviewMiniPlayerSize;
  readonly bottomInset?: number;
}): PreviewMiniPlayerFrame {
  const { start, direction, delta, source, container, bottomInset = 0 } = input;
  const east = direction.includes("east");
  const west = direction.includes("west");
  const north = direction.includes("north");
  const south = direction.includes("south");
  const available = availableArea(container, bottomInset);
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const max = {
    width: west
      ? right - PREVIEW_MINI_PLAYER_EDGE_GAP
      : east
        ? container.width - PREVIEW_MINI_PLAYER_EDGE_GAP - start.x
        : available.width,
    height: north
      ? bottom - PREVIEW_MINI_PLAYER_EDGE_GAP
      : south
        ? container.height - Math.max(0, bottomInset) - PREVIEW_MINI_PLAYER_EDGE_GAP - start.y
        : available.height,
  };
  const desiredWidth = start.width + (east ? delta.x : west ? -delta.x : 0);
  const desiredHeight = start.height + (south ? delta.y : north ? -delta.y : 0);
  const horizontal = east || west;
  const vertical = north || south;
  const widthLeads =
    horizontal && !vertical
      ? true
      : vertical && !horizontal
        ? false
        : Math.abs(desiredWidth - start.width) / start.width >=
          Math.abs(desiredHeight - start.height) / start.height;
  const size = fitPreviewMiniPlayerWidth(
    widthLeads ? desiredWidth : (desiredHeight * source.width) / source.height,
    source,
    max,
  );
  const position = clampPreviewMiniPlayerPosition(
    { x: west ? right - size.width : start.x, y: north ? bottom - size.height : start.y },
    container,
    size,
    bottomInset,
  );
  return { ...position, ...size };
}
