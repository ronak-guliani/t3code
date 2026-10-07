//! The layout engine's input: a thread feed, already grouped and ordered.
//!
//! This mirrors the feed t3code's clients already build — see
//! `buildThreadFeed()` in `apps/mobile/src/lib/threadActivity.ts` and
//! `WorkLogEntry` in `packages/client-runtime/src/work-log/presentation.ts`.
//! We deliberately do **not** re-derive grouping, tool summaries or icons from
//! `OrchestrationThreadActivity.payload` here: that projection is presentation
//! logic that already exists in TypeScript, and duplicating it in Rust would
//! give us two sources of truth that drift. The feed arrives resolved; this
//! crate owns measurement.
//!
//! Every field is owned (no lifetimes into a socket buffer) so a frame can hold
//! `Arc`s into it while the next feed is still being decoded.

use serde::{Deserialize, Serialize};

/// `OrchestrationMessageRole`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    User,
    Assistant,
    System,
}

/// `ChatAttachment` (`type` is the tag).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Attachment {
    Image { id: String, name: String, mime_type: String, size_bytes: u64 },
    File { id: String, name: String, mime_type: String, size_bytes: u64 },
}

impl Attachment {
    pub fn id(&self) -> &str {
        match self {
            Self::Image { id, .. } | Self::File { id, .. } => id,
        }
    }

    pub fn is_image(&self) -> bool {
        matches!(self, Self::Image { .. })
    }

    /// `(id, mimeType)`. Painters need both to fetch and decode a thumbnail.
    pub fn handle(&self) -> (&str, &str) {
        match self {
            Self::Image { id, mime_type, .. } | Self::File { id, mime_type, .. } => (id, mime_type),
        }
    }
}

/// `MessageOrigin` — why a message exists that the user did not type. Only the
/// variants that are visible in a transcript get a variant here; anything else
/// renders as plain prose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Origin {
    /// `cross-thread` — the seam where a message was carried in from another
    /// thread (zeron renders this as a labeled divider).
    CrossThread { source_thread_title: String },
    /// `workspace-handoff` with `role: "marker"` — a turn boundary note.
    WorkspaceHandoffMarker { branch: String },
    /// `workspace-handoff` with `role: "continuation"`.
    WorkspaceHandoffContinuation { branch: String },
    /// Any origin we do not render specially.
    #[serde(other)]
    Other,
}

/// `OrchestrationMessage` — one text row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedMessage {
    pub id: String,
    pub role: Role,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// `OrchestrationMessage.streaming`. While true the transcript is an
    /// unterminated block: reparse incrementally and show the streaming veil.
    #[serde(default)]
    pub streaming: bool,
    pub created_at: String,
    /// `OrchestrationMessage.updatedAt`. Bumped when a message is replaced, so
    /// the layout engine can skip re-reading an unchanged message's body. The
    /// server only advances it on a non-streaming replace, which is exactly when
    /// the text can change out from under a cached row.
    pub updated_at: String,
}

/// One already-presented activity. `WorkLogEntry` projected to plain owned
/// data: `heading` is the row's one-line label, `preview` the dimmed second
/// line, `body` the expanded detail. Tool *semantics* stay upstream — this
/// engine only paints text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedActivity {
    pub id: String,
    /// `OrchestrationThreadActivity.kind`.
    pub kind: String,
    /// `OrchestrationThreadActivity.tone` — `info` / `tool` / `approval` / `error`.
    pub tone: String,
    /// The label to paint.
    pub heading: String,
    /// Optional dimmed detail under the heading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// Detail revealed when the group is expanded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Whether `body` failed — paints in the danger color.
    #[serde(default)]
    pub failed: bool,
    /// Still running; paints a live indicator.
    #[serde(default)]
    pub live: bool,
    /// SF Symbol name, already resolved upstream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Sort key within its group; upstream `sequence`, else arrival order.
    pub sequence: u64,
}

impl FeedActivity {
    /// Approval and error rows must stay visible even when collapsed — they
    /// are asking something of the reader.
    pub fn is_notice(&self) -> bool {
        self.tone == "approval" || self.tone == "error"
    }
}

/// Consecutive activities rendered as one collapsible group, matching
/// `groupAdjacentActivities`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedActivityGroup {
    pub id: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub activities: Vec<FeedActivity>,
    /// The collapsed group's summary line.
    pub summary: String,
    #[serde(default)]
    pub has_failure: bool,
    #[serde(default)]
    pub live: bool,
}

/// `ThreadFeedEntry.work-toggle` — the affordance that reveals a group's rows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedWorkToggle {
    pub id: String,
    pub group_id: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub has_failure: bool,
    #[serde(default)]
    pub live: bool,
}

/// `ThreadFeedEntry.turn-fold` — a turn boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedTurnFold {
    pub id: String,
    pub turn_id: String,
    pub label: String,
}

/// One ordered row of the feed, mirroring `ThreadFeedEntry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FeedRow {
    Message(Box<FeedMessage>),
    ActivityGroup(Box<FeedActivityGroup>),
    WorkToggle(Box<FeedWorkToggle>),
    TurnFold(Box<FeedTurnFold>),
    /// `ThreadFeedEntry.thinking` — the live reasoning affordance.
    Thinking { id: String },
}

/// A user message the server has not echoed yet. The client mints the id, so
/// the echo replaces this row without a flicker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUser {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

/// Everything the row builder reads for one pass.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TranscriptInput {
    pub feed: Vec<FeedRow>,
    pub pending: Vec<PendingUser>,
    /// A turn is running (drives the tail working indicator).
    pub working: bool,
    /// `OrchestrationLatestTurn.startedAt`, as epoch milliseconds.
    pub working_since_ms: Option<i64>,
    /// Whether the newest message is still streaming.
    pub streaming: bool,
}

impl TranscriptInput {
    /// Turn built from a single markdown string. Drives the lab screen, the
    /// benchmark, and tests.
    pub fn from_markdown(entries: Vec<(String, String, bool)>) -> Self {
        // entries: (id, text, is_user)
        Self {
            feed: entries
                .into_iter()
                .map(|(id, text, is_user)| {
                    FeedRow::Message(Box::new(FeedMessage {
                        id,
                        role: if is_user { Role::User } else { Role::Assistant },
                        text,
                        attachments: Vec::new(),
                        origin: None,
                        turn_id: None,
                        streaming: false,
                        created_at: String::new(),
                        updated_at: String::new(),
                    }))
                })
                .collect(),
            ..Self::default()
        }
    }
}
