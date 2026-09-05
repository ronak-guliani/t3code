import type { ExpoConfig } from "expo/config";

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";
type BuildEnvironment = Readonly<Record<string, string | undefined>>;

const OWNED_EAS_PROJECT = {
  owner: "ronakguliani",
  projectId: "01272cd5-225c-47d4-978e-a7eb97c9e457",
} as const;
const OWNED_APPLE_TEAM_ID = "235XX73T5A";
const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

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
  const ownerOverride = env.MOBILE_EAS_OWNER?.trim();
  const projectIdOverride = env.MOBILE_EAS_PROJECT_ID?.trim();

  if (Boolean(ownerOverride) !== Boolean(projectIdOverride)) {
    throw new Error(
      "Set both MOBILE_EAS_OWNER and MOBILE_EAS_PROJECT_ID, or neither for local builds.",
    );
  }
  const owner = ownerOverride || OWNED_EAS_PROJECT.owner;
  const projectId = projectIdOverride || OWNED_EAS_PROJECT.projectId;
  const appleTeamId = env.MOBILE_APPLE_TEAM_ID?.trim() || OWNED_APPLE_TEAM_ID;
  if (!/^[A-Z0-9]{10}$/.test(appleTeamId) || appleTeamId === "ARK85ZXQ4Z") {
    throw new Error("MOBILE_APPLE_TEAM_ID must identify your own 10-character Apple team.");
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

  return {
    name: variant.appName,
    slug: "t3-code-rg",
    owner,
    platforms: ["ios", "android"],
    scheme: variant.scheme,
    version: "0.2.0",
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
      appleTeamId,
      buildNumber: "1",
      infoPlist: {
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true,
        },
        NSLocalNetworkUsageDescription:
          "Allow T3 Code RG to connect to your T3 Code servers on your local network or tailnet.",
        ITSAppUsesNonExemptEncryption: false,
        NSPhotoLibraryAddUsageDescription: "Allow T3 Code RG to save images to your photo library.",
      },
    },
    android: {
      icon: "./assets/icon.png",
      package: variant.androidPackage,
      versionCode: 1,
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: true,
    },
    web: {
      favicon: "./assets/favicon.png",
    },
    plugins: [
      // Expo mod actions execute in reverse registration order; strip APNs after other plugins.
      "./plugins/withLocalOnlyNotifications.cjs",
      ["expo-dev-client", { addGeneratedScheme: appVariant === "development" }],
      ["expo-notifications", { enableBackgroundRemoteNotifications: false }],
      "expo-asset",
      "expo-sqlite",
      "./plugins/withShareExtensionDisplayName.cjs",
      [
        "expo-sharing",
        {
          ios: {
            enabled: true,
            extensionBundleIdentifier: `${variant.iosBundleIdentifier}.sharing`,
            appGroupId: `group.${variant.iosBundleIdentifier}`,
            activationRule: {
              supportsText: true,
              supportsWebUrlWithMaxCount: 1,
              supportsImageWithMaxCount: 8,
              supportsMovieWithMaxCount: 8,
              supportsFileWithMaxCount: 8,
            },
          },
          android: {
            enabled: true,
            singleShareMimeTypes: ["*/*"],
            multipleShareMimeTypes: ["*/*"],
          },
        },
      ],
      [
        "expo-quick-actions",
        {
          androidIcons: {
            shortcut_icon: {
              foregroundImage: "./assets/android-icon-foreground.png",
              backgroundColor: "#E6F4FE",
            },
          },
        },
      ],
      [
        "expo-audio",
        {
          microphonePermission: "Allow T3 Code RG to use your microphone for voice input.",
          recordAudioAndroid: false,
          enableBackgroundPlayback: false,
          enableBackgroundRecording: false,
        },
      ],
      [
        "expo-camera",
        {
          cameraPermission:
            "Allow T3 Code RG to access your camera so you can scan pairing QR codes.",
          barcodeScannerEnabled: true,
          microphonePermission: false,
          recordAudioAndroid: false,
        },
      ],
      ["expo-image-picker", { photosPermission: false, microphonePermission: false }],
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
          },
          android: {
            enableProguardInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
          },
        },
      ],
      "expo-secure-store",
      "expo-web-browser",
      [
        "expo-font",
        {
          ios: { fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold] },
          android: {
            fonts: [
              {
                fontFamily: "DMSans-Regular",
                fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
              },
              {
                fontFamily: "DMSans-Medium",
                fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
              },
              {
                fontFamily: "DMSans-Bold",
                fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
              },
            ],
          },
        },
      ],
      "./plugins/withIosCocoaPodsUuidCache.cjs",
      "./plugins/withWidgetLogoAsset.cjs",
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
      "./plugins/withAndroidGradleHeap.cjs",
      "./plugins/withAndroidModernPopupMenu.cjs",
      "./plugins/withAndroidModernAlertDialog.cjs",
      "./plugins/withAndroidPredictiveBackCompat.cjs",
      "./plugins/withAndroidTabletOrientation.cjs",
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
      eas: { projectId },
    },
  };
}

export default makeMobileConfig(loadRepoEnv());
