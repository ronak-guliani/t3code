import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  retryReconciliationCas,
  runReconciliationBatch,
  runReconciliationTick,
} from "./reconciliation.ts";

it.effect("keeps periodic reconciliation alive across repeated CAS conflicts", () =>
  Effect.gen(function* () {
    const attempts = new Map<string, number>();
    const transitions: string[] = [];
    const failedCases: string[] = [];
    const isCasConflict = (error: Error) => error.message === "cas";
    const reconcile = (caseId: string) =>
      retryReconciliationCas(
        Effect.gen(function* () {
          const attempt = (attempts.get(caseId) ?? 0) + 1;
          attempts.set(caseId, attempt);
          if (caseId === "conflicted" && attempt <= 4) {
            return yield* Effect.fail(new Error("cas"));
          }
          transitions.push(caseId);
        }),
        isCasConflict,
      );
    const onFailure = (caseId: string, _error: Error) =>
      Effect.sync(() => {
        failedCases.push(caseId);
      });

    yield* runReconciliationTick(
      runReconciliationBatch(["conflicted", "healthy"], reconcile, onFailure),
      () => Effect.void,
    );
    expect(transitions).toEqual(["healthy"]);
    expect(failedCases).toEqual(["conflicted"]);

    yield* runReconciliationTick(
      runReconciliationBatch(["conflicted", "healthy"], reconcile, onFailure),
      () => Effect.void,
    );
    expect(transitions).toEqual(["healthy", "conflicted", "healthy"]);
    expect(failedCases).toEqual(["conflicted"]);
  }),
);

it.effect("retries provider evidence from fresh state and preserves dirty retries", () =>
  Effect.gen(function* () {
    const attempts = new Map<string, number>();
    const evidenceTransitions: string[] = [];
    const dirtyCases = new Set<string>();
    const isCasConflict = (error: Error) => error.message === "cas";
    const refreshEvidence = (caseId: string) =>
      retryReconciliationCas(
        Effect.gen(function* () {
          const attempt = (attempts.get(caseId) ?? 0) + 1;
          attempts.set(caseId, attempt);
          if (caseId === "retry-once" && attempt === 1) {
            return yield* Effect.fail(new Error("cas"));
          }
          if (caseId === "exhausted" && attempt <= 4) {
            return yield* Effect.fail(new Error("cas"));
          }
          evidenceTransitions.push(`${caseId}:${attempt}`);
        }),
        isCasConflict,
      );
    const reconcile = (caseId: string) =>
      refreshEvidence(caseId).pipe(
        Effect.catch((error) =>
          isCasConflict(error)
            ? Effect.sync(() => {
                dirtyCases.add(caseId);
              })
            : Effect.fail(error),
        ),
      );

    yield* runReconciliationBatch(["retry-once", "exhausted"], reconcile, () => Effect.void);

    expect(attempts.get("retry-once")).toBe(2);
    expect(evidenceTransitions).toEqual(["retry-once:2"]);
    expect(dirtyCases).toEqual(new Set(["exhausted"]));

    dirtyCases.clear();
    yield* runReconciliationBatch(["exhausted"], reconcile, () => Effect.void);

    expect(attempts.get("exhausted")).toBe(5);
    expect(evidenceTransitions).toEqual(["retry-once:2", "exhausted:5"]);
    expect(dirtyCases).toEqual(new Set());
  }),
);
