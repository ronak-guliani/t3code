import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

it("defaults auto-pull off and preserves explicit true and false meta updates", async () => {
  const now = "2026-09-05T00:00:00.000Z";
  const projectId = ProjectId.make("auto-pull");
  let model = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: EventId.make("created"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("create"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId,
        title: "Auto pull",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  expect(model.projects[0]?.autoPull).toBe(false);
  for (const autoPull of [true, false]) {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make(`set-${autoPull}`),
          projectId,
          autoPull,
        },
        readModel: model,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event).toMatchObject({ type: "project.meta-updated", payload: { autoPull } });
    model = await Effect.runPromise(projectEvent(model, event));
    expect(model.projects[0]?.autoPull).toBe(autoPull);
  }
});
