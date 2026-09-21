import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaborative_acceptance_cases (
      case_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      contract_revision TEXT NOT NULL,
      current_candidate_id TEXT NOT NULL,
      current_head_sha TEXT NOT NULL,
      case_json TEXT NOT NULL,
      projection_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_collaborative_acceptance_cases_assignment
    ON collaborative_acceptance_cases(assignment_id, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaborative_acceptance_candidates (
      candidate_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      review_epoch INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (case_id, review_epoch),
      FOREIGN KEY (case_id) REFERENCES collaborative_acceptance_cases(case_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_collaborative_acceptance_candidates_case
    ON collaborative_acceptance_candidates(case_id, review_epoch)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaborative_acceptance_evidence (
      evidence_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      complete INTEGER NOT NULL,
      current INTEGER NOT NULL,
      evidence_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      FOREIGN KEY (case_id) REFERENCES collaborative_acceptance_cases(case_id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES collaborative_acceptance_candidates(candidate_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_collaborative_acceptance_evidence_candidate
    ON collaborative_acceptance_evidence(case_id, candidate_id, current, observed_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaborative_acceptance_assessments (
      assessment_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      outcome TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      review_epoch INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      contract_revision TEXT NOT NULL,
      assessment_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (case_id) REFERENCES collaborative_acceptance_cases(case_id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES collaborative_acceptance_candidates(candidate_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_collaborative_acceptance_assessments_candidate
    ON collaborative_acceptance_assessments(case_id, candidate_id, role, created_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaborative_acceptance_exchanges (
      exchange_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      status TEXT NOT NULL,
      retry_count INTEGER NOT NULL,
      reserved_at TEXT NOT NULL,
      started_at TEXT,
      outcome_recorded_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      model_spend_cents INTEGER NOT NULL,
      exchange_json TEXT NOT NULL,
      FOREIGN KEY (case_id) REFERENCES collaborative_acceptance_cases(case_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_collaborative_acceptance_exchanges_case
    ON collaborative_acceptance_exchanges(case_id, status, reserved_at)
  `;
});
