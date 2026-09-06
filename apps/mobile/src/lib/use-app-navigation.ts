import { type NavigationProp, useNavigation } from "@react-navigation/native";
import { createContext, use } from "react";

type AppNavigation = Pick<NavigationProp<ReactNavigation.RootParamList>, "navigate">;

export const AppNavigationContext = createContext<AppNavigation | null>(null);

/** Independent sidebar stacks own header chrome, not application routes. */
export function useAppNavigation(): AppNavigation {
  const localNavigation = useNavigation();
  return use(AppNavigationContext) ?? localNavigation;
}
