import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  safeStorage,
  shell,
  webContents,
} from "electron";
import type { MenuItemConstructorOptions, OpenDialogOptions, WebContents } from "electron";
import type {
  ClientSettings,
  DesktopTheme,
  DesktopAppBranding,
  DesktopServerExposureMode,
  DesktopServerExposureState,
  DesktopUpdateChannel,
  PersistedSavedEnvironmentRecord,
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
  DesktopPreviewStateChange,
  DesktopPreviewTabState,
  DesktopPreviewNavStatus,
  DesktopPreviewAutomationCommand,
  DesktopPreviewRecordingFrame,
} from "@t3tools/contracts";
import { DesktopNotificationRequest } from "@t3tools/contracts";
import { autoUpdater } from "electron-updater";
import * as Schema from "effect/Schema";

import type { ContextMenuItem } from "@t3tools/contracts";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { isPreviewPartition } from "@t3tools/shared/preview";
import {
  enableV8CompileCache,
  resolveCompileCacheDir,
  withCompileCacheEnv,
} from "@t3tools/shared/compileCache";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { DEFAULT_DESKTOP_BACKEND_PORT, resolveDesktopBackendPort } from "./backendPort.ts";
import {
  DEFAULT_DESKTOP_SETTINGS,
  readDesktopSettings,
  setDesktopSidebarVibrancyPreference,
  setDesktopServerExposurePreference,
  setDesktopUpdateChannelPreference,
  writeDesktopSettings,
} from "./desktopSettings.ts";
import {
  readClientSettings,
  readSavedEnvironmentRegistry,
  readSavedEnvironmentSecret,
  removeSavedEnvironmentSecret,
  writeClientSettings,
  writeSavedEnvironmentRegistry,
  writeSavedEnvironmentSecret,
} from "./clientPersistence.ts";
import { isBackendReadinessAborted, waitForHttpReady } from "./backendReadiness.ts";
import { showDesktopConfirmDialog } from "./confirmDialog.ts";
import { resolveDesktopServerExposure } from "./serverExposure.ts";
import { syncShellEnvironment } from "./syncShellEnvironment.ts";
import { waitForBackendStartupReady } from "./backendStartupReadiness.ts";
import { getAutoUpdateDisabledReason, shouldBroadcastDownloadProgress } from "./updateState.ts";
import { doesVersionMatchDesktopUpdateChannel } from "./updateChannels.ts";
import { ServerListeningDetector } from "./serverListeningDetector.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";
import { isArm64HostRunningIntelBuild, resolveDesktopRuntimeInfo } from "./runtimeArch.ts";
import { resolveDesktopAppBranding } from "./appBranding.ts";
import { bindFirstRevealTrigger, type RevealSubscription } from "./windowReveal.ts";
import { createMainWindowWebPreferences } from "./mainWindowPreferences.ts";

syncShellEnvironment();

// Persist V8 bytecode under the durable per-user data dir so repeat launches
// skip recompiling this main bundle and any externally-required modules
// (electron, electron-updater). On Windows this also avoids repeated
// AV-scanned reads of the same files on every cold start.
const compileCacheDir = resolveCompileCacheDir("t3code-desktop", app.getPath("userData"));
enableV8CompileCache(compileCacheDir);

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const SET_VIBRANCY_CHANNEL = "desktop:set-vibrancy";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_SET_CHANNEL_CHANNEL = "desktop:update-set-channel";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const GET_APP_BRANDING_CHANNEL = "desktop:get-app-branding";
const GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL = "desktop:get-local-environment-bootstrap";
const GET_CLIENT_SETTINGS_CHANNEL = "desktop:get-client-settings";
const SET_CLIENT_SETTINGS_CHANNEL = "desktop:set-client-settings";
const GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL = "desktop:get-saved-environment-registry";
const SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL = "desktop:set-saved-environment-registry";
const GET_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:get-saved-environment-secret";
const SET_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:set-saved-environment-secret";
const REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:remove-saved-environment-secret";
const GET_SERVER_EXPOSURE_STATE_CHANNEL = "desktop:get-server-exposure-state";
const SET_SERVER_EXPOSURE_MODE_CHANNEL = "desktop:set-server-exposure-mode";
const SHOW_NOTIFICATION_CHANNEL = "desktop:show-notification";
const NOTIFICATION_CLICKED_CHANNEL = "desktop:notification-clicked";
const PREVIEW_CREATE_TAB_CHANNEL = "desktop:preview-create-tab";
const PREVIEW_REGISTER_WEBVIEW_CHANNEL = "desktop:preview-register-webview";
const PREVIEW_NAVIGATE_CHANNEL = "desktop:preview-navigate";
const PREVIEW_GO_BACK_CHANNEL = "desktop:preview-go-back";
const PREVIEW_GO_FORWARD_CHANNEL = "desktop:preview-go-forward";
const PREVIEW_REFRESH_CHANNEL = "desktop:preview-refresh";
const PREVIEW_HARD_RELOAD_CHANNEL = "desktop:preview-hard-reload";
const PREVIEW_ZOOM_IN_CHANNEL = "desktop:preview-zoom-in";
const PREVIEW_ZOOM_OUT_CHANNEL = "desktop:preview-zoom-out";
const PREVIEW_RESET_ZOOM_CHANNEL = "desktop:preview-reset-zoom";
const PREVIEW_OPEN_DEVTOOLS_CHANNEL = "desktop:preview-open-devtools";
const PREVIEW_CLEAR_COOKIES_CHANNEL = "desktop:preview-clear-cookies";
const PREVIEW_CLEAR_CACHE_CHANNEL = "desktop:preview-clear-cache";
const PREVIEW_CAPTURE_SCREENSHOT_CHANNEL = "desktop:preview-capture-screenshot";
const PREVIEW_START_RECORDING_CHANNEL = "desktop:preview-start-recording";
const PREVIEW_STOP_RECORDING_CHANNEL = "desktop:preview-stop-recording";
const PREVIEW_ANNOTATE_ELEMENT_CHANNEL = "desktop:preview-annotate-element";
const PREVIEW_CLEAR_ANNOTATIONS_CHANNEL = "desktop:preview-clear-annotations";
const PREVIEW_RUN_AUTOMATION_CHANNEL = "desktop:preview-run-automation";
const PREVIEW_CLOSE_TAB_CHANNEL = "desktop:preview-close-tab";
const PREVIEW_STATE_CHANNEL = "desktop:preview-state";
const BASE_DIR = process.env.T3CODE_HOME?.trim() || Path.join(OS.homedir(), ".t3");
const STATE_DIR = Path.join(BASE_DIR, "userdata");
const DESKTOP_SETTINGS_PATH = Path.join(STATE_DIR, "desktop-settings.json");
const CLIENT_SETTINGS_PATH = Path.join(STATE_DIR, "client-settings.json");
const SAVED_ENVIRONMENT_REGISTRY_PATH = Path.join(STATE_DIR, "saved-environments.json");
const DESKTOP_SCHEME = "t3";
const ROOT_DIR = Path.resolve(__dirname, "../../..");
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const desktopAppBranding: DesktopAppBranding = resolveDesktopAppBranding({
  isDevelopment,
  appVersion: app.getVersion(),
  packageProductName: app.getName(),
});
const APP_DISPLAY_NAME = desktopAppBranding.displayName;
const isDevAppFlavor = desktopAppBranding.stageLabel === "Dev";
const APP_USER_MODEL_ID = isDevAppFlavor ? "com.t3tools.t3code.dev" : "com.t3tools.t3code";
const LINUX_DESKTOP_ENTRY_NAME = isDevAppFlavor ? "t3code-dev.desktop" : "t3code.desktop";
const LINUX_WM_CLASS = isDevAppFlavor ? "t3code-dev" : "t3code";
const USER_DATA_DIR_NAME = isDevAppFlavor ? "t3code-dev" : "t3code";
const LEGACY_USER_DATA_DIR_NAME = isDevAppFlavor ? "T3 Code (Dev)" : "T3 Code (Alpha)";
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = Path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const SERVER_SETTINGS_PATH = Path.join(STATE_DIR, "settings.json");
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;

function resolvePickFolderDefaultPath(rawOptions: unknown): string | undefined {
  if (typeof rawOptions !== "object" || rawOptions === null) {
    return undefined;
  }

  const { initialPath } = rawOptions as { initialPath?: unknown };
  if (typeof initialPath !== "string") {
    return undefined;
  }

  const trimmedPath = initialPath.trim();
  if (trimmedPath.length === 0) {
    return undefined;
  }

  if (trimmedPath === "~") {
    return OS.homedir();
  }

  if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) {
    return Path.join(OS.homedir(), trimmedPath.slice(2));
  }

  return Path.resolve(trimmedPath);
}
const DESKTOP_LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_REQUIRED_PORT_PROBE_HOSTS = ["0.0.0.0", "::"] as const;
const TITLEBAR_HEIGHT = 40;
const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";

