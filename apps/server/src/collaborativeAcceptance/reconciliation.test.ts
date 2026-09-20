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
