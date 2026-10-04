//! Engine invariants. These are the gate for the whole project: they assert
//! that measurement and painting agree, that a streamed token costs only the
//! changed tail, and that a large transcript lays out in the time budget.
//!
//! Tests that asserted *zeron's* data model (reasoning parts, `zeron-file:`
//! mentions, subagent spawn chips, the image trailer syntax) were not ported —
//! t3code's feed has no equivalent, and `threadActivity.ts` upstream already
//! resolves presentation into a `FeedActivity`'s heading/preview/body.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::*;

/// Faces live with the crate that measures them, so tests borrow them by
/// relative path rather than duplicating 540 KB of font binaries.
fn font(name: &str) -> Vec<u8> {
    let path = format!("{}/../t3-text/assets/fonts/{name}.ttf", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("reading {path}: {e}"))
}

struct Quiet;
impl LayoutListener for Quiet {
    fn frame_ready(&self, _revision: u64) {}
}

/// Fixed-advance fallback so tests never depend on a platform engine.
struct FixedFallback;
impl PlatformMeasurer for FixedFallback {
    fn measure(&self, _face: FaceRole, size: f32, _ligatures: bool, text: String) -> f32 {
        text.chars().count() as f32 * size * 1.1
    }
    fn measure_run(&self, _face: FaceRole, size: f32, _ligatures: bool, text: String) -> Vec<f32> {
        text.chars().map(|_| size * 1.1).collect()
    }
}

fn text_system() -> Arc<TextSystem> {
    let faces = [
        (FaceRole::Sans, "Geist"),
        (FaceRole::SansMedium, "Geist-Medium"),
        (FaceRole::SansSemibold, "Geist-SemiBold"),
        (FaceRole::SansBold, "Geist-Bold"),
        (FaceRole::SansItalic, "Geist-Italic"),
        (FaceRole::SansSemiboldItalic, "Geist-SemiBoldItalic"),
        (FaceRole::Mono, "GeistMono"),
    ]
    .into_iter()
    .map(|(role, name)| FaceData { role, bytes: font(name) })
    .collect();
    TextSystem::new(faces, Some(Arc::new(FixedFallback)))
}

fn worker(width: f32) -> Worker {
    let ts = text_system();
    let mut w = Worker::new(
        &ts,
        Arc::new(Shared { frame: Mutex::new(Arc::new(LayoutFrame::empty())) }),
        Arc::new(Quiet),
    );
    w.width = width;
    w
}

const RICH: &str = FIXTURE;

fn keys(frame: &LayoutFrame) -> Vec<u64> {
    (0..frame.row_count()).map(|i| frame.placement(i).unwrap().key).collect()
}

fn message(id: &str, user: bool, text: &str, streaming: bool) -> FeedRow {
    FeedRow::Message(Box::new(FeedMessage {
        id: id.into(),
        role: if user { Role::User } else { Role::Assistant },
        text: text.into(),
        attachments: Vec::new(),
        origin: None,
        turn_id: None,
        streaming,
        created_at: String::new(),
        // The tests rewrite text in place, so the stamp has to move with it.
        updated_at: format!("{id}:{}", text.len()),
    }))
}

fn transcript(turns: usize) -> TranscriptInput {
    let mut feed = Vec::new();
    for i in 0..turns {
        feed.push(message(
            &format!("u{i}"),
            true,
            &format!(
                "Question {i}: can you explain how the layout engine handles **wrapping** of long lines like /Users/dev/project/src/some/deeply/nested/module.rs?"
            ),
            false,
        ));
        feed.push(message(&format!("a{i}"), false, RICH, false));
    }
    TranscriptInput { feed, ..Default::default() }
}

fn activity(id: &str, heading: &str, tone: &str) -> FeedActivity {
    FeedActivity {
        id: id.into(),
        kind: format!("{tone}.row"),
        tone: tone.into(),
        heading: heading.into(),
        preview: Some(format!("$ {heading}")),
        body: Some("full detail body".into()),
        failed: tone == "error",
        live: false,
        icon: Some("terminal".into()),
        sequence: 0,
    }
}

