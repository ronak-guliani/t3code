import {
  PullRequestMonitorError,
  PullRequestMonitorId,
  type PullRequestMonitorActionableEvent,
  type PullRequestMonitorCanonicalKey,
  type PullRequestMonitorLifecycleStatus,
  type PullRequestMonitorReadiness,
  type PullRequestMonitorRecord,
  type PullRequestMonitorSnapshot,
  formatPullRequestMonitorCanonicalKey,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { emptyCursor, type PullRequestMonitorCursor } from "./monitorDiff.ts";
import { MAX_RETAINED_SNAPSHOTS } from "./pollSchedule.ts";

const decodeCursor = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      headSha: Schema.String,
      state: Schema.String,
      reviewStates: Schema.Record(Schema.String, Schema.String),
      threadVersions: Schema.Record(
        Schema.String,
        Schema.Struct({
          updatedAt: Schema.String,
          resolved: Schema.Boolean,
        }),
      ),
      issueCommentVersions: Schema.Record(Schema.String, Schema.String),
      checkRuns: Schema.Record(
        Schema.String,
        Schema.Struct({
          runId: Schema.String,
          outcome: Schema.Literals(["success", "failure", "pending"]),
        }),
      ),
      behindBase: Schema.Boolean,
      sourceRevision: Schema.String,
    }),
  ),
);

