import { type ComponentType, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { reportClientError } from "../lib/clientLogger";
import { createRetryableDeferredModule } from "../lib/retryable-deferred-module";
import { EmptyState } from "./EmptyState";

export function createDeferredRouteScreen<Props extends object>(
  loadScreen: () => Promise<ComponentType<Props>>,
  routeName: string,
): ComponentType<Props> {
  const screenModule = createRetryableDeferredModule(loadScreen);

  function DeferredRouteScreen(props: Props) {
    const [Screen, setScreen] = useState<ComponentType<Props> | null>(() => screenModule.peek());
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
      if (Screen !== null) {
        return;
      }
      let active = true;
      void screenModule.load().then(
        (loadedScreen) => {
          if (active) {
            setScreen(() => loadedScreen);
          }
        },
        (cause: unknown) => {
          if (!active) {
            return;
          }
          reportClientError(`[deferred-route] ${routeName} module load failed`, cause);
          setFailed(true);
        },
      );
      return () => {
        active = false;
      };
    }, [Screen, attempt]);

    if (failed) {
      return (
        <View className="flex-1 items-center justify-center bg-screen px-6">
          <EmptyState
            title="Something went wrong"
            detail="This screen hit an unexpected error. Your threads are safe — try again."
            actionLabel="Try again"
            onAction={() => {
              setFailed(false);
              setAttempt((value) => value + 1);
            }}
          />
        </View>
      );
    }

    if (Screen === null) {
      return (
        <View className="flex-1 items-center justify-center bg-screen">
          <ActivityIndicator size="large" />
        </View>
      );
    }

    return <Screen {...props} />;
  }

  DeferredRouteScreen.displayName = `DeferredRouteScreen(${routeName})`;
  return DeferredRouteScreen;
}