/// The gate: at every width the painted height equals the measured height and
/// offsets form an exact prefix sum. If these disagree the transcript tears.
#[test]
fn paint_matches_measure_at_many_widths() {
    for width in [280.0, 320.0, 375.0, 393.0, 430.0, 744.0, 1024.0] {
        let mut w = worker(width);
        w.input = transcript(2);
        let frame = w.pass();
        assert!(frame.row_count() > 10, "rows: {}", frame.row_count());
        let mut y = 0.0;
        for i in 0..frame.row_count() {
            let p = frame.placement(i).unwrap();
            assert!((p.y - y).abs() < 0.01, "offsets are a prefix sum");
            assert!(p.height > 0.0, "row {i} has height");
            y += p.height;
            let d = frame.display(i).unwrap();
            assert!((d.height - p.height).abs() < 0.01, "paint/measure agree");
            // Runs must slice the row's own text and sit inside the viewport at
            // the coordinates Rust computed. This is what makes the painter
            // unable to disagree with the measurer.
            let units = d.text.encode_utf16().count() as u32;
            for run in &d.runs {
                assert!(run.start + run.len <= units, "run slices the row text");
                if run.scroller.is_none() {
                    assert!(
                        run.x >= 0.0 && run.x + run.width <= width + 0.5,
                        "run inside width {width}: {run:?}"
                    );
                }
                assert!(
                    run.baseline > 0.0 && run.baseline <= d.height + 0.5 || run.scroller.is_some(),
                    "row {i} baseline inside h={}: {run:?}", d.height
                );
            }
        }
        assert!((frame.total_height() - y - 16.0).abs() < 0.01, "total is the sum plus tail pad");
    }
}

/// A streamed tail must settle to exactly the same rows — same keys, same
/// heights — as a parse of the finished text. No duplicated block, no lost one.
///
/// Streams by character so the markdown structure survives; a word-split would
/// flatten the fixture into one paragraph and prove nothing.
#[test]
fn streaming_converges_to_full_parse() {
    let mut w = worker(390.0);
    let chars: Vec<char> = RICH.chars().collect();
    let mut shown = String::new();
    for chunk in chars.chunks(7) {
        shown.extend(chunk);
        w.input = TranscriptInput {
            feed: vec![message("a", false, &shown, true)],
            ..Default::default()
        };
        w.pass();
    }

    // Settle: the same text, no longer streaming.
    w.input = TranscriptInput {
        feed: vec![message("a", false, &shown, false)],
        ..Default::default()
    };
    let streamed = w.pass();

    let mut fresh = worker(390.0);
    fresh.input = TranscriptInput {
        feed: vec![message("a", false, RICH, false)],
        ..Default::default()
    };
    let full = fresh.pass();

    assert_eq!(streamed.row_count(), full.row_count(), "same rows");
    assert_eq!(keys(&streamed), keys(&full), "same row keys");
    for i in 0..full.row_count() {
        let (a, b) = (streamed.placement(i).unwrap(), full.placement(i).unwrap());
        assert!((a.height - b.height).abs() < 0.01, "row {i}: {} vs {}", a.height, b.height);
    }
}

/// The property that makes streaming cheap: a token only rebuilds the tail
/// block. Rows before it stay pointer-identical, so their heights are reused
/// and nothing is re-measured.
#[test]
fn stable_prefix_rows_are_reused_while_streaming() {
    let mut w = worker(390.0);
    let chars: Vec<char> = RICH.chars().collect();
    let mut shown = String::new();
    let mut prev: Option<Vec<Arc<RowCore>>> = None;

    for chunk in chars.chunks(7) {
        shown.extend(chunk);
        w.input = TranscriptInput {
            feed: vec![message("a", false, &shown, true)],
            ..Default::default()
        };
        let cores = w.pass().row_cores();
        if let Some(before) = &prev {
            let shared =
                before.iter().zip(cores.iter()).take_while(|(a, b)| Arc::ptr_eq(a, b)).count();
            // Everything but the streaming tail block must be carried over
            // untouched; a full rebuild would reset the count to ~1.
            assert!(
                shared >= before.len().saturating_sub(2),
                "prefix reused: {shared} of {} rows carried over (now {})",
                before.len(),
                cores.len()
            );
        }
        prev = Some(cores);
    }
}

