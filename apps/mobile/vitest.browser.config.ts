import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vite-plus";

// Exercises React lifecycle only; DOM primitives cannot assert native layout or gestures.
export default defineConfig({
  resolve: {
    alias: {
      "react-native": fileURLToPath(
        new URL("./test/browser-native-primitives.tsx", import.meta.url),
      ),
    },
  },
  optimizeDeps: {
    noDiscovery: true,
    include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom/client"],
  },
  test: {
    include: ["src/**/*.browser.tsx"],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      headless: true,
    },
  },
});