function normalizeContextMenuItems(source: readonly ContextMenuItem[]): ContextMenuItem[] {
  const normalizedItems: ContextMenuItem[] = [];

  for (const sourceItem of source) {
    if (typeof sourceItem.id !== "string" || typeof sourceItem.label !== "string") {
      continue;
    }

    const normalizedItem: ContextMenuItem = {
      id: sourceItem.id,
      label: sourceItem.label,
      destructive: sourceItem.destructive === true,
      disabled: sourceItem.disabled === true,
    };

    if (sourceItem.children) {
      const normalizedChildren = normalizeContextMenuItems(sourceItem.children);
      if (normalizedChildren.length === 0) {
        continue;
      }
      normalizedItem.children = normalizedChildren;
    }

    normalizedItems.push(normalizedItem);
  }

  return normalizedItems;
}

type WindowTitleBarOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];
type LinuxDesktopNamedApp = Electron.App & {
  setDesktopName?: (desktopName: string) => void;
};

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess.ChildProcess | null = null;
let backendPort = 0;
let backendBindHost = DESKTOP_LOOPBACK_HOST;
let backendBootstrapToken = "";
let backendHttpUrl = "";
let backendWsUrl = "";
let backendEndpointUrl: string | null = null;
let backendAdvertisedHost: string | null = null;
let backendReadinessAbortController: AbortController | null = null;
let backendInitialWindowOpenInFlight: Promise<void> | null = null;
let backendListeningDetector: ServerListeningDetector | null = null;
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;
let backendObservabilitySettings = readPersistedBackendObservabilitySettings();
let desktopSettings = readDesktopSettings(DESKTOP_SETTINGS_PATH, app.getVersion());
let desktopServerExposureMode: DesktopServerExposureMode = desktopSettings.serverExposureMode;

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
const expectedBackendExitChildren = new WeakSet<ChildProcess.ChildProcess>();
const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});
const initialUpdateState = (): DesktopUpdateState =>
  createInitialDesktopUpdateState(
    app.getVersion(),
    desktopRuntimeInfo,
    desktopSettings.updateChannel,
  );

function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readPersistedBackendObservabilitySettings(): {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
} {
  try {
    if (!FS.existsSync(SERVER_SETTINGS_PATH)) {
      return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
    }
    return parsePersistedServerObservabilitySettings(FS.readFileSync(SERVER_SETTINGS_PATH, "utf8"));
  } catch (error) {
    console.warn("[desktop] failed to read persisted backend observability settings", error);
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }
}

function resolveConfiguredDesktopBackendPort(rawPort: string | undefined): number | undefined {
  if (!rawPort) {
    return undefined;
  }

  const parsedPort = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    return undefined;
  }

  return parsedPort;
}

function resolveDesktopDevServerUrl(): string {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
  if (!devServerUrl) {
    throw new Error("VITE_DEV_SERVER_URL is required in desktop development.");
  }

  return devServerUrl;
}

function backendChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.T3CODE_PORT;
  delete env.T3CODE_MODE;
  delete env.T3CODE_NO_BROWSER;
  delete env.T3CODE_HOST;
  delete env.T3CODE_DESKTOP_WS_URL;
  delete env.T3CODE_DESKTOP_LAN_ACCESS;
  delete env.T3CODE_DESKTOP_LAN_HOST;
  // Enable the backend's V8 compile cache from its very first import. Setting
  // the env (rather than calling enableCompileCache in bin.ts) covers the
  // entry's own static imports, which matters most here: the server keeps its
  // dependencies external, so cold start loads hundreds of node_modules files.
  return withCompileCacheEnv(
    env,
    resolveCompileCacheDir("t3code-backend", app.getPath("userData")),
  );
}

function getDesktopServerExposureState(): DesktopServerExposureState {
  return {
    mode: desktopServerExposureMode,
    endpointUrl: backendEndpointUrl,
    advertisedHost: backendAdvertisedHost,
  };
}

function getDesktopSecretStorage() {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (value: string) => safeStorage.encryptString(value),
    decryptString: (value: Buffer) => safeStorage.decryptString(value),
  } as const;
}

function resolveAdvertisedHostOverride(): string | undefined {
  const override = process.env.T3CODE_DESKTOP_LAN_HOST?.trim();
  return override && override.length > 0 ? override : undefined;
}

async function applyDesktopServerExposureMode(
  mode: DesktopServerExposureMode,
  options?: { readonly persist?: boolean; readonly rejectIfUnavailable?: boolean },
): Promise<DesktopServerExposureState> {
  const advertisedHostOverride = resolveAdvertisedHostOverride();
  const requestedMode = mode;
  let exposure = resolveDesktopServerExposure({
    mode,
    port: backendPort,
    networkInterfaces: OS.networkInterfaces(),
    ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
  });

  if (requestedMode === "network-accessible" && exposure.endpointUrl === null) {
    if (options?.rejectIfUnavailable) {
      throw new Error("No reachable network address is available for this desktop right now.");
    }
    exposure = resolveDesktopServerExposure({
      mode: "local-only",
      port: backendPort,
      networkInterfaces: OS.networkInterfaces(),
      ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
    });
  }

  desktopServerExposureMode = exposure.mode;
  desktopSettings = setDesktopServerExposurePreference(desktopSettings, requestedMode);
  backendBindHost = exposure.bindHost;
  backendHttpUrl = exposure.localHttpUrl;
  backendWsUrl = exposure.localWsUrl;
  backendEndpointUrl = exposure.endpointUrl;
  backendAdvertisedHost = exposure.advertisedHost;

  if (options?.persist) {
    writeDesktopSettings(DESKTOP_SETTINGS_PATH, desktopSettings);
  }

  return getDesktopServerExposureState();
}

function relaunchDesktopApp(reason: string): void {
  writeDesktopLogHeader(`desktop relaunch requested reason=${reason}`);
  setImmediate(() => {
    isQuitting = true;
    clearUpdatePollTimer();
    cancelBackendReadinessWait();
    void stopBackendAndWaitForExit()
      .catch((error) => {
        writeDesktopLogHeader(
          `desktop relaunch backend shutdown warning message=${formatErrorMessage(error)}`,
        );
      })
      .finally(() => {
        restoreStdIoCapture?.();
        if (isDevelopment) {
          app.exit(75);
          return;
        }
        app.relaunch({
          execPath: process.execPath,
          args: process.argv.slice(1),
        });
        app.exit(0);
      });
  });
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }

  return null;
}

async function waitForBackendHttpReady(
  baseUrl: string,
  options?: Parameters<typeof waitForHttpReady>[1],
): Promise<void> {
  cancelBackendReadinessWait();
  const controller = new AbortController();
  backendReadinessAbortController = controller;

  try {
    await waitForHttpReady(baseUrl, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    if (backendReadinessAbortController === controller) {
      backendReadinessAbortController = null;
    }
  }
}

function cancelBackendReadinessWait(): void {
  backendReadinessAbortController?.abort();
  backendReadinessAbortController = null;
}

async function waitForBackendWindowReady(baseUrl: string): Promise<"listening" | "http"> {
  return await waitForBackendStartupReady({
    listeningPromise: backendListeningDetector?.promise ?? null,
    waitForHttpReady: () =>
      waitForBackendHttpReady(baseUrl, {
        timeoutMs: 60_000,
      }),
    cancelHttpWait: cancelBackendReadinessWait,
  });
}

function ensureInitialBackendWindowOpen(): void {
  const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (isDevelopment || existingWindow !== null || backendInitialWindowOpenInFlight !== null) {
    return;
  }

  const nextOpen = waitForBackendWindowReady(backendHttpUrl)
    .then((source) => {
      writeDesktopLogHeader(`bootstrap backend ready source=${source}`);
      if (mainWindow ?? BrowserWindow.getAllWindows()[0]) {
        return;
      }
      mainWindow = createWindow();
      writeDesktopLogHeader("bootstrap main window created");
    })
    .catch((error) => {
      if (isBackendReadinessAborted(error)) {
        return;
      }
      writeDesktopLogHeader(
        `bootstrap backend readiness warning message=${formatErrorMessage(error)}`,
      );
      console.warn("[desktop] backend readiness check timed out during packaged bootstrap", error);
    })
    .finally(() => {
      if (backendInitialWindowOpenInFlight === nextOpen) {
        backendInitialWindowOpenInFlight = null;
      }
    });

  backendInitialWindowOpenInFlight = nextOpen;
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "desktop-main.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "server-child.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

function captureBackendOutput(child: ChildProcess.ChildProcess): void {
  const attachStream = (stream: NodeJS.ReadableStream | null | undefined): void => {
    stream?.on("data", (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      backendLogSink?.write(buffer);
      backendListeningDetector?.push(buffer);
    });
  };

  attachStream(child.stdout);
  attachStream(child.stderr);
}

initializePackagedLogging();

if (process.platform === "linux") {
  app.commandLine.appendSwitch("class", LINUX_WM_CLASS);
}

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let updateInstallInFlight = false;
let updaterConfigured = false;
let updateState: DesktopUpdateState = initialUpdateState();

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (updateInstallInFlight) return "install";
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function resolveAppRoot(): string {
  if (!app.isPackaged) {
    return ROOT_DIR;
  }
  return app.getAppPath();
}

/** Read the baked-in app-update.yml config (if applicable). */
function readAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

function resolveEmbeddedCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { t3codeCommitHash?: unknown };
    return normalizeCommitHash(parsed.t3codeCommitHash);
  } catch {
    return null;
  }
}

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(process.env.T3CODE_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/bin.mjs");
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

function resolveDesktopStaticPath(staticRoot: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  const rawPath = decodeURIComponent(url.pathname);
  const normalizedPath = Path.posix.normalize(rawPath).replace(/^\/+/, "");
  if (normalizedPath.includes("..")) {
    return Path.join(staticRoot, "index.html");
  }

  const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
  const resolvedPath = Path.join(staticRoot, requestedPath);

  if (Path.extname(resolvedPath)) {
    return resolvedPath;
  }

  const nestedIndex = Path.join(resolvedPath, "index.html");
  if (FS.existsSync(nestedIndex)) {
    return nestedIndex;
  }

  return Path.join(staticRoot, "index.html");
}

function isStaticAssetRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return Path.extname(url.pathname).length > 0;
  } catch {
    return false;
  }
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("T3 Code failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  stopBackend();
  restoreStdIoCapture?.();
  app.quit();
}

