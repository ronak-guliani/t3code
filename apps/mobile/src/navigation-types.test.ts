import type { StaticParamList } from "@react-navigation/native";
import { expectTypeOf, it } from "vite-plus/test";

import type { RootStack } from "./Stack";

type RootParams = StaticParamList<typeof RootStack>;

it("infers root routes without losing required thread and file parameters", () => {
  expectTypeOf<RootParams>().toEqualTypeOf<ReactNavigation.RootParamList>();
  expectTypeOf<RootParams>().not.toBeAny();
  expectTypeOf<"UnknownRoute">().not.toMatchTypeOf<keyof RootParams>();
  expectTypeOf<keyof RootParams>().toEqualTypeOf<
    | "Home"
    | "Thread"
    | "RelatedThreads"
    | "ThreadTerminal"
    | "ThreadReview"
    | "ThreadReviewComment"
    | "ThreadFiles"
    | "ThreadFile"
    | "ThreadSettingsSheet"
    | "GitOverview"
    | "GitCommit"
    | "GitBranches"
    | "GitConfirm"
    | "SettingsSheet"
    | "SettingsLegal"
    | "ConnectOnboarding"
    | "Connections"
    | "ConnectionsNew"
    | "NewTaskSheet"
    | "NotFound"
  >();
  expectTypeOf<RootParams["Home"]>().toBeUndefined();
  expectTypeOf<RootParams["Thread"]>().toEqualTypeOf<{
    readonly environmentId: string;
    readonly threadId: string;
  }>();
  expectTypeOf<RootParams["RelatedThreads"]>().toEqualTypeOf<RootParams["Thread"]>();
  expectTypeOf<{ threadId: string }>().not.toMatchTypeOf<RootParams["Thread"]>();
  expectTypeOf<undefined>().not.toMatchTypeOf<RootParams["Thread"]>();
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
  expectTypeOf<RootParams["GitConfirm"]>().toEqualTypeOf<{
    readonly environmentId: string;
    readonly threadId: string;
    readonly confirmAction?: string;
    readonly branchName?: string;
    readonly includesCommit?: string;
    readonly commitMessage?: string;
    readonly filePaths?: string;
  }>();
});

it("infers nested navigators and grouped screens without eager recursive expansion", () => {
  type Child = {
    config: {
      screens: {
        File: (props: { route: { params: { path: string[] } } }) => null;
      };
      groups: {
        Tools: {
          screens: {
            Search: (props: { route: { params: { query: string } | undefined } }) => null;
          };
        };
      };
    };
  };
  type NestedParams = StaticParamList<{ config: { screens: { Child: Child } } }>;

  expectTypeOf<StaticParamList<Child>>().toEqualTypeOf<{
    File: { path: string[] };
    Search: { query: string } | undefined;
  }>();
  expectTypeOf<{ screen: "File"; params: { path: string[] } }>().toMatchTypeOf<
    NestedParams["Child"]
  >();
  expectTypeOf<{ screen: "File" }>().not.toMatchTypeOf<NestedParams["Child"]>();
  expectTypeOf<{ screen: "Search" }>().toMatchTypeOf<NestedParams["Child"]>();
  expectTypeOf<{ screen: "Unknown" }>().not.toMatchTypeOf<NestedParams["Child"]>();
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
