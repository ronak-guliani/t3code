/**
 * macOS draws the traffic lights itself, in screen points, and Chromium's page
 * zoom does not scale them. The renderer's title-bar row does scale, so a fixed
 * button position drifts off the row — and away from the sidebar's collapse
 * trigger — the moment the window is zoomed. Deriving the position from the
 * zoom factor keeps the controls centred on the row at any zoom.
 */

/** Height of the renderer's title-bar row. Keep in sync with `--spacing-titlebar`. */
export const TITLEBAR_ROW_HEIGHT = 44;

/** Diameter macOS uses for a traffic light, in screen points. */
export const TRAFFIC_LIGHT_DIAMETER = 12;

/** Left inset of the first traffic light, in the renderer's own CSS pixels. */
export const TRAFFIC_LIGHT_INSET_X = 16;

/**
 * Chromium's standard zoom ladder. Stepping through it keeps `Zoom In`/`Zoom
 * Out` behaving exactly like the built-in menu roles they replace, which is the
 * only reason those roles could be dropped in favour of explicit handlers that
 * also reposition the window controls.
 */
export const ZOOM_FACTOR_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;

export const DEFAULT_ZOOM_FACTOR = 1;

function normalizeZoomFactor(zoomFactor: number): number {
  return Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : DEFAULT_ZOOM_FACTOR;
}

export function trafficLightPositionForZoom(zoomFactor: number): { x: number; y: number } {
  const zoom = normalizeZoomFactor(zoomFactor);
  return {
    x: Math.round(TRAFFIC_LIGHT_INSET_X * zoom),
    y: Math.round((TITLEBAR_ROW_HEIGHT * zoom - TRAFFIC_LIGHT_DIAMETER) / 2),
  };
}

export function stepZoomFactor(zoomFactor: number, direction: 1 | -1): number {
  const zoom = normalizeZoomFactor(zoomFactor);
  const [minZoom] = ZOOM_FACTOR_STEPS;
  const maxZoom = ZOOM_FACTOR_STEPS[ZOOM_FACTOR_STEPS.length - 1] ?? minZoom;
  if (direction === 1) {
    return ZOOM_FACTOR_STEPS.find((step) => step > zoom + 1e-4) ?? maxZoom;
  }
  return [...ZOOM_FACTOR_STEPS].reverse().find((step) => step < zoom - 1e-4) ?? minZoom;
}