function registerDesktopProtocol(): void {
  if (isDevelopment || desktopProtocolRegistered) return;

  const staticRoot = resolveDesktopStaticDir();
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      const isAssetRequest = isStaticAssetRequest(request.url);

      if (!isInRoot || !FS.existsSync(resolvedCandidate)) {
        if (isAssetRequest) {
          callback({ error: -6 });
          return;
        }
        callback({ path: fallbackIndex });
        return;
      }

      callback({ path: resolvedCandidate });
    } catch {
      callback({ path: fallbackIndex });
    }
  });

  desktopProtocolRegistered = true;
}

function dispatchMenuAction(action: string): void {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
    revealWindow(targetWindow);
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function handleCheckForUpdatesMenuClick(): void {
  const hasUpdateFeedConfig =
    readAppUpdateYml() !== null || Boolean(process.env.T3CODE_DESKTOP_MOCK_UPDATES);
  const disabledReason = getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
    hasUpdateFeedConfig,
  });
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow();
  }
  void checkForUpdatesFromMenu();
}

async function checkForUpdatesFromMenu(): Promise<void> {
  await checkForUpdates("menu");

  if (updateState.status === "up-to-date") {
    void dialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `T3 Code ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    void dialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuAction("open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        ...(process.platform === "darwin"
          ? []
          : [
              {
                label: "Settings...",
                accelerator: "CmdOrCtrl+,",
                click: () => dispatchMenuAction("open-settings"),
              },
              { type: "separator" as const },
            ]),
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources", fileName),
    Path.join(__dirname, "../prod-resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  if (isDevelopment && process.platform === "darwin" && ext === "png") {
    const developmentDockIconPath = Path.join(
      ROOT_DIR,
      "assets",
      "dev",
      "blueprint-macos-1024.png",
    );
    if (FS.existsSync(developmentDockIconPath)) {
      return developmentDockIconPath;
    }
  }

  return resolveResourcePath(`icon.${ext}`);
}

/**
 * Resolve the Electron userData directory path.
 *
 * Electron derives the default userData path from `productName` in
 * package.json, which currently produces directories with spaces and
 * parentheses (e.g. `~/.config/T3 Code (Alpha)` on Linux). This is
 * unfriendly for shell usage and violates Linux naming conventions.
 *
 * We override it to a clean lowercase name (`t3code`). If the legacy
 * directory already exists we keep using it so existing users don't
 * lose their Chromium profile data (localStorage, cookies, sessions).
 */
function resolveUserDataPath(): string {
  const appDataBase =
    process.platform === "win32"
      ? process.env.APPDATA || Path.join(OS.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? Path.join(OS.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || Path.join(OS.homedir(), ".config");

  const legacyPath = Path.join(appDataBase, LEGACY_USER_DATA_DIR_NAME);
  if (FS.existsSync(legacyPath)) {
    return legacyPath;
  }

  return Path.join(appDataBase, USER_DATA_DIR_NAME);
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }

  if (process.platform === "linux") {
    (app as LinuxDesktopNamedApp).setDesktopName?.(LINUX_DESKTOP_ENTRY_NAME);
  }

  if (process.platform === "darwin" && app.dock) {
    const iconPath = resolveIconPath("png");
    if (iconPath) {
      app.dock.setIcon(iconPath);
    }
  }
}

function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

function revealWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  if (!window.isVisible()) {
    window.show();
  }

  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }

  window.focus();
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
  }
}

function emitNotificationClick(request: DesktopNotificationRequest): void {
  const window = mainWindow ?? BrowserWindow.getAllWindows().find((entry) => !entry.isDestroyed());
  if (!window || window.isDestroyed()) {
    return;
  }

  revealWindow(window);
  window.webContents.send(NOTIFICATION_CLICKED_CHANNEL, {
    kind: request.kind,
    environmentId: request.environmentId,
    threadId: request.threadId,
    turnId: request.turnId,
  });
}

function showDesktopNotification(request: DesktopNotificationRequest): boolean {
  if (!Notification.isSupported()) {
    return false;
  }

  const notification = new Notification({
    title: request.title,
    body: request.body,
    silent: false,
  });
  notification.on("click", () => emitNotificationClick(request));
  notification.show();
  return true;
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch };
  emitUpdateState();
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
  };
}

function applyAutoUpdaterChannel(channel: DesktopUpdateChannel): void {
  autoUpdater.channel = channel;
  autoUpdater.allowPrerelease = channel === "nightly";
  autoUpdater.allowDowngrade = channel === "nightly";
  console.info(
    `[desktop-updater] Using update channel '${channel}' (allowPrerelease=${channel === "nightly"}, allowDowngrade=${channel === "nightly"}).`,
  );
}

function shouldEnableAutoUpdates(): boolean {
  const hasUpdateFeedConfig =
    readAppUpdateYml() !== null || Boolean(process.env.T3CODE_DESKTOP_MOCK_UPDATES);
  return (
    getAutoUpdateDisabledReason({
      isDevelopment,
      isPackaged: app.isPackaged,
      platform: process.platform,
      appImage: process.env.APPIMAGE,
      disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
      hasUpdateFeedConfig,
    }) === null
  );
}

async function checkForUpdates(reason: string): Promise<boolean> {
  if (isQuitting || !updaterConfigured || updateCheckInFlight) return false;
  if (updateState.status === "downloading" || updateState.status === "downloaded") {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`,
    );
    return false;
  }
  updateCheckInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, new Date().toISOString()));
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    await autoUpdater.checkForUpdates();
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(updateState, message, new Date().toISOString()),
    );
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
    return true;
  } finally {
    updateCheckInFlight = false;
  }
}

async function downloadAvailableUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  updateDownloadInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  console.info("[desktop-updater] Downloading update...");

  try {
    await autoUpdater.downloadUpdate();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    updateDownloadInFlight = false;
  }
}

async function installDownloadedUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") {
    return { accepted: false, completed: false };
  }

  isQuitting = true;
  updateInstallInFlight = true;
  clearUpdatePollTimer();
  try {
    await stopBackendAndWaitForExit();
    // Destroy all windows before launching the NSIS installer to avoid the installer finding live windows it needs to close.
    for (const win of BrowserWindow.getAllWindows()) {
      win.destroy();
    }
    // `quitAndInstall()` only starts the handoff to the updater. The actual
    // install may still fail asynchronously, so keep the action incomplete
    // until we either quit or receive an updater error.
    autoUpdater.quitAndInstall(true, true);
    return { accepted: true, completed: false };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    updateInstallInFlight = false;
    isQuitting = false;
    setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    return { accepted: true, completed: false };
  }
}

function configureAutoUpdater(): void {
  const githubToken =
    process.env.T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";
  if (githubToken) {
    // When a token is provided, re-configure the feed with `private: true` so
    // electron-updater uses the GitHub API (api.github.com) instead of the
    // public Atom feed (github.com/…/releases.atom) which rejects Bearer auth.
    const appUpdateYml = readAppUpdateYml();
    if (appUpdateYml?.provider === "github") {
      autoUpdater.setFeedURL({
        ...appUpdateYml,
        provider: "github" as const,
        private: true,
        token: githubToken,
      });
    }
  }

  if (process.env.T3CODE_DESKTOP_MOCK_UPDATES) {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: `http://localhost:${process.env.T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT ?? 3000}`,
    });
  }

  const enabled = shouldEnableAutoUpdates();
  setUpdateState(createBaseUpdateState(desktopSettings.updateChannel, enabled));
  if (!enabled) {
    return;
  }
  updaterConfigured = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  applyAutoUpdaterChannel(desktopSettings.updateChannel);
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  let lastLoggedDownloadMilestone = -1;

  if (isArm64HostRunningIntelBuild(desktopRuntimeInfo)) {
    console.info(
      "[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.",
    );
  }

  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    if (!doesVersionMatchDesktopUpdateChannel(info.version, updateState.channel)) {
      console.info(
        `[desktop-updater] Ignoring ${info.version} because it does not match the selected '${updateState.channel}' channel.`,
      );
      setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
      lastLoggedDownloadMilestone = -1;
      return;
    }

    setUpdateState(
      reduceDesktopUpdateStateOnUpdateAvailable(
        updateState,
        info.version,
        new Date().toISOString(),
      ),
    );
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    const message = formatErrorMessage(error);
    if (updateInstallInFlight) {
      updateInstallInFlight = false;
      isQuitting = false;
      setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
      console.error(`[desktop-updater] Updater error: ${message}`);
      return;
    }
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext: resolveUpdaterErrorContext(),
        canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    if (
      shouldBroadcastDownloadProgress(updateState, progress.percent) ||
      updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
    console.info(`[desktop-updater] Update downloaded: ${info.version}`);
  });

  clearUpdatePollTimer();

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}
function scheduleBackendRestart(reason: string): void {
  if (isQuitting || restartTimer) return;

  const delayMs = Math.min(500 * 2 ** restartAttempt, 10_000);
  restartAttempt += 1;
  console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, delayMs);
}

