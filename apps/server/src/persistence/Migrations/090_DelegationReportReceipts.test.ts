import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./090_DelegationReportReceipts.ts";

it.layer(NodeSqliteClient.layerMemory())("delegation report receipt migration", (it) => {
  it.effect("backfills accepted and stale outcomes idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE orchestration_events (
          sequence INTEGER PRIMARY KEY,
          stream_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          command_id TEXT,
          payload_json TEXT NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events
          (sequence, stream_id, event_type, occurred_at, command_id, payload_json)
        VALUES
          (
            1,
            'child',
            'thread.activity-appended',
            '2026-09-01T00:00:00.000Z',
            'accepted-command',
            '{"activity":{"kind":"delegation.reported","payload":{"assignmentId":"assignment","dispatchId":"dispatch-a","originTurnId":"turn-a","reportId":"accepted","dispatchVerdict":"accepted"}}}'
          ),
          (
            2,
            'child',
            'thread.activity-appended',
            '2026-09-01T00:01:00.000Z',
            'stale-command',
            '{"activity":{"kind":"delegation.reported","payload":{"assignmentId":"assignment","originTurnId":"turn-old","reportId":"stale","dispatchVerdict":"stale"}}}'
          ),
          (
            3,
            'child',
            'thread.activity-appended',
            '2026-09-01T00:02:00.000Z',
            'ignored-command',
            '{"activity":{"kind":"delegation.reported","payload":{"assignmentId":"assignment","reportId":"ignored","dispatchVerdict":"already-recorded"}}}'
          )
      `;

      yield* migration;
      yield* migration;

      const rows = yield* sql<{
        readonly report_key: string;
        readonly outcome: string;
        readonly command_id: string;
      }>`
        SELECT report_key, outcome, command_id
        FROM delegation_report_receipts
        ORDER BY report_key
      `;
      assert.deepStrictEqual(rows, [
        {
          report_key: "report:child:dispatch-a:assignment:accepted",
          outcome: "accepted",
          command_id: "accepted-command",
        },
        {
          report_key: "report:child:turn:turn-old:assignment:stale",
          outcome: "stale",
          command_id: "stale-command",
        },
      ]);
    }),
  );
});
