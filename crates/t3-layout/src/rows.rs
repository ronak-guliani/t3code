//! Feed rows → layout rows.
//!
//! One layout row per top-level markdown block, user message, activity group,
//! notice, chip or image. Keys are stable strings (`{message}#{part}.{block}`,
//! `{group}`, `{id}#chip`) hashed to `u64`, so rows survive reparses and an
//! optimistic send swaps to the server's echo without a flicker.
//!
//! Everything here is width-independent: a [`RowCore`] holds prepared text and
//! is rebuilt only when its source changes. Heights at a width are the frame's
//! job — see `Worker::pass`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use t3_markdown::parser::{IncrementalParser, TopBlock};
use t3_text::WhiteSpace;

use super::display::{ColorRole, DisplayBuilder, WidgetKind};
use super::feed::{
    Attachment, FeedActivity, FeedActivityGroup, FeedMessage, FeedRow, Origin, PendingUser, Role,
    TranscriptInput,
};
use super::markdown::{Ctx, PBlock, PText, Px, place, place_text, prepare_block, prepare_plain};
use super::style::{Family, TYPE, Weight};

/// Row kinds the painter may style differently (e.g. context menus).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    Markdown,
    User,
    ActivityGroup,
    Chip,
    Image,
    TurnFold,
    Working,
}

