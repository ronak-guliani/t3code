import {
  PullRequestMonitorError,
  type PullRequestMonitorActionableEventKind,
  type PullRequestMonitorFeedbackDelivery,
  type PullRequestMonitorFeedbackDeliveryId,
  type PullRequestMonitorFeedbackDeliveryStatus,
  type PullRequestMonitorFeedbackDisposition,
  type PullRequestMonitorFeedbackItem,
  type PullRequestMonitorFeedbackItemId,
  type PullRequestMonitorFeedbackReport,
  type PullRequestMonitorFeedbackRevision,
  type PullRequestMonitorFeedbackRevisionId,
  type PullRequestMonitorId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeStringArray = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

function storeError(message: string, cause?: unknown) {
  return new PullRequestMonitorError({ message, cause });
}

interface ItemRow {
  readonly item_id: string;
  readonly monitor_id: string;
  readonly stable_key: string;
  readonly kind: string;
  readonly status: string;
  readonly disposition: string | null;
  readonly disposition_note: string | null;
  readonly disposition_at: string | null;
  readonly disposition_by_thread_id: string | null;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly current_revision_id: string | null;
  readonly summary: string | null;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly monitor_id: string;
  readonly batch_key: string;
  readonly target_thread_id: string;
  readonly command_id: string;
  readonly message_id: string;
  readonly revision_ids_json: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly last_error: string | null;
  readonly next_attempt_at: string | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
  readonly receipt_json: string | null;
}

interface ReportRow {
  readonly report_id: string;
  readonly monitor_id: string;
  readonly item_id: string;
  readonly disposition: string;
  readonly note: string | null;
  readonly reporter_thread_id: string | null;
  readonly created_at: string;
}

interface StateRow {
  readonly monitor_id: string;
  readonly pending_revision_ids_json: string;
  readonly debounce_until: string | null;
  readonly delivery_failure_count: number;
  readonly circuit_open_until: string | null;
  readonly updated_at: string;
}

export interface FeedbackMonitorState {
  readonly monitorId: PullRequestMonitorId;
  readonly pendingRevisionIds: ReadonlyArray<string>;
  readonly debounceUntil: string | null;
  readonly deliveryFailureCount: number;
  readonly circuitOpenUntil: string | null;
  readonly updatedAt: string;
}

function rowToItem(row: ItemRow): PullRequestMonitorFeedbackItem {
  return {
    id: row.item_id as PullRequestMonitorFeedbackItemId,
    monitorId: row.monitor_id as PullRequestMonitorId,
    stableKey: row.stable_key,
    kind: row.kind as PullRequestMonitorActionableEventKind,
    status: row.status as PullRequestMonitorFeedbackItem["status"],
    disposition: row.disposition as PullRequestMonitorFeedbackDisposition | null,
    dispositionNote: row.disposition_note,
    dispositionAt: row.disposition_at,
    dispositionByThreadId: row.disposition_by_thread_id as ThreadId | null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    currentRevisionId: row.current_revision_id as PullRequestMonitorFeedbackRevisionId | null,
    summary: (row.summary ?? "").slice(0, 500),
  };
}

function rowToDelivery(
  row: DeliveryRow,
): Effect.Effect<PullRequestMonitorFeedbackDelivery, PullRequestMonitorError> {
  return Effect.gen(function* () {
    const revisionIds = yield* decodeStringArray(row.revision_ids_json).pipe(
      Effect.mapError((cause) => storeError("Could not decode delivery revision ids.", cause)),
    );
    return {
      id: row.delivery_id as PullRequestMonitorFeedbackDeliveryId,
      monitorId: row.monitor_id as PullRequestMonitorId,
      batchKey: row.batch_key,
      targetThreadId: row.target_thread_id as ThreadId,
      commandId: row.command_id,
      messageId: row.message_id,
      revisionIds: revisionIds as ReadonlyArray<PullRequestMonitorFeedbackRevisionId>,
      status: row.status as PullRequestMonitorFeedbackDeliveryStatus,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
    };
  });
}

function rowToReport(row: ReportRow): PullRequestMonitorFeedbackReport {
  return {
    id: row.report_id,
    monitorId: row.monitor_id as PullRequestMonitorId,
    itemId: row.item_id as PullRequestMonitorFeedbackItemId,
    disposition: row.disposition as PullRequestMonitorFeedbackDisposition,
    note: row.note,
    reporterThreadId: row.reporter_thread_id as ThreadId | null,
    createdAt: row.created_at,
  };
}

export interface PullRequestMonitorFeedbackStoreApi {
  readonly upsertOpenItem: (input: {
    readonly item: Omit<PullRequestMonitorFeedbackItem, "summary" | "currentRevisionId"> & {
      readonly currentRevisionId: PullRequestMonitorFeedbackRevisionId | null;
      readonly summary: string;
    };
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly insertRevision: (
    revision: Omit<PullRequestMonitorFeedbackRevision, "payload"> & { readonly payload: unknown },
  ) => Effect.Effect<void, PullRequestMonitorError>;
  readonly getItem: (
    itemId: PullRequestMonitorFeedbackItemId,
  ) => Effect.Effect<PullRequestMonitorFeedbackItem | null, PullRequestMonitorError>;
  readonly listItems: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly includeClosed?: boolean;
  }) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackItem>, PullRequestMonitorError>;
  readonly setDisposition: (input: {
    readonly itemId: PullRequestMonitorFeedbackItemId;
    readonly disposition: PullRequestMonitorFeedbackDisposition;
    readonly note: string | null;
    readonly at: string;
    readonly byThreadId: ThreadId | null;
    readonly status: "open" | "closed";
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly insertReport: (
    report: PullRequestMonitorFeedbackReport,
  ) => Effect.Effect<void, PullRequestMonitorError>;
  readonly listReports: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackReport>, PullRequestMonitorError>;
  readonly getState: (
    monitorId: PullRequestMonitorId,
  ) => Effect.Effect<FeedbackMonitorState, PullRequestMonitorError>;
  readonly saveState: (state: FeedbackMonitorState) => Effect.Effect<void, PullRequestMonitorError>;
  readonly insertDelivery: (
    delivery: PullRequestMonitorFeedbackDelivery & {
      readonly nextAttemptAt: string | null;
      readonly receiptJson: string | null;
    },
  ) => Effect.Effect<void, PullRequestMonitorError>;
  readonly updateDelivery: (
    delivery: PullRequestMonitorFeedbackDelivery & {
      readonly nextAttemptAt: string | null;
      readonly receiptJson: string | null;
    },
  ) => Effect.Effect<void, PullRequestMonitorError>;
  readonly getDeliveryByBatchKey: (
    batchKey: string,
  ) => Effect.Effect<PullRequestMonitorFeedbackDelivery | null, PullRequestMonitorError>;
  readonly listDeliveries: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackDelivery>, PullRequestMonitorError>;
  readonly listDueDeliveries: (
    nowIso: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackDelivery>, PullRequestMonitorError>;
  readonly nextRevisionNumber: (
    itemId: PullRequestMonitorFeedbackItemId,
  ) => Effect.Effect<number, PullRequestMonitorError>;
}

export const PullRequestMonitorFeedbackStore = {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const getItem: PullRequestMonitorFeedbackStoreApi["getItem"] = (itemId) =>
      sql<ItemRow>`
        SELECT i.*, (
          SELECT r.summary FROM pull_request_monitor_feedback_revisions r
          WHERE r.revision_id = i.current_revision_id
        ) AS summary
        FROM pull_request_monitor_feedback_items i
        WHERE i.item_id = ${itemId}
        LIMIT 1
      `.pipe(
        Effect.map((rows) => (rows[0] ? rowToItem(rows[0]) : null)),
        Effect.mapError((cause) => storeError("Failed to load feedback item.", cause)),
      );

    const listItems: PullRequestMonitorFeedbackStoreApi["listItems"] = (input) =>
      Effect.gen(function* () {
        const rows = input.includeClosed
          ? yield* sql<ItemRow>`
              SELECT i.*, (
                SELECT r.summary FROM pull_request_monitor_feedback_revisions r
                WHERE r.revision_id = i.current_revision_id
              ) AS summary
              FROM pull_request_monitor_feedback_items i
              WHERE i.monitor_id = ${input.monitorId}
              ORDER BY i.last_seen_at DESC
            `
          : yield* sql<ItemRow>`
              SELECT i.*, (
                SELECT r.summary FROM pull_request_monitor_feedback_revisions r
                WHERE r.revision_id = i.current_revision_id
              ) AS summary
              FROM pull_request_monitor_feedback_items i
              WHERE i.monitor_id = ${input.monitorId} AND i.status = 'open'
              ORDER BY i.last_seen_at DESC
            `;
        return rows.map(rowToItem);
      }).pipe(Effect.mapError((cause) => storeError("Failed to list feedback items.", cause)));

    const upsertOpenItem: PullRequestMonitorFeedbackStoreApi["upsertOpenItem"] = ({ item }) =>
      sql`
        INSERT INTO pull_request_monitor_feedback_items (
          item_id, monitor_id, stable_key, kind, status, disposition, disposition_note,
          disposition_at, disposition_by_thread_id, first_seen_at, last_seen_at, current_revision_id
        ) VALUES (
          ${item.id}, ${item.monitorId}, ${item.stableKey}, ${item.kind}, ${item.status},
          ${item.disposition}, ${item.dispositionNote}, ${item.dispositionAt},
          ${item.dispositionByThreadId}, ${item.firstSeenAt}, ${item.lastSeenAt},
          ${item.currentRevisionId}
        )
        ON CONFLICT(monitor_id, stable_key) DO UPDATE SET
          kind = excluded.kind,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          current_revision_id = COALESCE(excluded.current_revision_id, pull_request_monitor_feedback_items.current_revision_id)
      `.pipe(
        Effect.mapError((cause) => storeError("Failed to upsert feedback item.", cause)),
        Effect.asVoid,
      );

    const insertRevision: PullRequestMonitorFeedbackStoreApi["insertRevision"] = (revision) =>
      sql`
        INSERT INTO pull_request_monitor_feedback_revisions (
          revision_id, item_id, revision_number, payload_json, source_revision, head_sha, created_at, summary
        ) VALUES (
          ${revision.id}, ${revision.itemId}, ${revision.revisionNumber},
          ${JSON.stringify(revision.payload)}, ${revision.sourceRevision}, ${revision.headSha},
          ${revision.createdAt}, ${revision.summary}
        )
      `
        .pipe(
          Effect.mapError((cause) => storeError("Failed to insert feedback revision.", cause)),
          Effect.asVoid,
        )
        .pipe(
          Effect.andThen(
            sql`
            UPDATE pull_request_monitor_feedback_items
            SET current_revision_id = ${revision.id}, last_seen_at = ${revision.createdAt}
            WHERE item_id = ${revision.itemId}
          `.pipe(Effect.asVoid),
          ),
          Effect.mapError((cause) => storeError("Failed to attach feedback revision.", cause)),
        );

    const setDisposition: PullRequestMonitorFeedbackStoreApi["setDisposition"] = (input) =>
      sql`
        UPDATE pull_request_monitor_feedback_items
        SET disposition = ${input.disposition},
            disposition_note = ${input.note},
            disposition_at = ${input.at},
            disposition_by_thread_id = ${input.byThreadId},
            status = ${input.status}
        WHERE item_id = ${input.itemId}
      `.pipe(
        Effect.mapError((cause) => storeError("Failed to set feedback disposition.", cause)),
        Effect.asVoid,
      );

    const insertReport: PullRequestMonitorFeedbackStoreApi["insertReport"] = (report) =>
      sql`
        INSERT INTO pull_request_monitor_feedback_reports (
          report_id, monitor_id, item_id, disposition, note, reporter_thread_id, created_at, recheck_requested
        ) VALUES (
          ${report.id}, ${report.monitorId}, ${report.itemId}, ${report.disposition},
          ${report.note}, ${report.reporterThreadId}, ${report.createdAt}, 1
        )
      `.pipe(
        Effect.mapError((cause) => storeError("Failed to insert feedback report.", cause)),
        Effect.asVoid,
      );

    const listReports: PullRequestMonitorFeedbackStoreApi["listReports"] = (input) =>
      sql<ReportRow>`
        SELECT * FROM pull_request_monitor_feedback_reports
        WHERE monitor_id = ${input.monitorId}
        ORDER BY created_at DESC
        LIMIT ${input.limit ?? 20}
      `.pipe(
        Effect.map((rows) => rows.map(rowToReport)),
        Effect.mapError((cause) => storeError("Failed to list feedback reports.", cause)),
      );

    const getState: PullRequestMonitorFeedbackStoreApi["getState"] = (monitorId) =>
      Effect.gen(function* () {
        const rows = yield* sql<StateRow>`
          SELECT * FROM pull_request_monitor_feedback_state WHERE monitor_id = ${monitorId} LIMIT 1
        `;
        const row = rows[0];
        if (!row) {
          return {
            monitorId,
            pendingRevisionIds: [],
            debounceUntil: null,
            deliveryFailureCount: 0,
            circuitOpenUntil: null,
            updatedAt: new Date(0).toISOString(),
          } satisfies FeedbackMonitorState;
        }
        const pending = yield* decodeStringArray(row.pending_revision_ids_json).pipe(
          Effect.mapError((cause) => storeError("Could not decode pending revisions.", cause)),
        );
        return {
          monitorId,
          pendingRevisionIds: pending,
          debounceUntil: row.debounce_until,
          deliveryFailureCount: row.delivery_failure_count,
          circuitOpenUntil: row.circuit_open_until,
          updatedAt: row.updated_at,
        } satisfies FeedbackMonitorState;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof PullRequestMonitorError
            ? cause
            : storeError("Failed to load feedback state.", cause),
        ),
      );

    const saveState: PullRequestMonitorFeedbackStoreApi["saveState"] = (state) =>
      sql`
        INSERT INTO pull_request_monitor_feedback_state (
          monitor_id, pending_revision_ids_json, debounce_until, delivery_failure_count,
          circuit_open_until, updated_at
        ) VALUES (
          ${state.monitorId}, ${JSON.stringify(state.pendingRevisionIds)}, ${state.debounceUntil},
          ${state.deliveryFailureCount}, ${state.circuitOpenUntil}, ${state.updatedAt}
        )
        ON CONFLICT(monitor_id) DO UPDATE SET
          pending_revision_ids_json = excluded.pending_revision_ids_json,
          debounce_until = excluded.debounce_until,
          delivery_failure_count = excluded.delivery_failure_count,
          circuit_open_until = excluded.circuit_open_until,
          updated_at = excluded.updated_at
      `.pipe(
        Effect.mapError((cause) => storeError("Failed to save feedback state.", cause)),
        Effect.asVoid,
      );

    const insertDelivery: PullRequestMonitorFeedbackStoreApi["insertDelivery"] = (delivery) =>
      sql`
        INSERT INTO pull_request_monitor_feedback_deliveries (
          delivery_id, monitor_id, batch_key, target_thread_id, command_id, message_id,
          revision_ids_json, status, attempt_count, last_error, next_attempt_at, created_at,
          delivered_at, receipt_json
        ) VALUES (
          ${delivery.id}, ${delivery.monitorId}, ${delivery.batchKey}, ${delivery.targetThreadId},
          ${delivery.commandId}, ${delivery.messageId}, ${JSON.stringify(delivery.revisionIds)},
          ${delivery.status}, ${delivery.attemptCount}, ${delivery.lastError}, ${delivery.nextAttemptAt},
          ${delivery.createdAt}, ${delivery.deliveredAt}, ${delivery.receiptJson}
        )
      `.pipe(
        Effect.mapError((cause) => storeError("Failed to insert delivery.", cause)),
        Effect.asVoid,
      );

    const updateDelivery: PullRequestMonitorFeedbackStoreApi["updateDelivery"] = (delivery) =>
      sql`
        UPDATE pull_request_monitor_feedback_deliveries
        SET status = ${delivery.status},
            attempt_count = ${delivery.attemptCount},
            last_error = ${delivery.lastError},
            next_attempt_at = ${delivery.nextAttemptAt},
            delivered_at = ${delivery.deliveredAt},
            receipt_json = ${delivery.receiptJson}
        WHERE delivery_id = ${delivery.id}
      `.pipe(
        Effect.mapError((cause) => storeError("Failed to update delivery.", cause)),
        Effect.asVoid,
      );

    const getDeliveryByBatchKey: PullRequestMonitorFeedbackStoreApi["getDeliveryByBatchKey"] = (
      batchKey,
    ) =>
      sql<DeliveryRow>`
        SELECT * FROM pull_request_monitor_feedback_deliveries WHERE batch_key = ${batchKey} LIMIT 1
      `.pipe(
        Effect.flatMap((rows) => (rows[0] ? rowToDelivery(rows[0]) : Effect.succeed(null))),
        Effect.mapError((cause) =>
          cause instanceof PullRequestMonitorError
            ? cause
            : storeError("Failed to load delivery by batch key.", cause),
        ),
      );

    const listDeliveries: PullRequestMonitorFeedbackStoreApi["listDeliveries"] = (input) =>
      sql<DeliveryRow>`
        SELECT * FROM pull_request_monitor_feedback_deliveries
        WHERE monitor_id = ${input.monitorId}
        ORDER BY created_at DESC
        LIMIT ${input.limit ?? 20}
      `.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, rowToDelivery)),
        Effect.mapError((cause) =>
          cause instanceof PullRequestMonitorError
            ? cause
            : storeError("Failed to list deliveries.", cause),
        ),
      );

    const listDueDeliveries: PullRequestMonitorFeedbackStoreApi["listDueDeliveries"] = (
      nowIso,
      limit,
    ) =>
      sql<DeliveryRow>`
        SELECT * FROM pull_request_monitor_feedback_deliveries
        WHERE status IN ('pending', 'failed')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowIso})
        ORDER BY created_at ASC
        LIMIT ${limit}
      `.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, rowToDelivery)),
        Effect.mapError((cause) =>
          cause instanceof PullRequestMonitorError
            ? cause
            : storeError("Failed to list due deliveries.", cause),
        ),
      );

    const nextRevisionNumber: PullRequestMonitorFeedbackStoreApi["nextRevisionNumber"] = (itemId) =>
      sql<{ readonly max_revision: number | null }>`
        SELECT MAX(revision_number) AS max_revision
        FROM pull_request_monitor_feedback_revisions
        WHERE item_id = ${itemId}
      `.pipe(
        Effect.map((rows) => (rows[0]?.max_revision ?? 0) + 1),
        Effect.mapError((cause) => storeError("Failed to compute revision number.", cause)),
      );

    return {
      upsertOpenItem,
      insertRevision,
      getItem,
      listItems,
      setDisposition,
      insertReport,
      listReports,
      getState,
      saveState,
      insertDelivery,
      updateDelivery,
      getDeliveryByBatchKey,
      listDeliveries,
      listDueDeliveries,
      nextRevisionNumber,
    } satisfies PullRequestMonitorFeedbackStoreApi;
  }),
};