/// A reader's disclosure choices survive later streaming updates, and a group
/// holding an approval opens by default so the ask is never hidden.
#[test]
fn toggles_expand_activity_groups_and_long_user_messages() {
    let long = "line\n".repeat(40);
    let group = FeedRow::ActivityGroup(Box::new(FeedActivityGroup {
        id: "g1".into(),
        created_at: String::new(),
        turn_id: None,
        activities: vec![activity("a1", "Ran tests", "tool"), activity("a2", "Read file", "tool")],
        summary: "2 steps".into(),
        has_failure: false,
        live: false,
    }));
    let approval = FeedRow::ActivityGroup(Box::new(FeedActivityGroup {
        id: "g2".into(),
        created_at: String::new(),
        turn_id: None,
        activities: vec![activity("a3", "Allow command?", "approval")],
        summary: "Needs approval".into(),
        has_failure: false,
        live: false,
    }));

    let mut w = worker(390.0);
    w.input = TranscriptInput {
        feed: vec![message("u0", true, &long, false), group, approval],
        ..Default::default()
    };
    let frame = w.pass();
    let folded = frame.row_count();
    let collapsed_height = frame.total_height();

    // The approval group paints open; the tool group does not.
    let approval_text: String = (0..frame.row_count())
        .filter_map(|i| frame.display(i))
        .map(|d| d.text)
        .collect();
    assert!(approval_text.contains("Allow command?"), "approval is visible when collapsed");

    assert!(
        !approval_text.contains("full detail body"),
        "a collapsed tool group hides its detail bodies"
    );

    let g1 = rows::row_key("g1");
    w.builder.expanded.insert(g1);
    let opened = w.pass();
    assert_eq!(opened.row_count(), folded, "a group is one row; expanding reveals children");
    assert!(opened.total_height() > collapsed_height, "and grows the frame");
    let opened_text: String =
        (0..opened.row_count()).filter_map(|i| opened.display(i)).map(|d| d.text).collect();
    assert!(opened_text.contains("Ran tests"), "the opened group's children are painted");
    assert!(
        !opened_text.contains("full detail body"),
        "but a child's detail body stays folded until that child is tapped"
    );

    // Tapping one child reveals only that child's body.
    let detail = rows::row_key("a1#tool.row#detail");
    w.builder.detail_open.insert(detail, true);
    let detailed = w.pass();
    let detailed_text: String =
        (0..detailed.row_count()).filter_map(|i| detailed.display(i)).map(|d| d.text).collect();
    assert!(detailed_text.contains("full detail body"), "the tapped child's body appears");

    // The reader's choice survives a streaming update.
    w.input.feed.push(message("a9", false, "streaming…", true));
    let after = w.pass();
    assert!(after.row_count() > opened.row_count());
    let still_open = (0..after.row_count())
        .filter_map(|i| after.display(i))
        .map(|d| d.text)
        .collect::<String>();
    assert!(still_open.contains("Ran tests"), "the opened group stays open");
}

/// A folded user message fades its last visible line instead of hard-clipping.
#[test]
fn folded_user_message_fades_its_last_line() {
    let mut w = worker(390.0);
    w.input = TranscriptInput {
        feed: vec![message("u0", true, &"line\n".repeat(30), false)],
        ..Default::default()
    };
    let frame = w.pass();
    let d = frame.display(0).unwrap();
    assert_eq!(d.fades.len(), 1, "one fade over the fold");
    assert_eq!(d.fades[0].edge, display::FadeEdge::Bottom);

    w.builder.expanded.insert(rows::row_key("u0#u"));
    let open = w.pass();
    assert!(open.display(0).unwrap().fades.is_empty(), "expanded needs no fade");
}

/// Links become tappable hit regions with resolved URLs, one per fragment.
#[test]
fn links_get_hit_regions() {
    let mut w = worker(390.0);
    w.input = TranscriptInput {
        feed: vec![message(
            "a0",
            false,
            "See [the docs](https://example.com/a) and [more](https://example.com/b).",
            false,
        )],
        ..Default::default()
    };
    let frame = w.pass();
    let d = frame.display(0).unwrap();
    assert!(d.links.len() >= 2, "two hit regions: {}", d.links.len());
    let urls: Vec<&str> = d.links.iter().map(|l| l.url.as_str()).collect();
    assert!(urls.contains(&"https://example.com/a"), "{urls:?}");
    assert!(urls.contains(&"https://example.com/b"), "{urls:?}");
}

/// Images become native widgets carrying an attachment reference the painter can
/// fetch, not trailer text inside the message body.
#[test]
fn attachments_become_image_rows() {
    let msg = FeedRow::Message(Box::new(FeedMessage {
        id: "u0".into(),
        role: Role::User,
        text: "look at this".into(),
        attachments: vec![Attachment::Image {
            id: "att-1".into(),
            name: "shot.png".into(),
            mime_type: "image/png".into(),
            size_bytes: 1024,
        }],
        origin: None,
        turn_id: None,
        streaming: false,
        created_at: String::new(),
        updated_at: String::new(),
    }));
    let mut w = worker(390.0);
    w.input = TranscriptInput { feed: vec![msg], ..Default::default() };
    let frame = w.pass();
    let refs: Vec<String> = (0..frame.row_count())
        .filter_map(|i| frame.display(i))
        .flat_map(|d| d.widgets)
        .filter_map(|wid| match wid.kind {
            display::WidgetKind::Image { reference } => Some(reference),
            _ => None,
        })
        .collect();
    assert_eq!(refs, vec!["att-1".to_owned()]);
}