function startBackend(): void {
  if (isQuitting || backendProcess) return;

  backendObservabilitySettings = readPersistedBackendObservabilitySettings();
  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  const captureBackendLogs = !isDevelopment;
  const child = ChildProcess.spawn(process.execPath, [backendEntry, "--bootstrap-fd", "3"], {
    cwd: resolveBackendCwd(),
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    env: {
      ...backendChildEnv(),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: captureBackendLogs
      ? ["ignore", "pipe", "pipe", "pipe"]
      : ["ignore", "inherit", "inherit", "pipe"],
  });
  const bootstrapStream = child.stdio[3];
  if (bootstrapStream && "write" in bootstrapStream) {
    bootstrapStream.write(
      `${JSON.stringify({
        mode: "desktop",
        noBrowser: true,
        port: backendPort,
        t3Home: BASE_DIR,
        host: backendBindHost,
        desktopBootstrapToken: backendBootstrapToken,
        ...(backendObservabilitySettings.otlpTracesUrl
          ? { otlpTracesUrl: backendObservabilitySettings.otlpTracesUrl }
          : {}),
        ...(backendObservabilitySettings.otlpMetricsUrl
          ? { otlpMetricsUrl: backendObservabilitySettings.otlpMetricsUrl }
          : {}),
      })}\n`,
    );
    bootstrapStream.end();
  } else {
    child.kill("SIGTERM");
    scheduleBackendRestart("missing desktop bootstrap pipe");
    return;
  }
  const listeningDetector = new ServerListeningDetector();
  backendListeningDetector = listeningDetector;
  backendProcess = child;
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    writeBackendSessionBoundary("END", details);
  };
  writeBackendSessionBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`,
  );
  captureBackendOutput(child);

  child.once("spawn", () => {
    restartAttempt = 0;
  });

  child.on("error", (error) => {
    if (backendListeningDetector === listeningDetector) {
      listeningDetector.fail(error);
      backendListeningDetector = null;
    }
    const wasExpected = expectedBackendExitChildren.has(child);
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    if (wasExpected) {
      return;
    }
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    if (backendListeningDetector === listeningDetector) {
      listeningDetector.fail(
        new Error(
          `backend exited before logging readiness (code=${code ?? "null"} signal=${signal ?? "null"})`,
        ),
      );
      backendListeningDetector = null;
    }
    const wasExpected = expectedBackendExitChildren.has(child);
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(
      `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    if (isQuitting || wasExpected) return;
    const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    scheduleBackendRestart(reason);
  });

  ensureInitialBackendWindowOpen();
}

function stopBackend(): void {
  cancelBackendReadinessWait();
  backendListeningDetector = null;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    expectedBackendExitChildren.add(child);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000).unref();
  }
}

async function stopBackendAndWaitForExit(timeoutMs = 5_000): Promise<void> {
  cancelBackendReadinessWait();
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;
  const backendChild = child;
  if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;
  expectedBackendExitChildren.add(backendChild);

  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function settle(): void {
      if (settled) return;
      settled = true;
      backendChild.off("exit", onExit);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (exitTimeoutTimer) {
        clearTimeout(exitTimeoutTimer);
      }
      resolve();
    }

    function onExit(): void {
      settle();
    }

    backendChild.once("exit", onExit);
    backendChild.kill("SIGTERM");

    forceKillTimer = setTimeout(() => {
      if (backendChild.exitCode === null && backendChild.signalCode === null) {
        backendChild.kill("SIGKILL");
      }
    }, 2_000);
    forceKillTimer.unref();

    exitTimeoutTimer = setTimeout(() => {
      settle();
    }, timeoutMs);
    exitTimeoutTimer.unref();
  });
}

const previewTabs = new Map<string, DesktopPreviewTabRecord>();
const previewRecordings = new Map<string, DesktopPreviewRecordingRecord>();
const PREVIEW_MIN_ZOOM_FACTOR = 0.25;
const PREVIEW_MAX_ZOOM_FACTOR = 5;
const PREVIEW_ZOOM_STEP = 0.1;
const PREVIEW_RECORDING_FRAME_INTERVAL_MS = 1_000;

interface DesktopPreviewTabRecord {
  tabId: string;
  url: string | null;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  zoomFactor: number;
  navStatus: DesktopPreviewNavStatus;
  webContentsId: number | null;
  partition: string | null;
  updatedAt: string;
  cleanup: Array<() => void>;
}

interface DesktopPreviewRecordingRecord {
  readonly startedAt: string;
  readonly timer: ReturnType<typeof setInterval>;
  readonly frames: DesktopPreviewRecordingFrame[];
}

