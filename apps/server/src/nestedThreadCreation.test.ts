import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { runNestedThreadCreationPhases } from "./nestedThreadCreation.ts";

class PhaseError extends Error {
  readonly definitive: boolean;

  constructor(message: string, definitive: boolean) {
    super(message);
    this.definitive = definitive;
  }
}

const fail = (message: string, definitive: boolean) =>
  Effect.fail(new PhaseError(message, definitive));

const run = (
  phases: Partial<{
    readonly createThread: Effect.Effect<void, PhaseError>;
    readonly startTurn: Effect.Effect<void, PhaseError>;
    readonly cleanupThread: Effect.Effect<void, PhaseError>;
  }> = {},
) =>
  Effect.runPromise(
    runNestedThreadCreationPhases("child-1", true, {
      createThread: phases.createThread ?? Effect.void,
      startTurn: phases.startTurn ?? Effect.void,
      cleanupThread: phases.cleanupThread ?? Effect.void,
      classifyFailure: (error) =>
        error instanceof PhaseError
          ? { definitive: error.definitive, message: error.message }
          : { definitive: false, message: String(error) },
    }),
  );

describe("runNestedThreadCreationPhases", () => {
  it("reports the complete stable success contract", async () => {
    await expect(run()).resolves.toEqual({
      status: "created",
      threadId: "child-1",
      retryable: false,
      workspaceCreated: true,
      cleanupPerformed: false,
      errorCode: null,
      message: "Nested thread created and its first turn was accepted.",
    });
  });

  it("makes a definitive thread-create rejection safely retryable", async () => {
    await expect(run({ createThread: fail("create rejected", true) })).resolves.toMatchObject({
      status: "failed",
      threadId: null,
      retryable: true,
      cleanupPerformed: false,
      errorCode: "THREAD_CREATE_REJECTED",
    });
  });

  it("preserves the generated id after an ambiguous thread-create failure", async () => {
    await expect(run({ createThread: fail("response lost", false) })).resolves.toMatchObject({
      status: "ambiguous",
      threadId: "child-1",
      retryable: false,
      cleanupPerformed: false,
      errorCode: "THREAD_CREATE_AMBIGUOUS",
    });
  });

  it("does not clean up when first-turn acceptance is ambiguous", async () => {
    let cleanupCalls = 0;
    const outcome = await run({
      startTurn: fail("turn response lost", false),
      cleanupThread: Effect.sync(() => {
        cleanupCalls += 1;
      }),
    });

    expect(outcome).toMatchObject({
      status: "ambiguous",
      threadId: "child-1",
      retryable: false,
      cleanupPerformed: false,
      errorCode: "TURN_START_AMBIGUOUS",
    });
    expect(cleanupCalls).toBe(0);
  });

  it("cleans up a definitively rejected first turn and permits a safe retry", async () => {
    await expect(run({ startTurn: fail("turn rejected", true) })).resolves.toMatchObject({
      status: "failed",
      threadId: "child-1",
      retryable: true,
      cleanupPerformed: true,
      errorCode: "TURN_START_REJECTED",
    });
  });

  it("reports a definitive cleanup rejection with the committed thread id", async () => {
    await expect(
      run({
        startTurn: fail("turn rejected", true),
        cleanupThread: fail("delete rejected", true),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      threadId: "child-1",
      retryable: false,
      cleanupPerformed: false,
      errorCode: "THREAD_CLEANUP_REJECTED",
    });
  });

  it("reports ambiguous cleanup without claiming a safe retry", async () => {
    await expect(
      run({
        startTurn: fail("turn rejected", true),
        cleanupThread: fail("delete response lost", false),
      }),
    ).resolves.toMatchObject({
      status: "ambiguous",
      threadId: "child-1",
      retryable: false,
      cleanupPerformed: false,
      errorCode: "THREAD_CLEANUP_AMBIGUOUS",
    });
  });
});
