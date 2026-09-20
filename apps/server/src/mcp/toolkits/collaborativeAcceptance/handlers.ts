import {
  CollaborationExecutionAuthority,
  CollaborativeAcceptanceError,
  type CollaborativeAcceptanceCaseId,
  type CollaborativeAcceptanceCase,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CollaborativeAcceptanceCoordinator } from "../../../collaborativeAcceptance/Coordinator.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CollaborativeAcceptanceToolkit } from "./tools.ts";

const caller = Effect.fn("CollaborativeAcceptanceToolkit.caller")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const projections = yield* ProjectionSnapshotQuery;
  const thread = yield* projections.getThreadDetailById(invocation.threadId).pipe(
    Effect.mapError(
      () => new CollaborativeAcceptanceError({ message: "Could not resolve the calling thread." }),
    ),
    Effect.flatMap((value) =>
      Option.isSome(value)
        ? Effect.succeed(value.value)
        : Effect.fail(new CollaborativeAcceptanceError({ message: "Calling thread not found." })),
    ),
  );
  const currentTurn = thread.latestTurn;
  const authority: CollaborationExecutionAuthority = {
    executionId: `thread:${thread.id}`,
    generation: currentTurn === null ? 0 : 1,
    dispatchId: null,
    turnId: currentTurn?.turnId ?? null,
  };
  return { invocation, thread, authority };
});

const parentContext = (
  acceptanceCase: CollaborativeAcceptanceCase,
  projections: ProjectionSnapshotQuery["Service"],
) =>
  projections.getThreadDetailById(acceptanceCase.parentThreadId).pipe(
    Effect.mapError(
      () => new CollaborativeAcceptanceError({ message: "Could not resolve acceptance parent." }),
    ),
    Effect.flatMap((value) =>
      Option.isSome(value)
        ? Effect.succeed(value.value)
        : Effect.fail(
            new CollaborativeAcceptanceError({ message: "Acceptance parent is unavailable." }),
          ),
    ),
  );

export const CollaborativeAcceptanceToolkitHandlersLive = CollaborativeAcceptanceToolkit.toLayer({
  acceptance_submit_candidate: (input) =>
    Effect.gen(function* () {
      const context = yield* caller();
      const coordinator = yield* CollaborativeAcceptanceCoordinator;
      const projections = yield* ProjectionSnapshotQuery;
      const caseId = input.caseId;
      const acceptanceCase =
        caseId === undefined
          ? null
          : yield* coordinator
              .status(caseId)
              .pipe(Effect.map((result) => result.record?.case ?? null));
      const parent =
        acceptanceCase === null ? null : yield* parentContext(acceptanceCase, projections);
      const recipientAuthority: CollaborationExecutionAuthority = {
        executionId: parent === null ? "acceptance-parent" : `thread:${parent.id}`,
        generation: parent?.latestTurn === null || parent === null ? 0 : 1,
        dispatchId: null,
        turnId: parent?.latestTurn?.turnId ?? null,
      };
      return yield* coordinator.submitCandidate({
        ...input,
        senderThreadId: context.invocation.threadId,
        recipientThreadId:
          parent?.id ?? context.thread.parentThreadId ?? context.invocation.threadId,
        assignmentId: input.assignmentId,
        senderAuthority: context.authority,
        recipientAuthority,
      });
    }),

  acceptance_request_review: (input) =>
    Effect.gen(function* () {
      const context = yield* caller();
      const coordinator = yield* CollaborativeAcceptanceCoordinator;
      const projections = yield* ProjectionSnapshotQuery;
      const status = yield* coordinator.status(input.caseId);
      if (status.record === null) {
        return yield* new CollaborativeAcceptanceError({ message: "Acceptance case not found." });
      }
      const parent = yield* parentContext(status.record.case, projections);
      return yield* coordinator.requestReview({
        caseId: input.caseId,
        senderThreadId: context.invocation.threadId,
        recipientThreadId: parent.id,
        assignmentId: status.record.case.assignmentId,
        senderAuthority: context.authority,
        recipientAuthority: {
          executionId: `thread:${parent.id}`,
          generation: parent.latestTurn === null ? 0 : 1,
          dispatchId: null,
          turnId: parent.latestTurn?.turnId ?? null,
        },
      });
    }),

  acceptance_request_clarification: (input) => requestCollaboration("clarification", input),
  acceptance_request_decision: (input) => requestCollaboration("decision", input),

  acceptance_respond: (input) =>
    Effect.gen(function* () {
      const context = yield* caller();
      const coordinator = yield* CollaborativeAcceptanceCoordinator;
      yield* coordinator.respondToRequest({
        responderThreadId: context.invocation.threadId,
        responseAuthority: context.authority,
        ...input,
        requestId: input.requestId as never,
      });
    }),

  acceptance_disposition_finding: (input) =>
    Effect.gen(function* () {
      const context = yield* caller();
      const coordinator = yield* CollaborativeAcceptanceCoordinator;
      const status = yield* coordinator.status(input.caseId);
      if (status.record === null) {
        return yield* new CollaborativeAcceptanceError({ message: "Acceptance case not found." });
      }
      return yield* coordinator.dispositionFinding({
        caseId: input.caseId,
        reference: status.record.case.pullRequest,
        itemId: input.itemId,
        disposition: input.disposition,
        ...(input.note === undefined ? {} : { note: input.note }),
        reporterThreadId: context.invocation.threadId,
      });
    }),

  acceptance_submit_assessment: (input) =>
    Effect.gen(function* () {
      yield* caller();
      const coordinator = yield* CollaborativeAcceptanceCoordinator;
      return yield* coordinator.submitAssessment(input);
    }),

  acceptance_status: (input) =>
    Effect.gen(function* () {
      yield* caller();
      const coordinator = yield* CollaborativeAcceptanceCoordinator;
      return yield* coordinator.status(input.caseId);
    }),

  acceptance_pause: (input) =>
    Effect.gen(function* () {
      yield* caller();
      const coordinator = yield* CollaborativeAcceptanceCoordinator;
      return yield* coordinator.pause(input.caseId, input.reason);
    }),

  acceptance_resume: (input) =>
    Effect.gen(function* () {
      yield* caller();
      const coordinator = yield* CollaborativeAcceptanceCoordinator;
      return yield* coordinator.resume(input.caseId);
    }),
});

function requestCollaboration(
  kind: "clarification" | "decision",
  input: { readonly caseId: CollaborativeAcceptanceCaseId; readonly text: string },
) {
  return Effect.gen(function* () {
    const context = yield* caller();
    const coordinator = yield* CollaborativeAcceptanceCoordinator;
    const projections = yield* ProjectionSnapshotQuery;
    const status = yield* coordinator.status(input.caseId);
    if (status.record === null) {
      return yield* new CollaborativeAcceptanceError({ message: "Acceptance case not found." });
    }
    const parent = yield* parentContext(status.record.case, projections);
    yield* coordinator.requestCollaboration({
      kind,
      caseId: input.caseId,
      text: input.text,
      senderThreadId: context.invocation.threadId,
      recipientThreadId: parent.id,
      assignmentId: status.record.case.assignmentId,
      senderAuthority: context.authority,
      recipientAuthority: {
        executionId: `thread:${parent.id}`,
        generation: parent.latestTurn === null ? 0 : 1,
        dispatchId: null,
        turnId: parent.latestTurn?.turnId ?? null,
      },
    });
  }).pipe(Effect.asVoid);
}