type PreviewNavigationAdapter = {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  navigationHistory?: {
    canGoBack?: () => boolean;
    canGoForward?: () => boolean;
    goBack?: () => void;
    goForward?: () => void;
  };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringProperty(
  input: Record<string, unknown>,
  property: string,
  label: string,
): string {
  const value = input[property];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid desktop preview ${label}.`);
  }
  return value;
}

function readPreviewTabId(rawInput: unknown): string {
  if (!isPlainObject(rawInput)) {
    throw new Error("Invalid desktop preview input.");
  }
  return readStringProperty(rawInput, "tabId", "tab id");
}

function readPreviewUrl(rawInput: unknown): string {
  if (!isPlainObject(rawInput)) {
    throw new Error("Invalid desktop preview input.");
  }
  const url = readStringProperty(rawInput, "url", "url");
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported desktop preview protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function readPreviewPartition(rawInput: unknown): string | null {
  if (!isPlainObject(rawInput)) {
    return null;
  }
  const partition = rawInput.partition;
  if (typeof partition !== "string" || partition.trim().length === 0) {
    return null;
  }
  const trimmedPartition = partition.trim();
  if (!isPreviewPartition(trimmedPartition)) {
    throw new Error("Invalid desktop preview partition.");
  }
  return trimmedPartition;
}

function readPreviewWebContentsId(rawInput: unknown): number {
  if (!isPlainObject(rawInput)) {
    throw new Error("Invalid desktop preview input.");
  }
  const webContentsId = rawInput.webContentsId;
  if (typeof webContentsId !== "number" || !Number.isInteger(webContentsId) || webContentsId <= 0) {
    throw new Error("Invalid desktop preview webContents id.");
  }
  return webContentsId;
}

function readOptionalStringProperty(
  input: Record<string, unknown>,
  property: string,
): string | undefined {
  const value = input[property];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readPreviewAutomationCommand(rawInput: unknown): DesktopPreviewAutomationCommand {
  if (!isPlainObject(rawInput)) {
    throw new Error("Invalid desktop preview automation input.");
  }
  const type = readStringProperty(rawInput, "type", "automation type");
  const tabId = readStringProperty(rawInput, "tabId", "tab id");
  switch (type) {
    case "click":
      return {
        type,
        tabId,
        selector: readStringProperty(rawInput, "selector", "selector"),
      };
    case "type":
      return {
        type,
        tabId,
        selector: readStringProperty(rawInput, "selector", "selector"),
        text: readStringProperty(rawInput, "text", "text"),
      };
    case "key":
      return {
        type,
        tabId,
        key: readStringProperty(rawInput, "key", "key"),
      };
    case "evaluate":
      return {
        type,
        tabId,
        script: readStringProperty(rawInput, "script", "script"),
      };
    default:
      throw new Error(`Unsupported desktop preview automation command: ${type}`);
  }
}

function createPreviewTabRecord(tabId: string): DesktopPreviewTabRecord {
  return {
    tabId,
    url: null,
    title: null,
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    zoomFactor: 1,
    navStatus: { kind: "idle" },
    webContentsId: null,
    partition: null,
    updatedAt: new Date().toISOString(),
    cleanup: [],
  };
}

function getOrCreatePreviewTabRecord(tabId: string): DesktopPreviewTabRecord {
  const existing = previewTabs.get(tabId);
  if (existing) {
    return existing;
  }

  const record = createPreviewTabRecord(tabId);
  previewTabs.set(tabId, record);
  return record;
}

function readPreviewTabRecord(rawInput: unknown): DesktopPreviewTabRecord | null {
  const tabId = readPreviewTabId(rawInput);
  return previewTabs.get(tabId) ?? null;
}

function toDesktopPreviewTabState(record: DesktopPreviewTabRecord): DesktopPreviewTabState {
  return {
    tabId: record.tabId,
    url: record.url,
    title: record.title,
    canGoBack: record.canGoBack,
    canGoForward: record.canGoForward,
    isLoading: record.isLoading,
    zoomFactor: record.zoomFactor,
    navStatus: record.navStatus,
    updatedAt: record.updatedAt,
  };
}

function emitPreviewStateChange(change: DesktopPreviewStateChange): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(PREVIEW_STATE_CHANNEL, change);
    }
  }
}

function emitPreviewTabUpdated(record: DesktopPreviewTabRecord): void {
  emitPreviewStateChange({ type: "updated", state: toDesktopPreviewTabState(record) });
}

function touchPreviewTabRecord(record: DesktopPreviewTabRecord): void {
  record.updatedAt = new Date().toISOString();
}

function hasMeaningfulPreviewUrl(url: string | null): url is string {
  return Boolean(url && url !== "about:blank");
}

function resolvePreviewWebContents(record: DesktopPreviewTabRecord): WebContents | null {
  if (record.webContentsId === null) {
    return null;
  }
  const contents = webContents.fromId(record.webContentsId);
  if (!contents || contents.isDestroyed() || !isPreviewWebContents(contents, record)) {
    record.webContentsId = null;
    return null;
  }
  return contents;
}

function isPreviewWebContents(contents: WebContents, record: DesktopPreviewTabRecord): boolean {
  const hostWebContentsType = (contents as WebContents & { getType?: () => string }).getType?.();
  return hostWebContentsType === "webview" && isPreviewPartition(record.partition ?? "");
}

function requirePreviewWebContents(rawInput: unknown): WebContents {
  const record = readPreviewTabRecord(rawInput);
  const contents = record ? resolvePreviewWebContents(record) : null;
  if (!contents) {
    throw new Error("Desktop preview tab is not attached.");
  }
  return contents;
}

async function capturePreviewFrame(input: {
  readonly tabId: string;
}): Promise<DesktopPreviewRecordingFrame> {
  const contents = requirePreviewWebContents(input);
  const image = await contents.capturePage();
  return {
    dataUrl: image.toDataURL(),
    capturedAt: new Date().toISOString(),
  };
}

function stopPreviewRecording(tabId: string): DesktopPreviewRecordingRecord | null {
  const recording = previewRecordings.get(tabId) ?? null;
  if (!recording) {
    return null;
  }
  clearInterval(recording.timer);
  previewRecordings.delete(tabId);
  return recording;
}

async function injectPreviewAnnotation(input: {
  readonly tabId: string;
  readonly selector: string;
  readonly label?: string;
}): Promise<void> {
  const contents = requirePreviewWebContents({ tabId: input.tabId });
  const selector = JSON.stringify(input.selector);
  const label = JSON.stringify(input.label ?? input.selector);
  await contents.executeJavaScript(`
    (() => {
      const selector = ${selector};
      const label = ${label};
      const target = document.querySelector(selector);
      if (!target) throw new Error("No element matched selector: " + selector);
      window.__t3PreviewAnnotations?.forEach((node) => node.remove());
      window.__t3PreviewAnnotations = [];
      const rect = target.getBoundingClientRect();
      const outline = document.createElement("div");
      outline.style.cssText = [
        "position:fixed",
        "left:" + rect.left + "px",
        "top:" + rect.top + "px",
        "width:" + rect.width + "px",
        "height:" + rect.height + "px",
        "z-index:2147483647",
        "pointer-events:none",
        "border:2px solid #3b82f6",
        "box-shadow:0 0 0 9999px rgba(15,23,42,.18)",
        "border-radius:4px"
      ].join(";");
      const badge = document.createElement("div");
      badge.textContent = label;
      badge.style.cssText = [
        "position:fixed",
        "left:" + rect.left + "px",
        "top:" + Math.max(0, rect.top - 24) + "px",
        "z-index:2147483647",
        "pointer-events:none",
        "background:#2563eb",
        "color:white",
        "font:12px system-ui,sans-serif",
        "padding:2px 6px",
        "border-radius:999px",
        "max-width:280px",
        "overflow:hidden",
        "text-overflow:ellipsis",
        "white-space:nowrap"
      ].join(";");
      document.documentElement.append(outline, badge);
      window.__t3PreviewAnnotations.push(outline, badge);
    })();
  `);
}

async function clearPreviewAnnotations(rawInput: unknown): Promise<void> {
  const contents = requirePreviewWebContents(rawInput);
  await contents.executeJavaScript(`
    (() => {
      window.__t3PreviewAnnotations?.forEach((node) => node.remove());
      window.__t3PreviewAnnotations = [];
    })();
  `);
}

function readNavigationCapabilities(contents: WebContents): {
  canGoBack: boolean;
  canGoForward: boolean;
} {
  const navigation = contents as WebContents & PreviewNavigationAdapter;
  return {
    canGoBack: navigation.canGoBack?.() ?? navigation.navigationHistory?.canGoBack?.() ?? false,
    canGoForward:
      navigation.canGoForward?.() ?? navigation.navigationHistory?.canGoForward?.() ?? false,
  };
}

function updatePreviewTabFromWebContents(
  record: DesktopPreviewTabRecord,
  contents: WebContents,
  navStatus?: DesktopPreviewNavStatus,
): void {
  const currentUrl = contents.getURL();
  const currentTitle = contents.getTitle();
  const capabilities = readNavigationCapabilities(contents);

  record.url = hasMeaningfulPreviewUrl(currentUrl) ? currentUrl : record.url;
  record.title = currentTitle || record.title || record.url;
  record.canGoBack = capabilities.canGoBack;
  record.canGoForward = capabilities.canGoForward;
  record.isLoading = contents.isLoading();
  record.navStatus =
    navStatus ??
    (record.isLoading && record.url
      ? { kind: "loading", url: record.url, title: record.title }
      : record.url
        ? { kind: "success", url: record.url, title: record.title }
        : { kind: "idle" });
  touchPreviewTabRecord(record);
}

function removePreviewTabListeners(record: DesktopPreviewTabRecord): void {
  for (const cleanup of record.cleanup.splice(0)) {
    cleanup();
  }
}

function bindPreviewWebContents(record: DesktopPreviewTabRecord, contents: WebContents): void {
  removePreviewTabListeners(record);
  record.webContentsId = contents.id;
  contents.setZoomFactor(record.zoomFactor);

  const update = (navStatus?: DesktopPreviewNavStatus) => {
    if (contents.isDestroyed()) {
      return;
    }
    updatePreviewTabFromWebContents(record, contents, navStatus);
    emitPreviewTabUpdated(record);
  };

  const handleStartLoading = () => {
    const currentUrl = contents.getURL();
    const url = hasMeaningfulPreviewUrl(currentUrl) ? currentUrl : (record.url ?? "");
    update({ kind: "loading", url, title: contents.getTitle() || record.title });
  };
  const handleStopLoading = () => {
    const currentUrl = contents.getURL();
    const url = hasMeaningfulPreviewUrl(currentUrl) ? currentUrl : (record.url ?? "");
    update(url ? { kind: "success", url, title: contents.getTitle() || record.title } : undefined);
  };
  const handleNavigate = (_event: unknown, url: string) => {
    record.url = url;
    update({ kind: "success", url, title: contents.getTitle() || record.title });
  };
  const handleFailLoad = (
    _event: unknown,
    errorCode: number,
    errorText: string,
    validatedUrl: string,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame) {
      return;
    }
    const currentUrl = contents.getURL();
    const url =
      validatedUrl || (hasMeaningfulPreviewUrl(currentUrl) ? currentUrl : null) || record.url || "";
    update({
      kind: "failed",
      url,
      title: contents.getTitle() || record.title,
      errorCode,
      errorText,
    });
  };
  const handleDestroyed = () => {
    record.webContentsId = null;
    removePreviewTabListeners(record);
    emitPreviewTabUpdated(record);
  };

  contents.on("did-start-loading", handleStartLoading);
  record.cleanup.push(() => contents.removeListener("did-start-loading", handleStartLoading));
  contents.on("did-stop-loading", handleStopLoading);
  record.cleanup.push(() => contents.removeListener("did-stop-loading", handleStopLoading));
  contents.on("did-navigate", handleNavigate);
  record.cleanup.push(() => contents.removeListener("did-navigate", handleNavigate));
  contents.on("did-navigate-in-page", handleNavigate);
  record.cleanup.push(() => contents.removeListener("did-navigate-in-page", handleNavigate));
  contents.on("did-fail-load", handleFailLoad);
  record.cleanup.push(() => contents.removeListener("did-fail-load", handleFailLoad));
  contents.on("destroyed", handleDestroyed);
  record.cleanup.push(() => contents.removeListener("destroyed", handleDestroyed));

  updatePreviewTabFromWebContents(record, contents);
  emitPreviewTabUpdated(record);
}

function isAbortedNavigationError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return code === "ERR_ABORTED" || error.message.includes("ERR_ABORTED");
  }
  return false;
}

async function loadPreviewUrl(
  record: DesktopPreviewTabRecord,
  contents: WebContents,
  url: string,
): Promise<void> {
  record.url = url;
  record.navStatus = { kind: "loading", url, title: record.title };
  record.isLoading = true;
  touchPreviewTabRecord(record);
  emitPreviewTabUpdated(record);

  try {
    await contents.loadURL(url);
  } catch (error) {
    // A concurrent navigation (typically the renderer's `<webview src>`
    // attribute loading the same URL) aborts this load with ERR_ABORTED.
    // That is expected, not a failure — leave the resulting status to the
    // did-stop-loading / did-fail-load listeners bound to this WebContents.
    if (isAbortedNavigationError(error)) {
      return;
    }
    record.isLoading = false;
    record.navStatus = {
      kind: "failed",
      url,
      title: record.title,
      errorCode: -1,
      errorText: error instanceof Error ? error.message : "Failed to load preview URL.",
    };
    touchPreviewTabRecord(record);
    emitPreviewTabUpdated(record);
    throw error;
  }
}

function navigatePreviewHistory(
  record: DesktopPreviewTabRecord,
  direction: "back" | "forward",
): void {
  const contents = resolvePreviewWebContents(record);
  if (!contents) {
    return;
  }
  const navigation = contents as WebContents & PreviewNavigationAdapter;
  if (direction === "back") {
    if (navigation.canGoBack?.() ?? navigation.navigationHistory?.canGoBack?.() ?? false) {
      if (navigation.goBack) {
        navigation.goBack();
      } else {
        navigation.navigationHistory?.goBack?.();
      }
    }
    return;
  }

  if (navigation.canGoForward?.() ?? navigation.navigationHistory?.canGoForward?.() ?? false) {
    if (navigation.goForward) {
      navigation.goForward();
    } else {
      navigation.navigationHistory?.goForward?.();
    }
  }
}

function setPreviewZoomFactor(
  record: DesktopPreviewTabRecord,
  zoomFactor: number,
): DesktopPreviewTabState {
  const boundedZoomFactor = Math.min(
    PREVIEW_MAX_ZOOM_FACTOR,
    Math.max(PREVIEW_MIN_ZOOM_FACTOR, zoomFactor),
  );
  record.zoomFactor = Number(boundedZoomFactor.toFixed(2));
  const contents = resolvePreviewWebContents(record);
  contents?.setZoomFactor(record.zoomFactor);
  touchPreviewTabRecord(record);
  emitPreviewTabUpdated(record);
  return toDesktopPreviewTabState(record);
}

async function runPreviewAutomationCommand(
  rawInput: unknown,
): Promise<{ ok: boolean; value?: unknown }> {
  const command = readPreviewAutomationCommand(rawInput);
  const contents = requirePreviewWebContents({ tabId: command.tabId });

  switch (command.type) {
    case "click": {
      const selector = JSON.stringify(command.selector);
      await contents.executeJavaScript(`
        (() => {
          const selector = ${selector};
          const target = document.querySelector(selector);
          if (!target) throw new Error("No element matched selector: " + selector);
          target.click();
        })();
      `);
      return { ok: true };
    }
    case "type": {
      const selector = JSON.stringify(command.selector);
      const text = JSON.stringify(command.text);
      await contents.executeJavaScript(`
        (() => {
          const selector = ${selector};
          const text = ${text};
          const target = document.querySelector(selector);
          if (!target) throw new Error("No element matched selector: " + selector);
          target.focus();
          if ("value" in target) {
            target.value = text;
            target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            target.textContent = text;
            target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          }
        })();
      `);
      return { ok: true };
    }
    case "key":
      contents.sendInputEvent({ type: "keyDown", keyCode: command.key });
      contents.sendInputEvent({ type: "keyUp", keyCode: command.key });
      return { ok: true };
    case "evaluate": {
      const value = await contents.executeJavaScript(command.script);
      return { ok: true, value };
    }
  }
  const _exhaustive: never = command;
  throw new Error(`Unsupported desktop preview automation command: ${String(_exhaustive)}`);
}

function closePreviewTabRecord(rawInput: unknown): void {
  const tabId = readPreviewTabId(rawInput);
  const record = previewTabs.get(tabId);
  if (record) {
    removePreviewTabListeners(record);
    stopPreviewRecording(tabId);
    previewTabs.delete(tabId);
  }
  emitPreviewStateChange({ type: "closed", tabId });
}

function registerIpcHandlers(): void {
  ipcMain.removeAllListeners(GET_APP_BRANDING_CHANNEL);
  ipcMain.on(GET_APP_BRANDING_CHANNEL, (event) => {
    event.returnValue = desktopAppBranding;
  });

  ipcMain.removeAllListeners(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL);
  ipcMain.on(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL, (event) => {
    event.returnValue = {
      label: "Local environment",
      httpBaseUrl: backendHttpUrl || null,
      wsBaseUrl: backendWsUrl || null,
      bootstrapToken: backendBootstrapToken || undefined,
    } as const;
  });

  ipcMain.removeHandler(PREVIEW_CREATE_TAB_CHANNEL);
  ipcMain.handle(PREVIEW_CREATE_TAB_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    const url = readPreviewUrl(rawInput);
    const record = getOrCreatePreviewTabRecord(tabId);
    record.partition = readPreviewPartition(rawInput);
    const contents = resolvePreviewWebContents(record);

    // The renderer's `<webview src>` element performs the actual navigation.
    // The main process only mirrors state — issuing our own loadURL here would
    // race with the element's in-flight load and abort it (ERR_ABORTED),
    // leaving the preview stuck in a "loading" state.
    record.url = url;
    record.navStatus =
      contents && !contents.isLoading() && contents.getURL() === url
        ? { kind: "success", url, title: record.title }
        : { kind: "loading", url, title: record.title };
    touchPreviewTabRecord(record);
    emitPreviewTabUpdated(record);

    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_REGISTER_WEBVIEW_CHANNEL);
  ipcMain.handle(PREVIEW_REGISTER_WEBVIEW_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    const webContentsId = readPreviewWebContentsId(rawInput);
    const partition = readPreviewPartition(rawInput);
    const contents = webContents.fromId(webContentsId);
    const record = getOrCreatePreviewTabRecord(tabId);
    if (partition) {
      record.partition = partition;
    }
    if (!contents || contents.isDestroyed() || !isPreviewWebContents(contents, record)) {
      throw new Error("Unknown desktop preview webContents.");
    }
    bindPreviewWebContents(record, contents);
    // Navigation is driven by the renderer's `<webview src>` attribute; binding
    // listeners is enough to mirror its state. Do not call loadURL here — it
    // would abort the element's own in-flight load (ERR_ABORTED).
    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_NAVIGATE_CHANNEL);
  ipcMain.handle(PREVIEW_NAVIGATE_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    const url = readPreviewUrl(rawInput);
    const record = getOrCreatePreviewTabRecord(tabId);
    const contents = resolvePreviewWebContents(record);

    if (contents) {
      await loadPreviewUrl(record, contents, url);
    } else {
      record.url = url;
      record.navStatus = { kind: "loading", url, title: record.title };
      record.isLoading = false;
      touchPreviewTabRecord(record);
      emitPreviewTabUpdated(record);
    }

    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_GO_BACK_CHANNEL);
  ipcMain.handle(PREVIEW_GO_BACK_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    navigatePreviewHistory(record, "back");
    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_GO_FORWARD_CHANNEL);
  ipcMain.handle(PREVIEW_GO_FORWARD_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    navigatePreviewHistory(record, "forward");
    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_REFRESH_CHANNEL);
  ipcMain.handle(PREVIEW_REFRESH_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    resolvePreviewWebContents(record)?.reload();
    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_HARD_RELOAD_CHANNEL);
  ipcMain.handle(PREVIEW_HARD_RELOAD_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    resolvePreviewWebContents(record)?.reloadIgnoringCache();
    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_ZOOM_IN_CHANNEL);
  ipcMain.handle(PREVIEW_ZOOM_IN_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    return setPreviewZoomFactor(record, record.zoomFactor + PREVIEW_ZOOM_STEP);
  });

  ipcMain.removeHandler(PREVIEW_ZOOM_OUT_CHANNEL);
  ipcMain.handle(PREVIEW_ZOOM_OUT_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    return setPreviewZoomFactor(record, record.zoomFactor - PREVIEW_ZOOM_STEP);
  });

  ipcMain.removeHandler(PREVIEW_RESET_ZOOM_CHANNEL);
  ipcMain.handle(PREVIEW_RESET_ZOOM_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    return setPreviewZoomFactor(record, 1);
  });

  ipcMain.removeHandler(PREVIEW_OPEN_DEVTOOLS_CHANNEL);
  ipcMain.handle(PREVIEW_OPEN_DEVTOOLS_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return;
    resolvePreviewWebContents(record)?.openDevTools({ mode: "detach" });
  });

  ipcMain.removeHandler(PREVIEW_CLEAR_COOKIES_CHANNEL);
  ipcMain.handle(PREVIEW_CLEAR_COOKIES_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    const contents = record ? resolvePreviewWebContents(record) : null;
    await contents?.session.clearStorageData({ storages: ["cookies"] });
  });

  ipcMain.removeHandler(PREVIEW_CLEAR_CACHE_CHANNEL);
  ipcMain.handle(PREVIEW_CLEAR_CACHE_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    const contents = record ? resolvePreviewWebContents(record) : null;
    await contents?.session.clearCache();
  });

  ipcMain.removeHandler(PREVIEW_CAPTURE_SCREENSHOT_CHANNEL);
  ipcMain.handle(PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    const frame = await capturePreviewFrame({ tabId });
    return {
      tabId,
      dataUrl: frame.dataUrl,
      capturedAt: frame.capturedAt,
    };
  });

  ipcMain.removeHandler(PREVIEW_START_RECORDING_CHANNEL);
  ipcMain.handle(PREVIEW_START_RECORDING_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    stopPreviewRecording(tabId);
    const frames: DesktopPreviewRecordingFrame[] = [];
    const capture = () => {
      void capturePreviewFrame({ tabId })
        .then((frame) => {
          frames.push(frame);
        })
        .catch(() => undefined);
    };
    capture();
    const timer = setInterval(capture, PREVIEW_RECORDING_FRAME_INTERVAL_MS);
    previewRecordings.set(tabId, {
      startedAt: new Date().toISOString(),
      timer,
      frames,
    });
  });

  ipcMain.removeHandler(PREVIEW_STOP_RECORDING_CHANNEL);
  ipcMain.handle(PREVIEW_STOP_RECORDING_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    const recording = stopPreviewRecording(tabId);
    if (!recording) {
      throw new Error("Desktop preview recording is not active.");
    }
    return {
      tabId,
      startedAt: recording.startedAt,
      stoppedAt: new Date().toISOString(),
      frames: recording.frames,
    };
  });

  ipcMain.removeHandler(PREVIEW_ANNOTATE_ELEMENT_CHANNEL);
  ipcMain.handle(PREVIEW_ANNOTATE_ELEMENT_CHANNEL, async (_event, rawInput: unknown) => {
    if (!isPlainObject(rawInput)) {
      throw new Error("Invalid desktop preview annotation input.");
    }
    const label = readOptionalStringProperty(rawInput, "label");
    await injectPreviewAnnotation({
      tabId: readStringProperty(rawInput, "tabId", "tab id"),
      selector: readStringProperty(rawInput, "selector", "selector"),
      ...(label ? { label } : {}),
    });
  });

  ipcMain.removeHandler(PREVIEW_CLEAR_ANNOTATIONS_CHANNEL);
  ipcMain.handle(PREVIEW_CLEAR_ANNOTATIONS_CHANNEL, async (_event, rawInput: unknown) => {
    await clearPreviewAnnotations(rawInput);
  });

  ipcMain.removeHandler(PREVIEW_RUN_AUTOMATION_CHANNEL);
  ipcMain.handle(PREVIEW_RUN_AUTOMATION_CHANNEL, async (_event, rawInput: unknown) =>
    runPreviewAutomationCommand(rawInput),
  );

  ipcMain.removeHandler(PREVIEW_CLOSE_TAB_CHANNEL);
  ipcMain.handle(PREVIEW_CLOSE_TAB_CHANNEL, async (_event, rawInput: unknown) => {
    closePreviewTabRecord(rawInput);
  });

  ipcMain.removeHandler(GET_CLIENT_SETTINGS_CHANNEL);
  ipcMain.handle(GET_CLIENT_SETTINGS_CHANNEL, async () => readClientSettings(CLIENT_SETTINGS_PATH));

  ipcMain.removeHandler(SET_CLIENT_SETTINGS_CHANNEL);
  ipcMain.handle(SET_CLIENT_SETTINGS_CHANNEL, async (_event, rawSettings: unknown) => {
    if (typeof rawSettings !== "object" || rawSettings === null) {
      throw new Error("Invalid client settings payload.");
    }

    writeClientSettings(CLIENT_SETTINGS_PATH, rawSettings as ClientSettings);
  });

  ipcMain.removeHandler(GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL);
  ipcMain.handle(GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL, async () =>
    readSavedEnvironmentRegistry(SAVED_ENVIRONMENT_REGISTRY_PATH),
  );

  ipcMain.removeHandler(SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL);
  ipcMain.handle(SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL, async (_event, rawRecords: unknown) => {
    if (!Array.isArray(rawRecords)) {
      throw new Error("Invalid saved environment registry payload.");
    }

    writeSavedEnvironmentRegistry(
      SAVED_ENVIRONMENT_REGISTRY_PATH,
      rawRecords as readonly PersistedSavedEnvironmentRecord[],
    );
  });

  ipcMain.removeHandler(GET_SAVED_ENVIRONMENT_SECRET_CHANNEL);
  ipcMain.handle(
    GET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
    async (_event, rawEnvironmentId: unknown) => {
      if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) {
        return null;
      }

      return readSavedEnvironmentSecret({
        registryPath: SAVED_ENVIRONMENT_REGISTRY_PATH,
        environmentId: rawEnvironmentId,
        secretStorage: getDesktopSecretStorage(),
      });
    },
  );

  ipcMain.removeHandler(SET_SAVED_ENVIRONMENT_SECRET_CHANNEL);
  ipcMain.handle(
    SET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
    async (_event, rawEnvironmentId: unknown, rawSecret: unknown) => {
      if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) {
        throw new Error("Invalid saved environment id.");
      }
      if (typeof rawSecret !== "string" || rawSecret.trim().length === 0) {
        throw new Error("Invalid saved environment secret.");
      }

      return writeSavedEnvironmentSecret({
        registryPath: SAVED_ENVIRONMENT_REGISTRY_PATH,
        environmentId: rawEnvironmentId,
        secret: rawSecret,
        secretStorage: getDesktopSecretStorage(),
      });
    },
  );

  ipcMain.removeHandler(REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL);
  ipcMain.handle(
    REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL,
    async (_event, rawEnvironmentId: unknown) => {
      if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) {
        return;
      }

      removeSavedEnvironmentSecret({
        registryPath: SAVED_ENVIRONMENT_REGISTRY_PATH,
        environmentId: rawEnvironmentId,
      });
    },
  );

  ipcMain.removeHandler(GET_SERVER_EXPOSURE_STATE_CHANNEL);
  ipcMain.handle(GET_SERVER_EXPOSURE_STATE_CHANNEL, async () => getDesktopServerExposureState());

  ipcMain.removeHandler(SET_SERVER_EXPOSURE_MODE_CHANNEL);
  ipcMain.handle(SET_SERVER_EXPOSURE_MODE_CHANNEL, async (_event, rawMode: unknown) => {
    if (rawMode !== "local-only" && rawMode !== "network-accessible") {
      throw new Error("Invalid desktop server exposure input.");
    }

    const nextMode = rawMode as DesktopServerExposureMode;
    if (nextMode === desktopServerExposureMode) {
      return getDesktopServerExposureState();
    }

    const nextState = await applyDesktopServerExposureMode(nextMode, {
      persist: true,
      rejectIfUnavailable: true,
    });
    relaunchDesktopApp(`serverExposureMode=${nextMode}`);
    return nextState;
  });

  ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
  ipcMain.handle(PICK_FOLDER_CHANNEL, async (_event, rawOptions: unknown) => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const defaultPath = resolvePickFolderDefaultPath(rawOptions);
    const openDialogOptions: OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      ...(defaultPath ? { defaultPath } : {}),
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, openDialogOptions)
      : await dialog.showOpenDialog(openDialogOptions);
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(CONFIRM_CHANNEL);
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(SET_THEME_CHANNEL);
  ipcMain.handle(SET_THEME_CHANNEL, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    nativeTheme.themeSource = theme;
  });

  ipcMain.removeHandler(SET_VIBRANCY_CHANNEL);
  ipcMain.handle(SET_VIBRANCY_CHANNEL, async (_event, rawEnabled: unknown, rawOptions: unknown) => {
    if (typeof rawEnabled !== "boolean") {
      throw new Error("Invalid vibrancy payload.");
    }

    desktopSettings = setDesktopSidebarVibrancyPreference(desktopSettings, rawEnabled);
    const shouldPersist =
      typeof rawOptions === "object" && rawOptions !== null && "persist" in rawOptions
        ? (rawOptions as { readonly persist?: unknown }).persist !== false
        : true;
    if (shouldPersist) {
      writeDesktopSettings(DESKTOP_SETTINGS_PATH, desktopSettings);
    }
    syncAllWindowAppearance();
    return rawEnabled && (process.platform === "darwin" || process.platform === "win32");
  });

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = normalizeContextMenuItems(items);
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const buildTemplate = (
          entries: readonly ContextMenuItem[],
        ): MenuItemConstructorOptions[] => {
          const template: MenuItemConstructorOptions[] = [];
          let hasInsertedDestructiveSeparator = false;
          for (const item of entries) {
            if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
              template.push({ type: "separator" });
              hasInsertedDestructiveSeparator = true;
            }
            const itemOption: MenuItemConstructorOptions = {
              label: item.label,
              enabled: !item.disabled,
            };
            if (item.children && item.children.length > 0) {
              itemOption.submenu = buildTemplate(item.children);
            } else {
              itemOption.click = () => resolve(item.id);
            }
            if (item.destructive && (!item.children || item.children.length === 0)) {
              const destructiveIcon = getDestructiveMenuIcon();
              if (destructiveIcon) {
                itemOption.icon = destructiveIcon;
              }
            }
            template.push(itemOption);
          }
          return template;
        };

        const menu = Menu.buildFromTemplate(buildTemplate(normalizedItems));
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl);
    if (!externalUrl) {
      return false;
    }

    try {
      await shell.openExternal(externalUrl);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(SHOW_NOTIFICATION_CHANNEL);
  ipcMain.handle(SHOW_NOTIFICATION_CHANNEL, async (_event, rawRequest: unknown) => {
    const request = Schema.decodeUnknownSync(DesktopNotificationRequest)(rawRequest);
    return showDesktopNotification(request);
  });

  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => updateState);

  ipcMain.removeHandler(UPDATE_SET_CHANNEL_CHANNEL);
  ipcMain.handle(UPDATE_SET_CHANNEL_CHANNEL, async (_event, rawChannel: unknown) => {
    if (rawChannel !== "latest" && rawChannel !== "nightly") {
      throw new Error("Invalid desktop update channel input.");
    }
    if (updateCheckInFlight || updateDownloadInFlight || updateInstallInFlight) {
      throw new Error("Cannot change update tracks while an update action is in progress.");
    }

    const nextChannel = rawChannel as DesktopUpdateChannel;

    desktopSettings = setDesktopUpdateChannelPreference(desktopSettings, nextChannel);
    writeDesktopSettings(DESKTOP_SETTINGS_PATH, desktopSettings);

    if (nextChannel === updateState.channel) {
      return updateState;
    }

    const enabled = shouldEnableAutoUpdates();
    setUpdateState(createBaseUpdateState(nextChannel, enabled));

    if (!enabled || !updaterConfigured) {
      return updateState;
    }

    applyAutoUpdaterChannel(nextChannel);
    const allowDowngrade = autoUpdater.allowDowngrade;
    // An explicit channel switch should allow the immediate nightly->stable rollback path.
    autoUpdater.allowDowngrade = true;
    try {
      await checkForUpdates("channel-change");
    } finally {
      autoUpdater.allowDowngrade = allowDowngrade;
    }
    return updateState;
  });

  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    const result = await downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
    if (isQuitting) {
      return {
        accepted: false,
        completed: false,
        state: updateState,
      } satisfies DesktopUpdateActionResult;
    }
    const result = await installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
  ipcMain.handle(UPDATE_CHECK_CHANNEL, async () => {
    if (!updaterConfigured) {
      return {
        checked: false,
        state: updateState,
      } satisfies DesktopUpdateCheckResult;
    }
    const checked = await checkForUpdates("web-ui");
    return {
      checked,
      state: updateState,
    } satisfies DesktopUpdateCheckResult;
  });
}

function getIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

function getInitialWindowBackgroundColor(): string {
  if (desktopSettings.sidebarVibrancyEnabled) {
    return "#00000000";
  }
  return nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

function getWindowVibrancyOptions(): Pick<
  BrowserWindowConstructorOptions,
  "backgroundMaterial" | "transparent" | "vibrancy" | "visualEffectState"
> {
  if (!desktopSettings.sidebarVibrancyEnabled) {
    return {};
  }

  if (process.platform === "darwin") {
    return {
      transparent: true,
      vibrancy: "sidebar",
      visualEffectState: "active",
    };
  }

  if (process.platform === "win32") {
    return {
      backgroundMaterial: "acrylic",
    };
  }

  return {};
}

function getWindowTitleBarOptions(): WindowTitleBarOptions {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: nativeTheme.shouldUseDarkColors
        ? TITLEBAR_DARK_SYMBOL_COLOR
        : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncWindowAppearance(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  window.setBackgroundColor(getInitialWindowBackgroundColor());
  if (process.platform === "darwin") {
    window.setVibrancy(desktopSettings.sidebarVibrancyEnabled ? "sidebar" : null);
  } else if (process.platform === "win32") {
    window.setBackgroundMaterial(desktopSettings.sidebarVibrancyEnabled ? "acrylic" : "none");
  }
  const { titleBarOverlay } = getWindowTitleBarOptions();
  if (typeof titleBarOverlay === "object") {
    window.setTitleBarOverlay(titleBarOverlay);
  }
}

function syncAllWindowAppearance(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    syncWindowAppearance(window);
  }
}

nativeTheme.on("updated", syncAllWindowAppearance);

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: getInitialWindowBackgroundColor(),
    ...getWindowVibrancyOptions(),
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    ...getWindowTitleBarOptions(),
    webPreferences: createMainWindowWebPreferences(Path.join(__dirname, "preload.cjs")),
  });

  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (typeof params.partition !== "string" || !isPreviewPartition(params.partition)) {
      event.preventDefault();
      return;
    }

    webPreferences.sandbox = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
  });

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    const menuTemplate: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuTemplate.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuTemplate.push({ label: "No suggestions", enabled: false });
      }
      menuTemplate.push({ type: "separator" });
    }

    const externalUrl = getSafeExternalUrl(params.linkURL);
    if (externalUrl) {
      menuTemplate.push(
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }

    if (params.mediaType === "image") {
      menuTemplate.push({
        label: "Copy Image",
        click: () => window.webContents.copyImageAt(params.x, params.y),
      });
      menuTemplate.push({ type: "separator" });
    }

    menuTemplate.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );

    Menu.buildFromTemplate(menuTemplate).popup({ window });
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  window.webContents.on("did-finish-load", () => {
    window.setTitle(APP_DISPLAY_NAME);
    emitUpdateState();
  });

  // On Linux/Wayland with `show: false`, Electron's `ready-to-show` only
  // fires after `show()` is called, deadlocking the standard "wait for
  // ready, then show" pattern. Add `did-finish-load` as a Linux-only
  // fallback so the window still surfaces once the renderer has loaded
  // the page. Other platforms keep the no-flash `ready-to-show` path,
  // since `did-finish-load` typically fires before the first paint there.
  const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];
  if (process.platform === "linux") {
    revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
  }
  bindFirstRevealTrigger(revealSubscribers, () => revealWindow(window));

  if (isDevelopment) {
    void window.loadURL(resolveDesktopDevServerUrl());
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(backendHttpUrl);
  }

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
app.setPath("userData", resolveUserDataPath());

configureAppIdentity();

async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");
  const configuredBackendPort = resolveConfiguredDesktopBackendPort(process.env.T3CODE_PORT);
  if (isDevelopment && configuredBackendPort === undefined) {
    throw new Error("T3CODE_PORT is required in desktop development.");
  }

  backendPort =
    configuredBackendPort ??
    (await resolveDesktopBackendPort({
      host: DESKTOP_LOOPBACK_HOST,
      startPort: DEFAULT_DESKTOP_BACKEND_PORT,
      requiredHosts: DESKTOP_REQUIRED_PORT_PROBE_HOSTS,
    }));
  writeDesktopLogHeader(
    configuredBackendPort === undefined
      ? `selected backend port via sequential scan startPort=${DEFAULT_DESKTOP_BACKEND_PORT} port=${backendPort}`
      : `using configured backend port port=${backendPort}`,
  );
  backendBootstrapToken = Crypto.randomBytes(24).toString("hex");
  if (desktopSettings.serverExposureMode !== DEFAULT_DESKTOP_SETTINGS.serverExposureMode) {
    writeDesktopLogHeader(
      `bootstrap restoring persisted server exposure mode mode=${desktopSettings.serverExposureMode}`,
    );
  }
  const serverExposureState = await applyDesktopServerExposureMode(
    desktopSettings.serverExposureMode,
    {
      persist: desktopSettings.serverExposureMode !== DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
    },
  );
  writeDesktopLogHeader(`bootstrap resolved backend endpoint baseUrl=${backendHttpUrl}`);
  if (serverExposureState.endpointUrl) {
    writeDesktopLogHeader(
      `bootstrap enabled network access endpointUrl=${serverExposureState.endpointUrl}`,
    );
  } else if (desktopSettings.serverExposureMode === "network-accessible") {
    writeDesktopLogHeader(
      "bootstrap fell back to local-only because no advertised network host was available",
    );
  }

  registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");
  startBackend();
  writeDesktopLogHeader("bootstrap backend start requested");

  if (isDevelopment) {
    mainWindow = createWindow();
    writeDesktopLogHeader("bootstrap main window created");
    void waitForBackendWindowReady(backendHttpUrl)
      .then((source) => {
        writeDesktopLogHeader(`bootstrap backend ready source=${source}`);
      })
      .catch((error) => {
        if (isBackendReadinessAborted(error)) {
          return;
        }
        writeDesktopLogHeader(
          `bootstrap backend readiness warning message=${formatErrorMessage(error)}`,
        );
        console.warn("[desktop] backend readiness check timed out during dev bootstrap", error);
      });
    return;
  }

  ensureInitialBackendWindowOpen();
}

app.on("before-quit", () => {
  isQuitting = true;
  updateInstallInFlight = false;
  writeDesktopLogHeader("before-quit received");
  clearUpdatePollTimer();
  cancelBackendReadinessWait();
  stopBackend();
  restoreStdIoCapture?.();
});

app
  .whenReady()
  .then(() => {
    writeDesktopLogHeader("app ready");
    configureAppIdentity();
    configureApplicationMenu();
    registerDesktopProtocol();
    configureAutoUpdater();
    void bootstrap().catch((error) => {
      if (isBackendReadinessAborted(error) && isQuitting) {
        return;
      }
      handleFatalStartupError("bootstrap", error);
    });

    app.on("activate", () => {
      const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0];
      if (existingWindow) {
        revealWindow(existingWindow);
        return;
      }
      if (isDevelopment) {
        mainWindow = createWindow();
        return;
      }
      ensureInitialBackendWindowOpen();
    });
  })
  .catch((error) => {
    handleFatalStartupError("whenReady", error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !isQuitting) {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("SIGINT", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGINT received");
    clearUpdatePollTimer();
    cancelBackendReadinessWait();
    stopBackend();
    restoreStdIoCapture?.();
    app.quit();
  });

  process.on("SIGTERM", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGTERM received");
    clearUpdatePollTimer();
    stopBackend();
    restoreStdIoCapture?.();
    app.quit();
  });
}
