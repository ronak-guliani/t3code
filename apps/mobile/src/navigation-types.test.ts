import type { StaticParamList } from "@react-navigation/native";
import { expectTypeOf, it } from "vite-plus/test";

import type { RootStack } from "./Stack";

type RootParams = StaticParamList<typeof RootStack>;

it("infers root routes without losing required thread and file parameters", () => {
  expectTypeOf<RootParams>().toEqualTypeOf<ReactNavigation.RootParamList>();
  expectTypeOf<RootParams>().not.toBeAny();
  expectTypeOf<"UnknownRoute">().not.toMatchTypeOf<keyof RootParams>();
  expectTypeOf<RootParams["Home"]>().toBeUndefined();
  expectTypeOf<RootParams["Thread"]>().toEqualTypeOf<{
    readonly environmentId: string;
    readonly threadId: string;
  }>();
  expectTypeOf<{ threadId: string }>().not.toMatchTypeOf<RootParams["Thread"]>();
  expectTypeOf<RootParams["ThreadFile"]>().toEqualTypeOf<{
    readonly environmentId: string;
    readonly threadId: string;
    readonly path: string[];
    readonly line?: string;
  }>();
  expectTypeOf<RootParams["ThreadTerminal"]>().toEqualTypeOf<{
    readonly environmentId: string;
    readonly threadId: string;
    readonly terminalId?: string;
  }>();
});

it("preserves nested sheet route names and incoming share parameter types", () => {
  expectTypeOf<{
    screen: "NewTask";
    params: { incomingShareId: string };
  }>().toMatchTypeOf<RootParams["NewTaskSheet"]>();
  expectTypeOf<{
    screen: "NewTask";
    params: { incomingShareId: number };
  }>().not.toMatchTypeOf<RootParams["NewTaskSheet"]>();
  expectTypeOf<{
    screen: "SettingsContent";
    params: { screen: "SettingsAppearance" };
  }>().toMatchTypeOf<RootParams["SettingsSheet"]>();
  expectTypeOf<{
    screen: "SettingsContent";
    params: { screen: "UnknownSettingsScreen" };
  }>().not.toMatchTypeOf<RootParams["SettingsSheet"]>();
});
