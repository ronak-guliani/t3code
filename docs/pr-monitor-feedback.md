# Review feedback handoffs

Manual PR reviews hand complete finding descriptions to the PR monitor's immutable
feedback revisions. Summaries remain bounded; they are not authoritative descriptions.
Submissions are rejected, never truncated, if a finding exceeds 64 KiB of UTF-8 JSON,
or a batch exceeds 256 KiB of UTF-8 JSON or 100 findings. These limits include metadata
and JSON escaping; submit smaller findings/batches on an explicit validation error.
The same limits apply to manual handoffs, RPC, and MCP before monitor mutations.
Review provenance includes the source finding, review thread, reviewed head, diff hash,
file, diff side, and line range. Existing ownership and disposition rules are unchanged.

`pr_monitor_context` returns `findingDetails` and revision records alongside the
existing feedback ledger. Select a `deliveryId` to read exactly the revisions referenced
by that delivery, or use `revisionIds` (up to 100); the selectors are mutually exclusive.
Without either selector, context returns current open feedback. Use `offset` and `limit`
(default 10, maximum 20) and follow `nextOffset` until it is null. Delivered revisions
may differ from each item's `currentRevisionId`; check both before editing.

The CLI exposes the same retrieval through
`t3 pr-monitor context <chat> --delivery-id <id> --offset 0 --limit 10`
or `--revision-id <id>`, together with the usual monitor selector flags.

Small deliveries include complete descriptions inline. Larger tool-enabled deliveries
include a bounded index and exact retrieval instructions. Owners without the context
tool receive one durable turn per revision, with the complete finding and only that
revision's activity. No index-only or partial-evidence turn starts remediation.
Turn identities use the immutable revision ID, so retries cannot renumber unrelated
findings. Queued-turn refreshes preserve the original context and reviewed-head provenance.

Content is untrusted review data, not instructions. `contentStatus: complete` identifies
new full-body records. Historical payloads are explicitly marked
`legacy-potentially-truncated`; missing or invalid payloads are `unavailable`. Such records
require the original review before remediation; the monitor does not invent missing text.
Old stored text is not retroactively repaired by this change.
