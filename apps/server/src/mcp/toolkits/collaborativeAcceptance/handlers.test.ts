import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  CollaborativeAcceptanceCaseId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CollaborationExecutionAuthority,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import {
  CollaborativeAcceptanceCoordinator,
  type CollaborativeAcceptanceCoordinatorShape,
} from "../../../collaborativeAcceptance/Coordinator.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CollaborativeAcceptanceToolkit } from "./tools.ts";
import { CollaborativeAcceptanceToolkitHandlersLive } from "./handlers.ts";

const threadId = ThreadId.make("thread-mcp-authority");
const validAuthority: CollaborationExecutionAuthority = {
  executionId: "thread:thread-mcp-authority",
  assignmentId: "assignment-mcp-authority",
  threadId,
  generation: 7,
  dispatchId: "dispatch-mcp-authority",
  turnId: TurnId.make("turn-mcp-authority"),
};

const thread = {
  id: threadId,
  nudging: {
    delegation: {
      assignmentId: validAuthority.assignmentId,
      dispatchSequence: validAuthority.generation,
      dispatchId: validAuthority.dispatchId,
      dispatchTurnId: validAuthority.turnId,
    },
  },
} as unknown as OrchestrationThread;

const coordinator: CollaborativeAcceptanceCoordinatorShape = {
  status: () => Effect.succeed({ record: null, pauseReason: null }),
  resolveForPullRequest: () => Effect.die("unused"),
  submitCandidate: () => Effect.die("unused"),
  requestReview: () => Effect.die("unused"),
  requestCollaboration: () => Effect.die("unused"),
  respondToRequest: () => Effect.die("unused"),
  dispositionFinding: () => Effect.die("unused"),
  submitAssessment: () => Effect.die("unused"),
  recordProviderEvidence: () => Effect.die("unused"),
  refreshProviderEvidence: () => Effect.die("unused"),
  pause: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
  start: () => Effect.die("unused"),
};

const makeLayer = () =>
  CollaborativeAcceptanceToolkitHandlersLive.pipe(
    Layer.provideMerge(Layer.succeed(CollaborativeAcceptanceCoordinator, coordinator)),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getThreadDetailById: () => Effect.succeed(Option.some(thread)),
      } as unknown as ProjectionSnapshotQuery["Service"]),
    ),
  );

const callStatus = (authority: CollaborationExecutionAuthority | undefined) =>
  Effect.gen(function* () {
    const toolkit = yield* CollaborativeAcceptanceToolkit;
    return yield* toolkit
      .handle("acceptance_status", {
        caseId: CollaborativeAcceptanceCaseId.make("case-mcp-authority"),
      })
      .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
  }).pipe(
    Effect.provide(makeLayer()),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-mcp-authority"),
      threadId,
      providerSessionId: "provider-session-mcp-authority",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set<McpInvocationContext.McpCapability>(),
      issuedAt: 1,
      ...(authority === undefined ? {} : { executionAuthority: authority }),
    }),
  );

it.effect("acceptance MCP status uses the authenticated session authority tuple", () =>
  Effect.gen(function* () {
    const status = yield* callStatus(validAuthority);
    assert.isDefined(status);
  }),
);

it.effect("acceptance MCP handlers reject stale, null, incomplete, and unrelated authority", () =>
  Effect.gen(function* () {
    const stale = { ...validAuthority, generation: validAuthority.generation - 1 };
    const unrelatedAssignment = { ...validAuthority, assignmentId: "assignment-other" };
    const unrelatedThread = {
      ...validAuthority,
      executionId: "thread:thread-other",
      threadId: ThreadId.make("thread-other"),
    };
    const incomplete = {
      ...validAuthority,
      dispatchId: "",
    };

    for (const authority of [undefined, stale, unrelatedAssignment, unrelatedThread, incomplete]) {
      const result = yield* Effect.result(callStatus(authority));
      assert.strictEqual(result._tag, "Failure");
    }
  }),
);