const decodeReadiness = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ready: Schema.Boolean,
      label: Schema.Literals(["ready-to-merge", "no-known-blockers", "blocked"]),
      blockers: Schema.Array(
        Schema.Struct({
          kind: Schema.String,
          detail: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

const decodeSnapshotJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEventsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

interface MonitorRow {
  readonly monitor_id: string;
  readonly canonical_key: string;
  readonly provider: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly project_id: string;
  readonly owner_thread_id: string | null;
  readonly linked_review_thread_id: string | null;
  readonly status: string;
  readonly enabled: number;
  readonly readiness_json: string | null;
  readonly head_sha: string | null;
  readonly source_revision: string | null;
  readonly cursor_json: string | null;
  readonly last_polled_at: string | null;
  readonly next_poll_at: string | null;
  readonly last_error: string | null;
  readonly poll_failure_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly stopped_at: string | null;
}

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly monitor_id: string;
  readonly source_revision: string;
  readonly head_sha: string;
  readonly fetched_at: string;
  readonly snapshot_json: string;
  readonly readiness_json: string;
  readonly events_json: string;
}

function storeError(message: string, cause?: unknown) {
  return new PullRequestMonitorError({ message, cause });
}

function rowToRecord(
  row: MonitorRow,
): Effect.Effect<PullRequestMonitorRecord, PullRequestMonitorError> {
  return Effect.gen(function* () {
    let readiness: PullRequestMonitorReadiness | null = null;
    if (row.readiness_json) {
      const decoded = yield* decodeReadiness(row.readiness_json).pipe(
        Effect.mapError((cause) => storeError("Could not decode monitor readiness.", cause)),
      );
      readiness = decoded as PullRequestMonitorReadiness;
    }
    return {
      id: PullRequestMonitorId.make(row.monitor_id),
      canonicalKey: row.canonical_key,
      provider: row.provider as PullRequestMonitorRecord["provider"],
      host: row.host,
      repository: row.repository,
      number: row.number,
      projectId: row.project_id as PullRequestMonitorRecord["projectId"],
      ownerThreadId: row.owner_thread_id as PullRequestMonitorRecord["ownerThreadId"],
      linkedReviewThreadId: (row.linked_review_thread_id ??
        null) as PullRequestMonitorRecord["linkedReviewThreadId"],
      status: row.status as PullRequestMonitorLifecycleStatus,
      enabled: row.enabled === 1,
      readiness,
      headSha: row.head_sha,
      sourceRevision: row.source_revision,
      lastPolledAt: row.last_polled_at,
      nextPollAt: row.next_poll_at,
      lastError: row.last_error,
      pollFailureCount: row.poll_failure_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stoppedAt: row.stopped_at,
    } satisfies PullRequestMonitorRecord;
  });
}

export interface PullRequestMonitorStoreApi {
  readonly canonicalKey: (key: PullRequestMonitorCanonicalKey) => string;
  readonly getById: (
    id: PullRequestMonitorId,
  ) => Effect.Effect<PullRequestMonitorRecord | null, PullRequestMonitorError>;
  readonly getByCanonicalKey: (
    canonicalKey: string,
  ) => Effect.Effect<PullRequestMonitorRecord | null, PullRequestMonitorError>;
  readonly getByProjectRef: (input: {
    readonly projectId: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<PullRequestMonitorRecord | null, PullRequestMonitorError>;
  readonly list: (input: {
    readonly projectId?: string;
    readonly enabledOnly?: boolean;
  }) => Effect.Effect<ReadonlyArray<PullRequestMonitorRecord>, PullRequestMonitorError>;
  readonly listDue: (
    nowIso: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PullRequestMonitorRecord>, PullRequestMonitorError>;
  readonly insert: (
    record: PullRequestMonitorRecord,
    cursor: PullRequestMonitorCursor,
  ) => Effect.Effect<void, PullRequestMonitorError>;
  readonly update: (
    record: PullRequestMonitorRecord,
    cursor?: PullRequestMonitorCursor,
  ) => Effect.Effect<void, PullRequestMonitorError>;
  /** Poll/lifecycle fields only — never rewrites ownership. */
  readonly updatePollState: (
    record: PullRequestMonitorRecord,
    cursor?: PullRequestMonitorCursor,
  ) => Effect.Effect<void, PullRequestMonitorError>;
  readonly scheduleRecheck: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly nextPollAt: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly getCursor: (
    id: PullRequestMonitorId,
  ) => Effect.Effect<PullRequestMonitorCursor, PullRequestMonitorError>;
  readonly saveSnapshot: (input: {
    readonly snapshotId: string;
    readonly monitorId: PullRequestMonitorId;
    readonly snapshot: PullRequestMonitorSnapshot;
    readonly readiness: PullRequestMonitorReadiness;
    readonly events: ReadonlyArray<PullRequestMonitorActionableEvent>;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly latestSnapshot: (monitorId: PullRequestMonitorId) => Effect.Effect<
    {
      readonly snapshot: PullRequestMonitorSnapshot;
      readonly events: ReadonlyArray<PullRequestMonitorActionableEvent>;
    } | null,
    PullRequestMonitorError
  >;
  readonly tryAcquireLease: (input: {
    readonly canonicalKey: string;
    readonly ownerId: string;
    readonly nowIso: string;
    readonly expiresAt: string;
  }) => Effect.Effect<boolean, PullRequestMonitorError>;
  readonly releaseLease: (
    canonicalKey: string,
    ownerId: string,
  ) => Effect.Effect<void, PullRequestMonitorError>;
  readonly getHostCooldownUntil: (
    hostKey: string,
    nowIso: string,
  ) => Effect.Effect<string | null, PullRequestMonitorError>;
  readonly setHostCooldown: (input: {
    readonly hostKey: string;
    readonly cooldownUntil: string;
    readonly reason: string;
    readonly nowIso: string;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly recordOwnershipEvent: (input: {
    readonly eventId: string;
    readonly monitorId: PullRequestMonitorId;
    readonly fromThreadId: string | null;
    readonly toThreadId: string | null;
    readonly reason: string;
    readonly createdAt: string;
  }) => Effect.Effect<void, PullRequestMonitorError>;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getById: PullRequestMonitorStoreApi["getById"] = (id) =>
    sql<MonitorRow>`
      SELECT * FROM pull_request_monitors WHERE monitor_id = ${id}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : rowToRecord(rows[0]),
      ),
      Effect.mapError((cause) =>
        cause instanceof PullRequestMonitorError
          ? cause
          : storeError("Failed to load monitor.", cause),
      ),
    );

  const getByCanonicalKey: PullRequestMonitorStoreApi["getByCanonicalKey"] = (canonicalKey) =>
    sql<MonitorRow>`
      SELECT * FROM pull_request_monitors WHERE canonical_key = ${canonicalKey}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : rowToRecord(rows[0]),
      ),
      Effect.mapError((cause) =>
        cause instanceof PullRequestMonitorError
          ? cause
          : storeError("Failed to load monitor by key.", cause),
      ),
    );

  const getByProjectRef: PullRequestMonitorStoreApi["getByProjectRef"] = (input) =>
    sql<MonitorRow>`
      SELECT * FROM pull_request_monitors
      WHERE project_id = ${input.projectId}
        AND repository = ${input.repository}
        AND number = ${input.number}
      ORDER BY updated_at DESC
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : rowToRecord(rows[0]),
      ),
      Effect.mapError((cause) =>
        cause instanceof PullRequestMonitorError
          ? cause
          : storeError("Failed to load monitor by project ref.", cause),
      ),
    );

  const list: PullRequestMonitorStoreApi["list"] = (input) =>
    Effect.gen(function* () {
      const rows =
        input.projectId !== undefined && input.enabledOnly
          ? yield* sql<MonitorRow>`
              SELECT * FROM pull_request_monitors
              WHERE project_id = ${input.projectId} AND enabled = 1
              ORDER BY updated_at DESC
            `
          : input.projectId !== undefined
            ? yield* sql<MonitorRow>`
                SELECT * FROM pull_request_monitors
                WHERE project_id = ${input.projectId}
                ORDER BY updated_at DESC
              `
            : input.enabledOnly
              ? yield* sql<MonitorRow>`
                  SELECT * FROM pull_request_monitors
                  WHERE enabled = 1
                  ORDER BY updated_at DESC
                `
              : yield* sql<MonitorRow>`
                  SELECT * FROM pull_request_monitors
                  ORDER BY updated_at DESC
                `;
      return yield* Effect.forEach(rows, rowToRecord, { concurrency: 1 });
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof PullRequestMonitorError
          ? cause
          : storeError("Failed to list monitors.", cause),
      ),
    );

  const listDue: PullRequestMonitorStoreApi["listDue"] = (nowIso, limit) =>
    sql<MonitorRow>`
      SELECT * FROM pull_request_monitors
      WHERE enabled = 1
        AND next_poll_at IS NOT NULL
        AND next_poll_at <= ${nowIso}
      ORDER BY next_poll_at ASC
      LIMIT ${limit}
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, rowToRecord, { concurrency: 1 })),
      Effect.mapError((cause) =>
        cause instanceof PullRequestMonitorError
          ? cause
          : storeError("Failed to list due monitors.", cause),
      ),
    );

  const insert: PullRequestMonitorStoreApi["insert"] = (record, cursor) =>
    sql`
      INSERT INTO pull_request_monitors (
        monitor_id, canonical_key, provider, host, repository, number, project_id,
        owner_thread_id, linked_review_thread_id, status, enabled, readiness_json, head_sha, source_revision,
        cursor_json, last_polled_at, next_poll_at, last_error, poll_failure_count,
        created_at, updated_at, stopped_at
      ) VALUES (
        ${record.id},
        ${record.canonicalKey},
        ${record.provider},
        ${record.host},
        ${record.repository},
        ${record.number},
        ${record.projectId},
        ${record.ownerThreadId},
        ${record.linkedReviewThreadId},
        ${record.status},
        ${record.enabled ? 1 : 0},
        ${record.readiness ? JSON.stringify(record.readiness) : null},
        ${record.headSha},
        ${record.sourceRevision},
        ${JSON.stringify(cursor)},
        ${record.lastPolledAt},
        ${record.nextPollAt},
        ${record.lastError},
        ${record.pollFailureCount},
        ${record.createdAt},
        ${record.updatedAt},
        ${record.stoppedAt}
      )
    `.pipe(
      Effect.mapError((cause) => storeError("Failed to insert monitor.", cause)),
      Effect.asVoid,
    );

  const update: PullRequestMonitorStoreApi["update"] = (record, cursor) =>
    (cursor
      ? sql`
          UPDATE pull_request_monitors SET
            owner_thread_id = ${record.ownerThreadId},
            linked_review_thread_id = ${record.linkedReviewThreadId},
            status = ${record.status},
            enabled = ${record.enabled ? 1 : 0},
            readiness_json = ${record.readiness ? JSON.stringify(record.readiness) : null},
            head_sha = ${record.headSha},
            source_revision = ${record.sourceRevision},
            cursor_json = ${JSON.stringify(cursor)},
            last_polled_at = ${record.lastPolledAt},
            next_poll_at = ${record.nextPollAt},
            last_error = ${record.lastError},
            poll_failure_count = ${record.pollFailureCount},
            updated_at = ${record.updatedAt},
            stopped_at = ${record.stoppedAt}
          WHERE monitor_id = ${record.id}
        `
      : sql`
          UPDATE pull_request_monitors SET
            owner_thread_id = ${record.ownerThreadId},
            linked_review_thread_id = ${record.linkedReviewThreadId},
            status = ${record.status},
            enabled = ${record.enabled ? 1 : 0},
            readiness_json = ${record.readiness ? JSON.stringify(record.readiness) : null},
            head_sha = ${record.headSha},
            source_revision = ${record.sourceRevision},
            last_polled_at = ${record.lastPolledAt},
            next_poll_at = ${record.nextPollAt},
            last_error = ${record.lastError},
            poll_failure_count = ${record.pollFailureCount},
            updated_at = ${record.updatedAt},
            stopped_at = ${record.stoppedAt}
          WHERE monitor_id = ${record.id}
        `
    ).pipe(
      Effect.mapError((cause) => storeError("Failed to update monitor.", cause)),
      Effect.asVoid,
    );

  const updatePollState: PullRequestMonitorStoreApi["updatePollState"] = (record, cursor) =>
    (cursor
      ? sql`
          UPDATE pull_request_monitors SET
            status = ${record.status},
            enabled = ${record.enabled ? 1 : 0},
            readiness_json = ${record.readiness ? JSON.stringify(record.readiness) : null},
            head_sha = ${record.headSha},
            source_revision = ${record.sourceRevision},
            cursor_json = ${JSON.stringify(cursor)},
            last_polled_at = ${record.lastPolledAt},
            next_poll_at = ${record.nextPollAt},
            last_error = ${record.lastError},
            poll_failure_count = ${record.pollFailureCount},
            updated_at = ${record.updatedAt},
            stopped_at = ${record.stoppedAt}
          WHERE monitor_id = ${record.id}
        `
      : sql`
          UPDATE pull_request_monitors SET
            status = ${record.status},
            enabled = ${record.enabled ? 1 : 0},
            readiness_json = ${record.readiness ? JSON.stringify(record.readiness) : null},
            head_sha = ${record.headSha},
            source_revision = ${record.sourceRevision},
            last_polled_at = ${record.lastPolledAt},
            next_poll_at = ${record.nextPollAt},
            last_error = ${record.lastError},
            poll_failure_count = ${record.pollFailureCount},
            updated_at = ${record.updatedAt},
            stopped_at = ${record.stoppedAt}
          WHERE monitor_id = ${record.id}
        `
    ).pipe(
      Effect.mapError((cause) => storeError("Failed to update monitor poll state.", cause)),
      Effect.asVoid,
    );

  const scheduleRecheck: PullRequestMonitorStoreApi["scheduleRecheck"] = (input) =>
    sql`
      UPDATE pull_request_monitors SET
        next_poll_at = ${input.nextPollAt},
        updated_at = ${input.updatedAt}
      WHERE monitor_id = ${input.monitorId}
    `.pipe(
      Effect.mapError((cause) => storeError("Failed to schedule monitor recheck.", cause)),
      Effect.asVoid,
    );

  const getCursor: PullRequestMonitorStoreApi["getCursor"] = (id) =>
    sql<{ cursor_json: string | null }>`
      SELECT cursor_json FROM pull_request_monitors WHERE monitor_id = ${id}
    `.pipe(
      Effect.flatMap((rows) => {
        const raw = rows[0]?.cursor_json;
        if (!raw) return Effect.succeed(emptyCursor());
        return decodeCursor(raw).pipe(
          Effect.map((cursor) => cursor as PullRequestMonitorCursor),
          Effect.mapError((cause) => storeError("Could not decode monitor cursor.", cause)),
        );
      }),
      Effect.mapError((cause) =>
        cause instanceof PullRequestMonitorError
          ? cause
          : storeError("Failed to load monitor cursor.", cause),
      ),
    );

  const saveSnapshot: PullRequestMonitorStoreApi["saveSnapshot"] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO pull_request_monitor_snapshots (
          snapshot_id, monitor_id, source_revision, head_sha, fetched_at,
          snapshot_json, readiness_json, events_json
        ) VALUES (
          ${input.snapshotId},
          ${input.monitorId},
          ${input.snapshot.sourceRevision},
          ${input.snapshot.headSha},
          ${input.snapshot.fetchedAt},
          ${JSON.stringify(input.snapshot)},
          ${JSON.stringify(input.readiness)},
          ${JSON.stringify(input.events)}
        )
      `;
      yield* sql`
        DELETE FROM pull_request_monitor_snapshots
        WHERE monitor_id = ${input.monitorId}
          AND snapshot_id NOT IN (
            SELECT snapshot_id FROM pull_request_monitor_snapshots
            WHERE monitor_id = ${input.monitorId}
            ORDER BY fetched_at DESC
            LIMIT ${MAX_RETAINED_SNAPSHOTS}
          )
      `;
    }).pipe(
      Effect.mapError((cause) => storeError("Failed to save monitor snapshot.", cause)),
      Effect.asVoid,
    );

  const latestSnapshot: PullRequestMonitorStoreApi["latestSnapshot"] = (monitorId) =>
    sql<SnapshotRow>`
      SELECT * FROM pull_request_monitor_snapshots
      WHERE monitor_id = ${monitorId}
      ORDER BY fetched_at DESC
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (!row) return Effect.succeed(null);
        return Effect.gen(function* () {
          const snapshot = (yield* decodeSnapshotJson(
            row.snapshot_json,
          )) as PullRequestMonitorSnapshot;
          const events = (yield* decodeEventsJson(
            row.events_json,
          )) as ReadonlyArray<PullRequestMonitorActionableEvent>;
          return { snapshot, events };
        }).pipe(Effect.mapError((cause) => storeError("Could not decode snapshot.", cause)));
      }),
      Effect.mapError((cause) =>
        cause instanceof PullRequestMonitorError
          ? cause
          : storeError("Failed to load latest snapshot.", cause),
      ),
    );

  const tryAcquireLease: PullRequestMonitorStoreApi["tryAcquireLease"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* sql<{
        owner_id: string;
        generation: number;
        expires_at: string;
      }>`
        SELECT owner_id, generation, expires_at
        FROM pull_request_monitor_leases
        WHERE canonical_key = ${input.canonicalKey}
      `;
      const row = existing[0];
      if (row && row.expires_at > input.nowIso && row.owner_id !== input.ownerId) {
        return false;
      }
      const generation = (row?.generation ?? 0) + 1;
      yield* sql`
        INSERT INTO pull_request_monitor_leases (
          canonical_key, owner_id, generation, acquired_at, expires_at
        ) VALUES (
          ${input.canonicalKey}, ${input.ownerId}, ${generation}, ${input.nowIso}, ${input.expiresAt}
        )
        ON CONFLICT(canonical_key) DO UPDATE SET
          owner_id = excluded.owner_id,
          generation = excluded.generation,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
        WHERE pull_request_monitor_leases.expires_at <= ${input.nowIso}
           OR pull_request_monitor_leases.owner_id = ${input.ownerId}
      `;
      const confirm = yield* sql<{ owner_id: string }>`
        SELECT owner_id FROM pull_request_monitor_leases
        WHERE canonical_key = ${input.canonicalKey}
      `;
      return confirm[0]?.owner_id === input.ownerId;
    }).pipe(Effect.mapError((cause) => storeError("Failed to acquire monitor lease.", cause)));

  const releaseLease: PullRequestMonitorStoreApi["releaseLease"] = (canonicalKey, ownerId) =>
    sql`
      DELETE FROM pull_request_monitor_leases
      WHERE canonical_key = ${canonicalKey} AND owner_id = ${ownerId}
    `.pipe(
      Effect.mapError((cause) => storeError("Failed to release lease.", cause)),
      Effect.asVoid,
    );

  const getHostCooldownUntil: PullRequestMonitorStoreApi["getHostCooldownUntil"] = (
    hostKey,
    nowIso,
  ) =>
    sql<{ cooldown_until: string }>`
      SELECT cooldown_until FROM pull_request_monitor_host_cooldowns
      WHERE host_key = ${hostKey} AND cooldown_until > ${nowIso}
    `.pipe(
      Effect.map((rows) => rows[0]?.cooldown_until ?? null),
      Effect.mapError((cause) => storeError("Failed to read host cooldown.", cause)),
    );

  const setHostCooldown: PullRequestMonitorStoreApi["setHostCooldown"] = (input) =>
    sql`
      INSERT INTO pull_request_monitor_host_cooldowns (
        host_key, cooldown_until, reason, updated_at
      ) VALUES (
        ${input.hostKey}, ${input.cooldownUntil}, ${input.reason}, ${input.nowIso}
      )
      ON CONFLICT(host_key) DO UPDATE SET
        cooldown_until = excluded.cooldown_until,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.mapError((cause) => storeError("Failed to set host cooldown.", cause)),
      Effect.asVoid,
    );

  const recordOwnershipEvent: PullRequestMonitorStoreApi["recordOwnershipEvent"] = (input) =>
    sql`
      INSERT INTO pull_request_monitor_ownership_events (
        event_id, monitor_id, from_thread_id, to_thread_id, reason, created_at
      ) VALUES (
        ${input.eventId},
        ${input.monitorId},
        ${input.fromThreadId},
        ${input.toThreadId},
        ${input.reason},
        ${input.createdAt}
      )
    `.pipe(
      Effect.mapError((cause) => storeError("Failed to record ownership event.", cause)),
      Effect.asVoid,
    );

  return {
    canonicalKey: formatPullRequestMonitorCanonicalKey,
    getById,
    getByCanonicalKey,
    getByProjectRef,
    list,
    listDue,
    insert,
    update,
    updatePollState,
    scheduleRecheck,
    getCursor,
    saveSnapshot,
    latestSnapshot,
    tryAcquireLease,
    releaseLease,
    getHostCooldownUntil,
    setHostCooldown,
    recordOwnershipEvent,
  } satisfies PullRequestMonitorStoreApi;
});

export const PullRequestMonitorStore = { make };
