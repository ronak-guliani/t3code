import { describe, expect, it } from "vite-plus/test";

import {
  derivePendingApprovalMaxHeight,
  derivePendingUserInputMaxHeight,
} from "./pendingUserInputLayout";

describe("derivePendingUserInputMaxHeight", () => {
  it("caps a tall portrait viewport", () => {
    expect(
      derivePendingUserInputMaxHeight({
        windowHeight: 932,
        keyboardHeight: 0,
        navigationHeaderHeight: 103,
        composerOverlapHeight: 94,
      }),
    ).toBe(560);
  });

  it("subtracts the keyboard while editing a custom answer", () => {
    expect(
      derivePendingUserInputMaxHeight({
        windowHeight: 932,
        keyboardHeight: 336,
        navigationHeaderHeight: 103,
        composerOverlapHeight: 94,
      }),
    ).toBe(387);
  });

  it("keeps the fixed action area usable in a short keyboard-open viewport", () => {
    expect(
      derivePendingUserInputMaxHeight({
        windowHeight: 375,
        keyboardHeight: 240,
        navigationHeaderHeight: 44,
        composerOverlapHeight: 94,
      }),
    ).toBe(160);
  });

  it("bounds approval details by the real short viewport while keeping controls outside the scroll region", () => {
    expect(
      derivePendingApprovalMaxHeight({
        windowHeight: 375,
        keyboardHeight: 0,
        navigationHeaderHeight: 44,
        composerOverlapHeight: 94,
      }),
    ).toBe(225);
  });

  it("never expands an approval beyond the actual available height", () => {
    expect(
      derivePendingApprovalMaxHeight({
        windowHeight: 180,
        keyboardHeight: 0,
        navigationHeaderHeight: 44,
        composerOverlapHeight: 94,
      }),
    ).toBe(30);
  });

  it("clamps an approval to zero when the viewport has no remaining space", () => {
    expect(
      derivePendingApprovalMaxHeight({
        windowHeight: 120,
        keyboardHeight: 0,
        navigationHeaderHeight: 44,
        composerOverlapHeight: 94,
      }),
    ).toBe(0);
  });
});