/// Stable 64-bit key from a row's identity string. FNV-1a, so keys survive
/// relaunches and the platform may cache them.
pub(crate) fn row_key(id: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in id.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

static VERSION: AtomicU64 = AtomicU64::new(1);
pub(crate) fn next_version() -> u64 {
    VERSION.fetch_add(1, Ordering::Relaxed)
}

/// A user message bubble.
pub(crate) struct UserBubble {
    pub text: PText,
    pub images: Vec<String>,
    pub pending: bool,
    pub expanded: bool,
    pub more: PText,
}

pub(crate) struct Chip {
    pub icon: Option<String>,
    pub color: ColorRole,
    pub text: PText,
}

/// One activity inside a group. `heading`/`preview`/`body` arrive already
/// resolved from upstream presentation — this crate paints them and decides
/// geometry, it does not re-derive what a tool call means.
pub(crate) struct ActivityRow {
    pub icon: Option<String>,
    pub failed: bool,
    pub live: bool,
    pub heading: PText,
    pub preview: Option<PText>,
    pub body: Option<PText>,
    /// Stable key for this activity's inline detail toggle.
    pub detail_key: u64,
    /// Whether its body is revealed.
    pub expanded: bool,
}

/// A collapsible run of activities.
pub(crate) struct ActivityFold {
    pub summary: PText,
    pub live: bool,
    pub expanded: bool,
    pub children: Vec<ActivityRow>,
}

#[allow(clippy::large_enum_variant)] // cores are shared behind Arc; boxing adds a hop
pub(crate) enum Content {
    Block(PBlock),
    User(UserBubble),
    Activity(ActivityFold),
    Chip(Chip),
    Image { id: Arc<str>, mime_type: Arc<str> },
    TurnFold { label: PText },
    Working { since_ms: Option<i64>, streaming: bool },
}

/// A width-independent row: identity, top gap class and prepared content.
pub(crate) struct RowCore {
    pub key: u64,
    pub version: u64,
    pub kind: RowKind,
    pub entry_id: Arc<str>,
    pub content: Content,
    pub copy_text: String,
}

/// A row in transcript order: shared core plus its context-dependent top gap.
#[derive(Clone)]
pub(crate) struct Placed {
    pub core: Arc<RowCore>,
    pub gap: Gap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Gap {
    First,
    Turn,
    Reply,
    Block,
    Heading,
}

pub(crate) mod geom {
    pub const MARGIN_X: f32 = 18.0;
    /// The message column's width cap on wide screens (iPad, landscape).
    pub const READING_WIDTH: f32 = 768.0;
    pub const GAP_FIRST: f32 = 14.0;
    pub const GAP_TURN: f32 = 30.0;
    pub const GAP_REPLY: f32 = 18.0;
    pub const GAP_BLOCK: f32 = 12.0;
    pub const GAP_HEADING: f32 = 22.0;
    pub const BUBBLE_PAD_X: f32 = 15.0;
    pub const FADE: f32 = 28.0;
    pub const BUBBLE_PAD_Y: f32 = 10.0;
    pub const BUBBLE_RADIUS: f32 = 20.0;
    pub const BUBBLE_FOLD_LINES: usize = 8;
    pub const BUBBLE_FOLD_SHOW: usize = 6;
    pub const THUMB: f32 = 76.0;
    pub const IMAGE: f32 = 260.0;
    pub const WORKING: f32 = 36.0;
    /// Left gutter for an activity row's status glyph and rail.
    pub const ACTIVITY_GUTTER: f32 = 22.0;
    pub const ACTIVITY_RAIL_X: f32 = 10.0;
}

impl Gap {
    pub fn px(self, px: Px) -> f32 {
        use geom::*;
        px.v(match self {
            Gap::First => GAP_FIRST,
            Gap::Turn => GAP_TURN,
            Gap::Reply => GAP_REPLY,
            Gap::Block => GAP_BLOCK,
            Gap::Heading => GAP_HEADING,
        })
    }
}

struct PartState {
    parser: IncrementalParser,
    /// Last source fed to the parser (cheap equality short-circuit).
    source_len: usize,
    source_hash: u64,
    streaming: bool,
    blocks: Vec<(Arc<TopBlock>, Arc<RowCore>)>,
}

struct MessageState {
    sig: u64,
    /// `updatedAt` as of the last build, so an unchanged message can be
    /// recognised without cloning its id or re-reading its body.
    updated_at: String,
    rows: Vec<Placed>,
}

#[derive(Default)]
pub(crate) struct RowBuilder {
    parts: HashMap<String, PartState>,
    messages: HashMap<String, MessageState>,
    /// Simple single-row caches keyed by row identity string.
    singletons: HashMap<String, (u64, Arc<RowCore>)>,
    pending: HashMap<String, (PendingUser, Arc<RowCore>)>,
    working: Option<Arc<RowCore>>,
    /// Rows the reader opened, keyed by row key.
    pub expanded: HashSet<u64>,
    /// Rows the reader closed. A row the reader has never touched paints its
    /// default.
    pub collapsed: HashSet<u64>,
    /// Per-activity inline detail toggles: `{group}#{activity}#{detail}` → open.
    pub detail_open: HashMap<u64, bool>,
}

/// Change detector for a text source: whole-string, so a same-length rewrite is
/// caught too. Only changed rows reach here and re-parsing is linear in their
/// length.
pub(crate) fn quick_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

impl RowBuilder {
    /// Rows for `input`, reusing every row whose source is unchanged. This is
    /// what makes a streamed token cost O(delta + last block) rather than a
    /// full transcript re-parse.
    pub fn build(&mut self, ctx: &mut Ctx, input: &TranscriptInput) -> Vec<Placed> {
        let mut out: Vec<Placed> = Vec::with_capacity(self.messages.len() * 2 + 4);
        let mut prev_role: Option<Role> = None;

        for feed_row in &input.feed {
            match feed_row {
                FeedRow::Message(m) => {
                    let rows = self.message_rows(ctx, m, out.is_empty(), prev_role);
                    if !rows.is_empty() {
                        prev_role = Some(m.role);
                    }
                    out.extend(rows);
                }
                FeedRow::ActivityGroup(g) => {
                    out.extend(self.group_rows(ctx, g, out.is_empty(), prev_role));
                }
                FeedRow::WorkToggle(t) => {
                    let gap = tail_gap(&out, prev_role);
                    out.push(Placed { core: self.work_toggle_row(ctx, t), gap });
                }
                FeedRow::TurnFold(f) => {
                    out.push(Placed { core: self.turn_fold_row(ctx, f), gap: Gap::Heading });
                }
                FeedRow::Thinking { id } => {
                    let core = self.singleton(ctx, &format!("{id}#thinking"), 0, |ctx| {
                        Chip {
                            icon: Some("sparkles".into()),
                            color: ColorRole::TextTertiary,
                            text: small_text(ctx, "Thinking…", ColorRole::TextTertiary),
                        }
                    });
                    out.push(Placed { core, gap: Gap::Block });
                }
            }
        }

        // Optimistic sends the server has not echoed yet.
        let echoed: HashSet<&str> = input
            .feed
            .iter()
            .filter_map(|r| match r {
                FeedRow::Message(m) => Some(m.id.as_str()),
                _ => None,
            })
            .collect();
        for p in &input.pending {
            if echoed.contains(p.id.as_str()) {
                continue;
            }
            let gap = if out.is_empty() { Gap::First } else { Gap::Turn };
            let core = match self.pending.get(&p.id) {
                Some((cached, row)) if cached == p => row.clone(),
                _ => {
                    let row = Arc::new(self.user_row(
                        ctx,
                        &p.id,
                        &p.text,
                        &p.attachments,
                        true,
                        self.is_open(row_key(&format!("{}#u", p.id)), false),
                    ));
                    self.pending.insert(p.id.clone(), (p.clone(), row.clone()));
                    row
                }
            };
            out.push(Placed { core, gap });
        }

        if input.working {
            let stale = self.working.as_ref().is_none_or(|w| {
                !matches!(
                    &w.content,
                    Content::Working { since_ms, streaming }
                        if *since_ms == input.working_since_ms && *streaming == input.streaming
                )
            });
            if stale {
                self.working = Some(Arc::new(RowCore {
                    key: row_key("#working"),
                    version: next_version(),
                    kind: RowKind::Working,
                    entry_id: Arc::from(""),
                    content: Content::Working {
                        since_ms: input.working_since_ms,
                        streaming: input.streaming,
                    },
                    copy_text: String::new(),
                }));
            }
            out.push(Placed { core: self.working.clone().expect("set above"), gap: Gap::Reply });
        }

        // Drop caches whose source disappeared, so a shrinking thread releases
        // its prepared text.
        let live: HashSet<&str> = input
            .feed
            .iter()
            .filter_map(|r| match r {
                FeedRow::Message(m) => Some(m.id.as_str()),
                _ => None,
            })
            .chain(input.pending.iter().map(|p| p.id.as_str()))
            .collect();
        self.messages.retain(|id, _| live.contains(id.as_str()));
        self.pending.retain(|id, _| input.pending.iter().any(|p| &p.id == id));
        // `parts` is keyed by message id, so the same `live` set prunes it.
        self.parts.retain(|id, _| live.contains(id.as_str()));

        out
    }

    /// Drop cached rows owning `key` so the next build re-prepares them
    /// (disclosure toggles). Only the owning entry pays.
    pub fn invalidate(&mut self, key: u64) {
        self.messages.retain(|_, s| !s.rows.iter().any(|p| p.core.key == key));
        self.singletons.retain(|_, (_, r)| r.key != key);
        self.pending.retain(|_, (_, r)| r.key != key);
    }

    /// Whether `key` paints expanded: the reader's choice if they have made
    /// one, otherwise `default`.
    pub fn is_open(&self, key: u64, default: bool) -> bool {
        if self.expanded.contains(&key) {
            return true;
        }
        if self.collapsed.contains(&key) {
            return false;
        }
        default
    }

    // ---- messages -------------------------------------------------------

    /// A user message is one bubble. Assistant and system messages are
    /// markdown split per top-level block, preceded by a chip when the message
    /// carries a visible origin.
    fn message_rows(
        &mut self,
        ctx: &mut Ctx,
        m: &FeedMessage,
        first: bool,
        prev_role: Option<Role>,
    ) -> Vec<Placed> {
        // `updatedAt` is bumped when a message is replaced, so an unchanged
        // message is identified without reading its body. Hashing every message
        // on every pass would make a streamed token cost O(transcript bytes),
        // which is the one thing streaming must not do.
        //
        // A user bubble additionally depends on the reader's disclosure state, so
        // its signature folds that in — otherwise a toggle would be masked by a
        // cache hit.
        let user = m.role == Role::User;
        let bubble_key = row_key(&format!("{}#u", m.id));
        let bubble_open = user && self.is_open(bubble_key, false);
        let sig = message_sig(m, first, prev_role)
            ^ ((bubble_open as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15));

        if let Some(state) = self.messages.get(&m.id)
            && state.updated_at == m.updated_at
                && state.sig == sig
            {
                return state.rows.clone();
        }

        let mut rows: Vec<Placed> = Vec::new();
        let mut gap = tail_gap_for(first, prev_role);

        if user {
            // A bubble is cached like any other row: rebuilding it every pass
            // would re-prepare every user message on every streamed token.
            rows.push(Placed {
                core: Arc::new(
                    self.user_row(ctx, &m.id, &m.text, &m.attachments, false, bubble_open),
                ),
                gap: if first { Gap::First } else { Gap::Turn },
            });
            self.remember(m, sig, rows.clone());
            return rows;
        }

        if let Some(origin) = &m.origin
            && let Some(chip) = self.origin_chip(ctx, m, origin) {
                rows.push(Placed { core: chip, gap });
                gap = Gap::Block;
            }

        for a in m.attachments.iter().filter(|a| a.is_image()) {
            rows.push(Placed { core: self.image_row(m, a), gap });
            gap = Gap::Block;
        }

        let blocks = self.text_blocks(ctx, &m.id, &m.text, m.streaming);
        for (bi, (_, core)) in blocks.iter().enumerate() {
            let heading = matches!(core.content, Content::Block(PBlock::Heading(_)));
            let this_gap = if bi == 0 {
                gap
            } else if heading {
                Gap::Heading
            } else {
                Gap::Block
            };
            rows.push(Placed { core: core.clone(), gap: this_gap });
        }

        if !rows.is_empty() {
            self.remember(m, sig, rows.clone());
        }
        rows
    }

    fn remember(&mut self, m: &FeedMessage, sig: u64, rows: Vec<Placed>) {
        self.messages.insert(
            m.id.clone(),
            MessageState { sig, updated_at: m.updated_at.clone(), rows },
        );
    }

    fn origin_chip(
        &mut self,
        ctx: &mut Ctx,
        m: &FeedMessage,
        origin: &Origin,
    ) -> Option<Arc<RowCore>> {
        let (icon, color, text) = match origin {
            Origin::CrossThread { source_thread_title } => (
                "arrow.triangle.branch",
                ColorRole::TextTertiary,
                format!("Continued from {source_thread_title}"),
            ),
            Origin::WorkspaceHandoffMarker { branch } => {
                ("arrow.left.arrow.right", ColorRole::TextTertiary, format!("Handoff · {branch}"))
            }
            Origin::WorkspaceHandoffContinuation { branch } => (
                "arrow.down.right",
                ColorRole::TextTertiary,
                format!("Continuing in {branch}"),
            ),
            Origin::Other => return None,
        };
        let sig = message_sig(m, false, None);
        Some(self.singleton(ctx, &format!("{}#origin", m.id), sig, |ctx| Chip {
            icon: Some(icon.into()),
            color,
            text: small_text(ctx, &text, color),
        }))
    }

    /// Images are painted natively, so the row carries only the reference. No
    /// `ctx`: there is no text to prepare, and the height is a constant.
    fn image_row(&mut self, m: &FeedMessage, a: &Attachment) -> Arc<RowCore> {
        let (id, mime) = a.handle();
        let key = format!("{}#img:{}", m.id, id);
        self.singletons
            .entry(key.clone())
            .or_insert_with(|| {
                (
                    0,
                    Arc::new(RowCore {
                        key: row_key(&key),
                        version: next_version(),
                        kind: RowKind::Image,
                        entry_id: Arc::from(m.id.as_str()),
                        content: Content::Image { id: Arc::from(id), mime_type: Arc::from(mime) },
                        copy_text: String::new(),
                    }),
                )
            })
            .1
            .clone()
    }

    #[allow(clippy::too_many_arguments)]
    fn user_row(
        &mut self,
        ctx: &mut Ctx,
        id: &str,
        content: &str,
        attachments: &[Attachment],
        pending: bool,
        expanded: bool,
    ) -> RowCore {
        let key = row_key(&format!("{id}#u"));
        let body = content.trim();
        let (size, lh) = TYPE.body;
        let style = ctx.typo.style(Family::Sans, Weight::Regular, false, size);
        let text = prepare_plain(ctx, body, style, ctx.typo.px(lh), ColorRole::Text, WhiteSpace::PreWrap);
        let (msize, mlh) = TYPE.small;
        let mstyle = ctx.typo.style(Family::Sans, Weight::Medium, false, msize);
        let more = prepare_plain(
            ctx,
            if expanded { "Show less" } else { "Show more" },
            mstyle,
            ctx.typo.px(mlh),
            ColorRole::TextSecondary,
            WhiteSpace::Pre,
        );
        RowCore {
            key,
            version: next_version(),
            kind: RowKind::User,
            entry_id: Arc::from(id),
            content: Content::User(UserBubble {
                text,
                images: attachments.iter().filter(|a| a.is_image()).map(|a| a.handle().0.into()).collect(),
                pending,
                expanded,
                more,
            }),
            copy_text: body.to_owned(),
        }
    }

    /// Parse `text` into per-block rows, reparsing only the streaming tail.
    /// Keyed by message id; block rows are `{id}.{index}`.
    fn text_blocks(
        &mut self,
        ctx: &mut Ctx,
        message_id: &str,
        text: &str,
        streaming: bool,
    ) -> Vec<(Arc<TopBlock>, Arc<RowCore>)> {
        let hash = quick_hash(text);
        let state = self.parts.entry(message_id.to_owned()).or_insert_with(|| PartState {
            parser: IncrementalParser::new(),
            source_len: usize::MAX,
            source_hash: 0,
            streaming,
            blocks: Vec::new(),
        });
        if state.source_len == text.len()
            && state.source_hash == hash
            && state.streaming == streaming
        {
            return state.blocks.clone();
        }
        state.parser.set_text(text);
        state.source_len = text.len();
        state.source_hash = hash;
        state.streaming = streaming;
        let tree = if streaming { state.parser.display_tree() } else { state.parser.tree().clone() };
        let mut next = Vec::with_capacity(tree.blocks.len());
        for (bi, block) in tree.blocks.iter().enumerate() {
            let copy = text.get(block.range.clone()).unwrap_or("").trim_end();
            // Same rendering is not enough: the source can still differ (a
            // closing `**` that renders identically) and Copy reads the source.
            let reuse = state
                .blocks
                .get(bi)
                .filter(|(b, core)| {
                    (Arc::ptr_eq(b, block) || b.block == block.block) && core.copy_text == copy
                })
                .map(|(_, core)| core.clone());
            let core = reuse.unwrap_or_else(|| {
                let id = format!("{message_id}.{bi}");
                let content = prepare_block(ctx, &block.block, 0, false);
                Arc::new(RowCore {
                    key: row_key(&id),
                    version: next_version(),
                    kind: RowKind::Markdown,
                    entry_id: Arc::from(message_id),
                    content: Content::Block(content),
                    copy_text: copy.to_owned(),
                })
            });
            next.push((block.clone(), core));
        }
        state.blocks = next.clone();
        next
    }

    // ---- activity groups ------------------------------------------------

    fn group_rows(
        &mut self,
        ctx: &mut Ctx,
        g: &FeedActivityGroup,
        first: bool,
        prev_role: Option<Role>,
    ) -> Vec<Placed> {
        let key = row_key(&g.id);
        // A group holding an approval or error stays open: it is asking
        // something of the reader.
        let has_notice = g.activities.iter().any(FeedActivity::is_notice);
        // Resolve the disclosure *before* consulting the cache and fold it into
        // the signature, so a toggle can never be masked by a cache hit.
        let expanded = self.is_open(key, has_notice);
        // Fold each child's inline-detail state into the signature too, so a
        // detail tap invalidates the group without an explicit `invalidate`.
        let mut sig = group_sig(g) ^ (expanded as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        for a in &g.activities {
            let d = detail_key(a);
            sig = sig.rotate_left(7) ^ (self.detail_open.get(&d).copied().unwrap_or(false) as u64);
        }
        if let Some((cached_sig, core)) = self.singletons.get(&g.id)
            && *cached_sig == sig {
                return vec![Placed { core: core.clone(), gap: tail_gap_for(first, prev_role) }];
            }

        let children: Vec<ActivityRow> =
            g.activities.iter().map(|a| self.activity_row(ctx, a, expanded)).collect();

        let core = Arc::new(RowCore {
            key,
            version: sig,
            kind: RowKind::ActivityGroup,
            entry_id: Arc::from(g.id.as_str()),
            content: Content::Activity(ActivityFold {
                summary: small_text(ctx, &g.summary, ColorRole::TextSecondary),
                live: g.live,
                expanded,
                children,
            }),
            copy_text: group_copy_text(g),
        });
        self.singletons.insert(g.id.clone(), (sig, core.clone()));
        vec![Placed { core, gap: tail_gap_for(first, prev_role) }]
    }

    fn activity_row(&mut self, ctx: &mut Ctx, a: &FeedActivity, group_expanded: bool) -> ActivityRow {
        let color = match a.tone.as_str() {
            "error" => ColorRole::Danger,
            "approval" => ColorRole::Accent,
            "tool" => ColorRole::Text,
            _ => ColorRole::TextSecondary,
        };
        let (hsize, hlh) = TYPE.small;
        let heading_style = ctx.typo.style(Family::Sans, Weight::Medium, false, hsize);
        let (csize, clh) = TYPE.code;
        let code_style = ctx.typo.style(Family::Mono, Weight::Regular, false, csize);
        let detail = detail_key(a);
        let expanded = group_expanded && self.detail_open.get(&detail).copied().unwrap_or(false);
        ActivityRow {
            icon: a.icon.clone(),
            failed: a.failed,
            live: a.live,
            heading: prepare_plain(
                ctx,
                &a.heading,
                heading_style,
                ctx.typo.px(hlh),
                color,
                WhiteSpace::PreWrap,
            ),
            preview: a.preview.as_deref().map(|p| {
                prepare_plain(
                    ctx,
                    p,
                    code_style,
                    ctx.typo.px(clh),
                    ColorRole::TextFaint,
                    WhiteSpace::Pre,
                )
            }),
            body: a.body.as_deref().map(|b| {
                prepare_plain(
                    ctx,
                    b,
                    code_style,
                    ctx.typo.px(clh),
                    ColorRole::TextSoft,
                    WhiteSpace::PreWrap,
                )
            }),
            detail_key: detail,
            expanded,
        }
    }

    fn work_toggle_row(
        &mut self,
        ctx: &mut Ctx,
        t: &super::feed::FeedWorkToggle,
    ) -> Arc<RowCore> {
        let key = format!("{}#toggle", t.id);
        let color = if t.has_failure { ColorRole::Danger } else { ColorRole::Accent };
        let sig = quick_hash(&t.summary) ^ (t.has_failure as u64);
        self.singleton(ctx, &key, sig, |ctx| Chip {
            icon: t.icon.clone(),
            color,
            text: small_text(ctx, &t.summary, color),
        })
    }

    fn turn_fold_row(&mut self, ctx: &mut Ctx, f: &super::feed::FeedTurnFold) -> Arc<RowCore> {
        let key = format!("{}#fold", f.id);
        let sig = quick_hash(&f.label);
        if let Some((cached, core)) = self.singletons.get(&key)
            && *cached == sig {
                return core.clone();
            }
        let label = small_text(ctx, &f.label, ColorRole::TextTertiary);
        let core = Arc::new(RowCore {
            key: row_key(&key),
            version: sig,
            kind: RowKind::TurnFold,
            entry_id: Arc::from(f.id.as_str()),
            content: Content::TurnFold { label },
            copy_text: f.label.clone(),
        });
        self.singletons.insert(key, (sig, core.clone()));
        core
    }

    /// Build once, then reuse until `sig` (the row's content signature) changes.
    fn singleton(
        &mut self,
        ctx: &mut Ctx,
        id: &str,
        sig: u64,
        build: impl FnOnce(&mut Ctx) -> Chip,
    ) -> Arc<RowCore> {
        if let Some((cached, core)) = self.singletons.get(id)
            && *cached == sig {
                return core.clone();
            }
        let chip = build(ctx);
        let core = Arc::new(RowCore {
            key: row_key(id),
            version: sig,
            kind: RowKind::Chip,
            entry_id: Arc::from(id),
            content: Content::Chip(chip),
            copy_text: String::new(),
        });
        self.singletons.insert(id.to_owned(), (sig, core.clone()));
        core
    }
}

fn small_text(ctx: &mut Ctx, text: &str, color: ColorRole) -> PText {
    let (size, lh) = TYPE.small;
    let style = ctx.typo.style(Family::Sans, Weight::Regular, false, size);
    prepare_plain(ctx, text, style, ctx.typo.px(lh), color, WhiteSpace::PreWrap)
}

fn tail_gap(out: &[Placed], prev_role: Option<Role>) -> Gap {
    tail_gap_for(out.is_empty(), prev_role)
}

fn tail_gap_for(first: bool, prev_role: Option<Role>) -> Gap {
    if first {
        Gap::First
    } else if prev_role.is_none_or(|r| r == Role::User) {
        Gap::Reply
    } else {
        Gap::Block
    }
}

/// Everything about a message that can change its rows, *except* its body.
///
/// The body is represented by `len`. Correctness rests on the contract: the
/// server advances `OrchestrationMessage.updatedAt` when it replaces a message,
/// and `build()` compares that before trusting this signature. Hashing the body
/// here instead would make every streamed token cost O(transcript bytes), which
/// is the one thing streaming must not do.
fn message_sig(m: &FeedMessage, first: bool, prev_role: Option<Role>) -> u64 {
    let mut h = (m.text.len() as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    h = h.rotate_left(7) ^ (m.streaming as u64);
    h = h.rotate_left(7) ^ ((first as u64) | ((prev_role.map_or(0, |r| r as u64 + 1)) << 1));
    for a in &m.attachments {
        h = h.rotate_left(7) ^ quick_hash(a.handle().0);
    }
    match &m.origin {
        Some(o) => h = h.rotate_left(7) ^ quick_hash(&format!("{o:?}")),
        None => h = h.rotate_left(7) ^ 0x5bf0_3635,
    }
    h
}

/// Stable key for one activity's inline detail toggle.
fn detail_key(a: &FeedActivity) -> u64 {
    row_key(&format!("{}#{}#detail", a.id, a.kind))
}

/// `tone` picks the run colour and `icon` picks a widget, so both belong in the
/// group's signature: a feed that re-resolves presentation without changing any
/// text must still repaint.
fn group_sig(g: &FeedActivityGroup) -> u64 {
    let mut h = quick_hash(&g.summary) ^ g.activities.len() as u64;
    for a in &g.activities {
        h = h.rotate_left(7) ^ quick_hash(&a.heading);
        h = h.rotate_left(7) ^ quick_hash(a.preview.as_deref().unwrap_or(""));
        h = h.rotate_left(7) ^ quick_hash(a.body.as_deref().unwrap_or(""));
        h = h.rotate_left(7) ^ quick_hash(&a.tone);
        h = h.rotate_left(7) ^ quick_hash(a.icon.as_deref().unwrap_or(""));
        h = h.rotate_left(7) ^ (a.failed as u64) ^ ((a.live as u64) << 1);
    }
    h
}

fn group_copy_text(g: &FeedActivityGroup) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(g.activities.len());
    for a in &g.activities {
        let mut s = a.heading.clone();
        if let Some(p) = &a.preview {
            s.push('\n');
            s.push_str(p);
        }
        if let Some(b) = &a.body {
            s.push_str("\n\n");
            s.push_str(b);
        }
        parts.push(s);
    }
    parts.join("\n\n")
}

/// Approximate heap held by prepared text (diagnostics).
pub(crate) fn content_heap_bytes(content: &Content) -> usize {
    fn block(b: &PBlock) -> usize {
        match b {
            PBlock::Text(t) | PBlock::Heading(t) => t.p.heap_bytes(),
            PBlock::Code(c) => {
                c.body.p.heap_bytes()
                    + c.source.len()
                    + c.label.as_ref().map_or(0, |l| l.p.heap_bytes())
            }
            PBlock::Quote(children) => children.iter().map(block).sum(),
            PBlock::List { items, .. } => items
                .iter()
                .map(|i| {
                    i.children.iter().map(block).sum::<usize>()
                        + i.marker.as_ref().map_or(0, |m| m.p.heap_bytes())
                })
                .sum(),
            PBlock::Table(t) => t.cells.iter().flatten().map(|c| c.p.heap_bytes()).sum(),
            PBlock::Rule => 0,
        }
    }
    fn activity(a: &ActivityRow) -> usize {
        a.heading.p.heap_bytes()
            + a.preview.as_ref().map_or(0, |p| p.p.heap_bytes())
            + a.body.as_ref().map_or(0, |b| b.p.heap_bytes())
    }
    match content {
        Content::Block(b) => block(b),
        Content::User(u) => u.text.p.heap_bytes() + u.more.p.heap_bytes(),
        Content::Activity(f) => f.summary.p.heap_bytes() + f.children.iter().map(activity).sum::<usize>(),
        Content::Chip(c) => c.text.p.heap_bytes(),
        Content::Image { id, mime_type } => id.len() + mime_type.len(),
        Content::TurnFold { label } => label.p.heap_bytes(),
        Content::Working { .. } => 0,
    }
}

/// Place a row's content at its gap offset, returning its height. With `out` it
/// also emits the display list; without, it only measures. Measurement and
/// painting share this function, so they cannot disagree about line breaks.
pub(crate) fn place_row(
    core: &RowCore,
    gap: Gap,
    px: Px,
    width: f32,
    mut out: Option<&mut DisplayBuilder>,
) -> f32 {
    use geom::*;
    let margin = px.v(MARGIN_X);
    let column = (width.min(margin * 2.0 + px.v(READING_WIDTH)) - margin * 2.0).max(1.0);
    let x = (width - column) / 2.0 + margin;
    let y = gap.px(px);
    match &core.content {
        Content::Block(block) => y + place(block, px, x, y, column, out.as_deref_mut()),
        Content::User(u) => place_user(u, px, x, y, column, out),
        Content::Activity(f) => place_fold(f, px, x, y, column, out),
        Content::Chip(c) => place_chip(c, px, x, y, column, out),
        Content::Image { .. } => y + px.v(IMAGE),
        Content::TurnFold { label } => place_text(label, x, y, column, out.as_deref_mut()),
        Content::Working { since_ms, streaming } => {
            if let Some(o) = out {
                o.widget(
                    WidgetKind::Working { since_ms: *since_ms, streaming: *streaming },
                    (x, y, column, px.v(WORKING)),
                    None,
                );
            }
            y + px.v(WORKING)
        }
    }
}

fn place_user(
    u: &UserBubble,
    px: Px,
    x: f32,
    y: f32,
    column: f32,
    mut out: Option<&mut DisplayBuilder>,
) -> f32 {
    use geom::*;
    let pad_x = px.v(BUBBLE_PAD_X);
    let pad_y = px.v(BUBBLE_PAD_Y);
    let inner = (column - pad_x * 2.0).max(1.0);
    let mut cy = y + pad_y;

    // Thumbnails first, then text — matching the order they were attached.
    if !u.images.is_empty() {
        let count = u.images.len().min(4) as f32;
        let thumb = px.v(THUMB);
        let gap = px.v(6.0);
        let row_w = (thumb + gap) * count - gap;
        if let Some(o) = out.as_deref_mut() {
            o.fill(x, cy, column.min(row_w + pad_x * 2.0), thumb + pad_y, px.v(BUBBLE_RADIUS), ColorRole::UserBubble);
            for i in 0..(u.images.len().min(4)) {
                let tx = x + pad_x + i as f32 * (thumb + gap);
                o.widget(
                    WidgetKind::Image { reference: u.images[i].clone() },
                    (tx, cy + pad_y, thumb, thumb),
                    None,
                );
            }
        }
        cy += thumb + pad_y * 2.0;
    }

    // Fold a long message. The fold must change the row's *height*, not just
    // paint a fade over the overflow — otherwise expanding it moves nothing and
    // the toggle reads as broken. So we measure the shown line count first and
    // place exactly that many lines.
    let run_start = out.as_ref().map_or(0, |o| o.runs.len());
    let stats = u.text.p.stats(inner);
    let folds = stats.line_count > BUBBLE_FOLD_LINES;
    let shown = if folds && !u.expanded { BUBBLE_FOLD_SHOW } else { stats.line_count };

    let text_h = match out.as_deref_mut() {
        Some(o) => place_clipped(&u.text, x + pad_x, cy, inner, shown, px.v(geom::FADE), o),
        None => shown as f32 * u.text.lh,
    };
    cy += text_h;

    cy += px.v(6.0);
    cy += place_text(&u.more, x + pad_x, cy, inner, out.as_deref_mut());
    if u.pending
        && let Some(o) = out {
            dim_from(o, run_start, ColorRole::TextSecondary);
        }
    cy + pad_y
}

/// Place `t`, then drop runs, links and widgets that fall past `max_lines`,
/// fading the last visible line. Returns the *clipped* height, so the row
/// reserves only what it shows.
fn place_clipped(
    t: &PText,
    x: f32,
    y: f32,
    width: f32,
    max_lines: usize,
    _fade_w: f32,
    out: &mut DisplayBuilder,
) -> f32 {
    let runs_before = out.runs.len();
    let widgets_before = out.widgets.len();
    let h = place_text(t, x, y, width, Some(out));
    let limit = y + max_lines as f32 * t.lh;
    if h <= limit {
        return h;
    }
    let kept = out.runs[runs_before..].iter().take_while(|r| r.baseline < limit).count();
    out.runs.truncate(runs_before + kept);
    out.links.retain(|l| l.y < limit);
    out.widgets.truncate(
        widgets_before + out.widgets[widgets_before..].iter().take_while(|w| w.y < limit).count(),
    );
    out.fade(x, limit - t.lh, width, t.lh, super::display::FadeEdge::Bottom);
    max_lines as f32 * t.lh
}

/// Repaint every run from `from` onward in `color`. Used to dim an optimistic
/// send until the server echoes it, so the painter needs no extra state.
fn dim_from(out: &mut DisplayBuilder, from: usize, color: ColorRole) {
    for r in &mut out.runs[from..] {
        r.color = color;
    }
}

fn place_fold(
    f: &ActivityFold,
    px: Px,
    x: f32,
    y: f32,
    column: f32,
    mut out: Option<&mut DisplayBuilder>,
) -> f32 {
    use geom::*;
    let mut cy = y + place_text(&f.summary, x, y, column, out.as_deref_mut());
    if let Some(o) = out.as_deref_mut() {
        o.widget(
            WidgetKind::Chevron { expanded: f.expanded },
            (x + column - px.v(14.0), y + px.v(3.0), px.v(12.0), px.v(12.0)),
            None,
        );
        if f.live {
            o.widget(WidgetKind::Shimmer, (x, y - px.v(2.0), column, px.v(20.0)), None);
        }
    }
    if !f.expanded {
        return cy;
    }
    let top = cy;
    for child in &f.children {
        cy += place_activity(child, px, x, cy, column, out.as_deref_mut());
    }
    // One continuous trunk down the group. Per-row elbows belong with the tool
    // rail's own geometry, which is Phase 1's deferred presentation work.
    if let Some(o) = out
        && !f.children.is_empty() {
            o.hairline(
                x + px.v(ACTIVITY_RAIL_X),
                top,
                px.v(1.0),
                cy - top,
                0.0,
                ColorRole::ToolRail,
            );
        }
    cy
}

fn place_activity(
    a: &ActivityRow,
    px: Px,
    x: f32,
    y: f32,
    column: f32,
    mut out: Option<&mut DisplayBuilder>,
) -> f32 {
    use geom::*;
    let gutter = px.v(ACTIVITY_GUTTER);
    let inner = (column - gutter).max(1.0);
    let mut cy = y;

    if let Some(o) = out.as_deref_mut() {
        let glyph = if a.live {
            WidgetKind::Spinner
        } else {
            WidgetKind::ToolStatus { running: false, failed: a.failed }
        };
        o.widget(glyph, (x, cy + px.v(1.0), gutter - px.v(8.0), gutter - px.v(8.0)), None);
        if let Some(icon) = &a.icon {
            o.widget(
                WidgetKind::Icon { name: icon.clone(), color: ColorRole::TextTertiary },
                (x + px.v(2.0), cy + px.v(3.0), px.v(14.0), px.v(14.0)),
                None,
            );
        }
    }

    cy += place_text(&a.heading, x + gutter, cy, inner, out.as_deref_mut());
    if let Some(p) = &a.preview {
        cy += px.v(2.0) + place_text(p, x + gutter, cy + px.v(2.0), inner, out.as_deref_mut());
    }
    if a.expanded {
        if let Some(b) = &a.body {
            cy += px.v(6.0) + place_text(b, x + gutter, cy + px.v(6.0), inner, out.as_deref_mut());
            if let Some(o) = out.as_deref_mut() {
                o.widget(
                    WidgetKind::ToolToggle { detail: a.detail_key, open: true },
                    (x + gutter, cy - px.v(18.0), inner, px.v(18.0)),
                    None,
                );
            }
        }
    } else if a.body.is_some()
        && let Some(o) = out {
            o.widget(
                WidgetKind::ToolToggle { detail: a.detail_key, open: false },
                (x + gutter, cy, inner, px.v(18.0)),
                None,
            );
        }
    cy + px.v(8.0)
}

fn place_chip(
    c: &Chip,
    px: Px,
    x: f32,
    y: f32,
    column: f32,
    out: Option<&mut DisplayBuilder>,
) -> f32 {
    use geom::*;
    let pad_x = px.v(12.0);
    let pad_y = px.v(6.0);
    let icon_w = if c.icon.is_some() { px.v(18.0) } else { 0.0 };
    // One column for both measuring and painting: a different width folds the
    // text differently, and the painted row would overflow its measured height.
    let text_x = x + pad_x + icon_w;
    let inner = (column - (pad_x + icon_w) - pad_x).max(1.0);
    let text_h = place_text(&c.text, text_x, y + pad_y, inner, None);
    let h = text_h + pad_y * 2.0;
    if let Some(o) = out {
        o.fill(x, y, column, h, px.v(BUBBLE_RADIUS), ColorRole::ChipBackground);
        if let Some(icon) = &c.icon {
            o.widget(
                WidgetKind::Icon { name: icon.clone(), color: c.color },
                (x + pad_x, y + pad_y, px.v(14.0), px.v(14.0)),
                None,
            );
        }
        place_text(&c.text, text_x, y + pad_y, inner, Some(o));
    }
    h
}