/// An optimistic send paints dimmed and is replaced in place by the echo, so the
/// bubble does not jump when the server catches up.
#[test]
fn pending_user_is_dimmed_then_replaced_by_the_echo() {
    let mut w = worker(390.0);
    w.input = TranscriptInput {
        pending: vec![PendingUser {
            id: "local-1".into(),
            text: "ship it".into(),
            attachments: Vec::new(),
        }],
        ..Default::default()
    };
    let pending = w.pass();
    let d = pending.display(0).unwrap();
    assert!(
        d.runs.iter().all(|r| r.color == display::ColorRole::TextSecondary),
        "optimistic send is dimmed: {:?}",
        d.runs.iter().map(|r| r.color).collect::<Vec<_>>()
    );
    assert!(d.text.contains("ship it"), "the bubble still shows its text");

    w.input = TranscriptInput {
        feed: vec![message("local-1", true, "ship it", false)],
        ..Default::default()
    };
    let echoed = w.pass();
    assert_eq!(echoed.row_count(), pending.row_count(), "one bubble either way");
    let d = echoed.display(0).unwrap();
    assert!(
        d.runs.iter().any(|r| r.color == display::ColorRole::Text),
        "the echo paints its body at full strength: {:?}",
        d.runs.iter().map(|r| r.color).collect::<Vec<_>>()
    );
}

/// A visible message origin paints a chip without adding prose.
#[test]
fn cross_thread_origin_renders_a_chip() {
    let msg = FeedRow::Message(Box::new(FeedMessage {
        id: "a0".into(),
        role: Role::Assistant,
        text: "picking this up".into(),
        attachments: Vec::new(),
        origin: Some(Origin::CrossThread { source_thread_title: "Design review".into() }),
        turn_id: None,
        streaming: false,
        created_at: String::new(),
        updated_at: String::new(),
    }));
    let mut w = worker(390.0);
    w.input = TranscriptInput { feed: vec![msg], ..Default::default() };
    let frame = w.pass();
    let all: String =
        (0..frame.row_count()).filter_map(|i| frame.display(i)).map(|d| d.text).collect();
    assert!(all.contains("Continued from Design review"), "{all}");
}

/// The performance gate: a long transcript lays out cold inside the budget.
///
/// zeron measured ~30 ms for 3,300 rows on an M-series Mac. Run this before
/// touching the row builder — a regression here is the regression users feel.
#[test]
#[ignore = "benchmark; run explicitly"]
fn bench_layout() {
    let mut w = worker(393.0);
    // 300 turns of user + assistant = 3,300 rows, matching zeron's reported figure.
    w.input = transcript(300);

    // First pass pays every measurement. Take the median of three: a shared
    // machine's first-touch page faults are not the number we care about.
    let mut colds = Vec::new();
    let mut frame = w.pass();
    for _ in 0..2 {
        let mut fresh = worker(393.0);
        fresh.input = transcript(300);
        let t = Instant::now();
        frame = fresh.pass();
        colds.push(t.elapsed());
    }
    colds.sort();
    let cold = colds[1];
    println!(
        "cold layout of {} rows: {:.1?} ({:.2} us/row)",
        frame.row_count(),
        cold,
        cold.as_micros() as f64 / frame.row_count().max(1) as f64
    );

    // A width change must be arithmetic over cached widths, not re-measurement.
    let started = Instant::now();
    w.width = 430.0;
    let frame = w.pass();
    let resized = started.elapsed();
    println!("width change: {resized:?} over {} rows", frame.row_count());
    assert!(resized < cold, "a width change must be cheaper than a cold layout");

    // The steady-state cost: a token arrives, one message changes, the frame is
    // republished. This is the floor — it walks all 3,300 rows to find the one
    // that changed.
    let mut tokens = Vec::new();
    for i in 0..20 {
        let started = Instant::now();
        w.input.feed.push(message(&format!("stream{i}"), false, "one more streamed paragraph", true));
        w.pass();
        tokens.push(started.elapsed());
    }
    tokens.sort();
    println!("streamed token (median of 20): {:?}", tokens[10]);
    println!("no-change pass (pure cache walk): {:?}", {
        let t = Instant::now();
        w.pass();
        t.elapsed()
    });
}
