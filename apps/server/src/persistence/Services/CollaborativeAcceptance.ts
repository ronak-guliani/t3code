import {
  CollaborativeAcceptanceAssessment,
  CollaborativeAcceptanceCase,
  CollaborativeAcceptanceCandidate,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceEvidence,
  CollaborativeAcceptanceExchange,
  CollaborativeAcceptanceProjection,
  CollaborativeAcceptanceRecord,
} from "@t3tools/contracts";
import { Context, Effect, Option, Schema } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface CollaborativeAcceptanceRepositoryShape {
  readonly save: (
    record: CollaborativeAcceptanceRecord,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByCaseId: (input: {
    readonly caseId: CollaborativeAcceptanceCaseId;
  }) => Effect.Effect<Option.Option<CollaborativeAcceptanceRecord>, ProjectionRepositoryError>;
  readonly listByAssignmentId: (input: {
    readonly assignmentId: string;
  }) => Effect.Effect<ReadonlyArray<CollaborativeAcceptanceRecord>, ProjectionRepositoryError>;
}

export class CollaborativeAcceptanceRepository extends Context.Service<
  CollaborativeAcceptanceRepository,
  CollaborativeAcceptanceRepositoryShape
>()("t3/persistence/Services/CollaborativeAcceptance/Repository") {}

export const CollaborativeAcceptanceCaseDbRow = Schema.Struct({
  case: Schema.fromJsonString(CollaborativeAcceptanceCase),
  projection: Schema.fromJsonString(CollaborativeAcceptanceProjection),
});
export type CollaborativeAcceptanceCaseDbRow = typeof CollaborativeAcceptanceCaseDbRow.Type;

export const CollaborativeAcceptanceCandidateDbRow = Schema.fromJsonString(
  CollaborativeAcceptanceCandidate,
);
export const CollaborativeAcceptanceEvidenceDbRow = Schema.fromJsonString(
  CollaborativeAcceptanceEvidence,
);
export const CollaborativeAcceptanceAssessmentDbRow = Schema.fromJsonString(
  CollaborativeAcceptanceAssessment,
);
export const CollaborativeAcceptanceExchangeDbRow = Schema.fromJsonString(
  CollaborativeAcceptanceExchange,
);
