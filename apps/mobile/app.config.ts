import type { ExpoConfig } from "expo/config";

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";
type BuildEnvironment = Readonly<Record<string, string | undefined>>;

const VARIANT_CONFIG: Record<
  AppVariant,
  {
    readonly appName: string;
    readonly scheme: string;
    readonly iosIcon: string;
    readonly iosBundleIdentifier: string;
    readonly androidPackage: string;
  }
> = {
  development: {
    appName: "T3 Code RG Dev",
    scheme: "t3code-rg-dev",
    iosIcon: "./assets/icon-composer-dev.icon",
    iosBundleIdentifier: "com.ronakguliani.t3code.dev",
    androidPackage: "com.ronakguliani.t3code.dev",
  },
  preview: {
    appName: "T3 Code RG Preview",
    scheme: "t3code-rg-preview",
    iosIcon: "./assets/icon-composer-prod.icon",
    iosBundleIdentifier: "com.ronakguliani.t3code.preview",
    androidPackage: "com.ronakguliani.t3code.preview",
  },
  production: {
    appName: "T3 Code RG",
    scheme: "t3code-rg",
    iosIcon: "./assets/icon-composer-prod.icon",
    iosBundleIdentifier: "com.ronakguliani.t3code",
    androidPackage: "com.ronakguliani.t3code",
  },
};

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case undefined:
      return "development";
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      throw new Error(`Unknown APP_VARIANT: ${value}. Use development, preview, or production.`);
  }
}

export function makeMobileConfig(env: BuildEnvironment): ExpoConfig {
  const appVariant = resolveAppVariant(env.APP_VARIANT);
  const variant = VARIANT_CONFIG[appVariant];
  const owner = env.MOBILE_EAS_OWNER?.trim();
  const projectId = env.MOBILE_EAS_PROJECT_ID?.trim();

  if (Boolean(owner) !== Boolean(projectId)) {
    throw new Error(
      "Set both MOBILE_EAS_OWNER and MOBILE_EAS_PROJECT_ID, or neither for local builds.",
    );
  }
  if (projectId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new Error("MOBILE_EAS_PROJECT_ID must be the UUID of your own Expo project.");
  }
  if (
    owner?.toLowerCase() === "pingdotgg" ||
    projectId?.toLowerCase() === "d763fcb8-d37c-41ea-a773-b54a0ab4a454"
  ) {
    throw new Error("Upstream Expo ownership cannot be used for this mobile fork.");
  }
  if ((env.MOBILE_REQUIRE_EAS_PROJECT === "1" || env.EAS_BUILD === "true") && !projectId) {
    throw new Error("EAS builds require your own MOBILE_EAS_OWNER and MOBILE_EAS_PROJECT_ID.");
  }

  return {
    name: variant.appName,
    slug: "t3-code-rg",
    ...(owner ? { owner } : {}),
    platforms: ["ios", "android"],
    scheme: variant.scheme,
    version: "0.1.0",
    runtimeVersion: {
      policy: "fingerprint",
    },
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    updates: {
      enabled: false,
      checkAutomatically: "NEVER",
    },
    ios: {
      icon: variant.iosIcon,
      supportsTablet: true,
      bundleIdentifier: variant.iosBundleIdentifier,
      infoPlist: {
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true,
        },
        NSLocalNetworkUsageDescription:
          "Allow T3 Code RG to connect to your T3 Code servers on your local network or tailnet.",
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      icon: "./assets/icon.png",
      package: variant.androidPackage,
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
    },
    web: {
      favicon: "./assets/favicon.png",
    },
    plugins: [
      // Expo mod actions execute in reverse registration order; strip APNs after other plugins.
      "./plugins/withLocalOnlyNotifications.cjs",
      ["expo-dev-client", { addGeneratedScheme: appVariant === "development" }],
      ["expo-notifications", { enableBackgroundRemoteNotifications: false }],
      [
        "expo-camera",
        {
          cameraPermission:
            "Allow T3 Code RG to access your camera so you can scan pairing QR codes.",
          barcodeScannerEnabled: true,
        },
      ],
      [
        "expo-splash-screen",
        {
          image: "./assets/splash-icon.png",
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          imageWidth: 220,
          dark: {
            image: "./assets/splash-icon.png",
            backgroundColor: "#0a0a0a",
          },
        },
      ],
      [
        "expo-build-properties",
        {
          ios: {
            deploymentTarget: "18.0",
            extraPods: [
              { name: "GoogleUtilities", modular_headers: true },
              { name: "RecaptchaInterop", modular_headers: true },
            ],
          },
          android: {
            enableProguardInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
          },
        },
      ],
      "expo-secure-store",
      "expo-web-browser",
      "expo-font",
      "./plugins/withIosCocoaPodsUuidCache.cjs",
      [
        "expo-widgets",
        {
          bundleIdentifier: `${variant.iosBundleIdentifier}.widgets`,
          groupIdentifier: `group.${variant.iosBundleIdentifier}`,
          enablePushNotifications: false,
          widgets: [
            {
              name: "AgentActivity",
              displayName: "Agent Activity",
              description: "Shows the current state of active T3 Code agents.",
              supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"],
            },
          ],
        },
      ],
      "./plugins/withIosSceneLifecycle.cjs",
      "./plugins/withAndroidCleartextTraffic.cjs",
    ],
    extra: {
      appVariant,
      // This build uses Direct Connect. Desktop release env must not opt mobile into hosted services.
      relay: {
        url: null,
      },
      clerk: {
        publishableKey: null,
        jwtTemplate: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
}

export default makeMobileConfig(loadRepoEnv());
