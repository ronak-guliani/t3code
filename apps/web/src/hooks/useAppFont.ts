import { useEffect } from "react";
import { DEFAULT_UI_FONT, type UiFont } from "@t3tools/contracts/settings";

import { readBrowserClientSettings } from "../clientPersistenceStorage";
import { useSettings } from "./useSettings";

const APP_FONT_ATTRIBUTE = "data-ui-font";

function normalizeUiFont(value: unknown): UiFont {
  return value === "geist" || value === "dm-sans" ? value : DEFAULT_UI_FONT;
}

export function applyAppFont(font: UiFont): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute(APP_FONT_ATTRIBUTE, font);
}

function getStoredUiFont(): UiFont {
  return normalizeUiFont(readBrowserClientSettings()?.uiFont);
}

if (typeof document !== "undefined") {
  applyAppFont(getStoredUiFont());
}

export function useAppFont() {
  const uiFont = useSettings((settings) => settings.uiFont);

  useEffect(() => {
    applyAppFont(uiFont);
  }, [uiFont]);

  return uiFont;
}
