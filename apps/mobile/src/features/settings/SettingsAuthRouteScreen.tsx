import { StackActions, useNavigation } from "@react-navigation/native";
import { lazy, Suspense, useLayoutEffect } from "react";

import { hasCloudPublicConfig } from "../cloud/publicConfig";

const ConfiguredSettingsAuthRouteScreen = lazy(() => import("./ConfiguredSettingsAuthRouteScreen"));

export function SettingsAuthRouteScreen() {
  const navigation = useNavigation();

  useLayoutEffect(() => {
    if (!hasCloudPublicConfig()) {
      navigation.dispatch(StackActions.replace("SettingsContent"));
    }
  }, [navigation]);

  return hasCloudPublicConfig() ? (
    <Suspense fallback={null}>
      <ConfiguredSettingsAuthRouteScreen />
    </Suspense>
  ) : null;
}
