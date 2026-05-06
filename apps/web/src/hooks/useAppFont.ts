import { useEffect } from "react";
import {
  DEFAULT_CODE_FONT,
  DEFAULT_UI_FONT,
  type CodeFont,
  type UiFont,
} from "@t3tools/contracts/settings";

import { readBrowserClientSettings } from "../clientPersistenceStorage";
import { useSettings } from "./useSettings";

const APP_FONT_ATTRIBUTE = "data-ui-font";
const CODE_FONT_ATTRIBUTE = "data-code-font";

export const CODE_FONT_STACKS: Record<CodeFont, string> = {
  "system-mono":
    '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
  "sf-mono":
    '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
  menlo:
    'Menlo, Monaco, "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", ui-monospace, monospace',
  "jetbrains-mono":
    '"JetBrains Mono", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
};

function normalizeUiFont(value: unknown): UiFont {
  return value === "geist" || value === "dm-sans" ? value : DEFAULT_UI_FONT;
}

function normalizeCodeFont(value: unknown): CodeFont {
  return value === "system-mono" ||
    value === "sf-mono" ||
    value === "menlo" ||
    value === "jetbrains-mono"
    ? value
    : DEFAULT_CODE_FONT;
}

export function applyAppFont(font: UiFont): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute(APP_FONT_ATTRIBUTE, font);
}

export function applyCodeFont(font: CodeFont): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute(CODE_FONT_ATTRIBUTE, font);
}

function getStoredUiFont(): UiFont {
  return normalizeUiFont(readBrowserClientSettings()?.uiFont);
}

function getStoredCodeFont(): CodeFont {
  return normalizeCodeFont(readBrowserClientSettings()?.codeFont);
}

if (typeof document !== "undefined") {
  applyAppFont(getStoredUiFont());
  applyCodeFont(getStoredCodeFont());
}

export function useAppFont() {
  const uiFont = useSettings((settings) => settings.uiFont);
  const codeFont = useSettings((settings) => settings.codeFont);

  useEffect(() => {
    applyAppFont(uiFont);
  }, [uiFont]);

  useEffect(() => {
    applyCodeFont(codeFont);
  }, [codeFont]);

  return { uiFont, codeFont };
}
