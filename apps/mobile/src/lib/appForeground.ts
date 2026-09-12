import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

type ForegroundListener = (state: AppStateStatus) => void;

const listeners = new Set<ForegroundListener>();
let subscription: { remove: () => void } | null = null;

function ensureSubscription(): void {
  if (subscription === null) {
    subscription = AppState.addEventListener("change", (state) => {
      // Set.forEach skips entries removed during iteration, so a listener
      // may safely unsubscribe itself while handling.
      listeners.forEach((listener) => {
        listener(state);
      });
    });
  }
}

/**
 * Shares one global `AppState` "change" listener across every subscriber
 * (client-event-listeners). Returns an unsubscribe function. The native
 * subscription is installed on first subscribe and removed when the last
 * subscriber leaves.
 */
export function subscribeToAppStateChange(listener: ForegroundListener): () => void {
  listeners.add(listener);
  ensureSubscription();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      subscription?.remove();
      subscription = null;
    }
  };
}

/**
 * React hook over {@link subscribeToAppStateChange}. The callback ref is
 * refreshed every render, so subscribers always observe latest props/state
 * without resubscribing.
 */
export function useOnAppStateChange(callback: ForegroundListener): void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });
  useEffect(() => subscribeToAppStateChange((state) => callbackRef.current(state)), []);
}

/**
 * Test-only reset: drops every subscriber and removes the native listener.
 * Module-level subscription state otherwise leaks across test cases.
 */
export function resetAppStateSubscriptionForTests(): void {
  listeners.clear();
  subscription?.remove();
  subscription = null;
}
