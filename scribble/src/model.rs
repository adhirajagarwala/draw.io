//! Document model + strict validation. All loaded data is treated as hostile.

use serde::{Deserialize, Serialize};

pub const DOC_VERSION: u32 = 1;
pub const MAX_PAGES: usize = 500;
pub const MAX_ITEMS_PER_PAGE: usize = 5_000;
pub const MAX_POINTS_PER_STROKE: usize = 10_000;
pub const MAX_TEXT_LEN: usize = 500;
pub const MIN_STROKE_WIDTH: f32 = 0.5;
pub const MAX_STROKE_WIDTH: f32 = 30.0;
pub const MIN_TEXT_SIZE: f32 = 6.0;
pub const MAX_TEXT_SIZE: f32 = 72.0;
pub const MAX_PAGE_DIM: f32 = 20_000.0;
pub const MAX_JSON_BYTES: usize = 30 * 1024 * 1024;
pub const MAX_NOTE_BLOCKS: usize = 500;
pub const MAX_NOTE_TEXT_LEN: usize = 20_000;
pub const MAX_CAPTION_LEN: usize = 300;
/// Per-clipping cap on base64 PNG payload (~1.5 MB of image data).
pub const MAX_CLIPPING_B64: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Color {
    Black,
    Red,
    Blue,
    Green,
    Yellow,
}

/// Color palette. Files store semantic color *names* (the `Color` enum), so
/// a document made in one palette renders correctly in the other. `Safe` is
/// based on the Okabe–Ito colorblind-safe set (green becomes brown, red
/// becomes vermillion) so red/green confusion never hides meaning.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Palette {
    #[default]
    Standard,
    Safe,
}

impl Palette {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "standard" => Some(Palette::Standard),
            "safe" => Some(Palette::Safe),
            _ => None,
        }
    }
}

impl Color {
    /// Closed enums -> fixed CSS strings. User input can never inject CSS.
    pub fn css(self, p: Palette) -> &'static str {
        match (p, self) {
            (Palette::Standard, Color::Black) => "#1a1a1a",
            (Palette::Standard, Color::Red) => "#d32f2f",
            (Palette::Standard, Color::Blue) => "#1565c0",
            (Palette::Standard, Color::Green) => "#2e7d32",
            (Palette::Standard, Color::Yellow) => "#f9d000",
            (Palette::Safe, Color::Black) => "#1a1a1a",
            (Palette::Safe, Color::Red) => "#d55e00", // vermillion
            (Palette::Safe, Color::Blue) => "#0072b2",
            (Palette::Safe, Color::Green) => "#8c510a", // brown
            (Palette::Safe, Color::Yellow) => "#e69f00",
        }
    }

    /// RGB components in `0..=1`, matching [`Color::css`]. Used for PDF export.
    pub fn rgb(self, p: Palette) -> (f32, f32, f32) {
        match (p, self) {
            (Palette::Standard, Color::Black) => (0.102, 0.102, 0.102),
            (Palette::Standard, Color::Red) => (0.827, 0.184, 0.184),
            (Palette::Standard, Color::Blue) => (0.082, 0.396, 0.753),
            (Palette::Standard, Color::Green) => (0.180, 0.490, 0.196),
            (Palette::Standard, Color::Yellow) => (0.976, 0.816, 0.000),
            (Palette::Safe, Color::Black) => (0.102, 0.102, 0.102),
            (Palette::Safe, Color::Red) => (0.835, 0.369, 0.000),
            (Palette::Safe, Color::Blue) => (0.000, 0.447, 0.698),
            (Palette::Safe, Color::Green) => (0.549, 0.319, 0.039),
            (Palette::Safe, Color::Yellow) => (0.902, 0.624, 0.000),
        }
    }

    /// Lighter, saturated tints used by the highlighter and highlight boxes.
    /// Dark pen colors make unreadable highlights, so each color maps to a
    /// marker-style tint instead (matching [`Color::highlight_css`]).
    pub fn highlight_rgb(self, p: Palette) -> (f32, f32, f32) {
        match (p, self) {
            (Palette::Standard, Color::Black) => (0.62, 0.62, 0.62),
            (Palette::Standard, Color::Red) => (0.957, 0.561, 0.694),
            (Palette::Standard, Color::Blue) => (0.310, 0.765, 0.969),
            (Palette::Standard, Color::Green) => (0.565, 0.933, 0.565),
            (Palette::Standard, Color::Yellow) => (0.976, 0.816, 0.000),
            (Palette::Safe, Color::Black) => (0.62, 0.62, 0.62),
            (Palette::Safe, Color::Red) => (0.969, 0.722, 0.612),
            (Palette::Safe, Color::Blue) => (0.498, 0.769, 0.910),
            (Palette::Safe, Color::Green) => (0.824, 0.651, 0.475),
            (Palette::Safe, Color::Yellow) => (0.941, 0.823, 0.537),
        }
    }

    /// CSS form of [`Color::highlight_rgb`]. Closed enums — fixed strings only.
    pub fn highlight_css(self, p: Palette) -> &'static str {
        match (p, self) {
            (Palette::Standard, Color::Black) => "#9e9e9e",
            (Palette::Standard, Color::Red) => "#f48fb1",
            (Palette::Standard, Color::Blue) => "#4fc3f7",
            (Palette::Standard, Color::Green) => "#90ee90",
            (Palette::Standard, Color::Yellow) => "#f9d000",
            (Palette::Safe, Color::Black) => "#9e9e9e",
            (Palette::Safe, Color::Red) => "#f7b89c",
            (Palette::Safe, Color::Blue) => "#7fc4e8",
            (Palette::Safe, Color::Green) => "#d2a679",
            (Palette::Safe, Color::Yellow) => "#f0d289",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "black" => Some(Color::Black),
            "red" => Some(Color::Red),
            "blue" => Some(Color::Blue),
            "green" => Some(Color::Green),
            "yellow" => Some(Color::Yellow),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum PenKind {
    Pen,
    Highlighter,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stroke {
    pub id: u64,
    pub kind: PenKind,
    pub color: Color,
    pub width: f32,
    pub points: Vec<[f32; 2]>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Text {
    pub id: u64,
    pub pos: [f32; 2],
    pub content: String,
    pub color: Color,
    pub size: f32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum ShapeKind {
    Circle,
    Arrow,
    Tick,
    Cross,
    /// Outlined rectangle.
    Rect,
    /// Filled translucent rectangle (a "highlight box" over a region).
    FillRect,
}

/// A drag-placed marker. `rect` is `[x0, y0, x1, y1]` from drag start to end,
/// in page coordinates; it is not normalized (arrows are directional).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shape {
    pub id: u64,
    pub kind: ShapeKind,
    pub color: Color,
    pub width: f32,
    pub rect: [f32; 4],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Item {
    Stroke(Stroke),
    Text(Text),
    Shape(Shape),
}

impl Item {
    pub fn id(&self) -> u64 {
        match self {
            Item::Stroke(s) => s.id,
            Item::Text(t) => t.id,
            Item::Shape(s) => s.id,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub width: f32,
    pub height: f32,
    pub items: Vec<Item>,
}

impl Page {
    pub fn empty() -> Self {
        Page {
            width: 0.0,
            height: 0.0,
            items: Vec::new(),
        }
    }
}

/// A block in the side-by-side working document ("notes"):
/// - `Text`: a chunk of plain text;
/// - `Clipping`: a region snipped from the paper (base64 PNG);
/// - `Sketch`: a blank annotation canvas you draw on with the full toolset.
///   Its `surface` holds the same [`Page`] structure as a PDF page, so every
///   tool works on it without any special-casing.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum NoteBlock {
    Text {
        content: String,
    },
    Clipping {
        png_b64: String,
        source_page: u32,
        caption: String,
    },
    Sketch {
        surface: Page,
    },
}

/// A drawable surface: either a PDF page (by index) or a sketch note (by its
/// index in `Document::notes`). Not serialized — it only addresses live
/// state and the in-memory undo history.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Surface {
    Pdf(usize),
    Sketch(usize),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub version: u32,
    pub pdf_sha256: String,
    pub pages: Vec<Page>,
    /// Working-document blocks. `default` keeps files from older versions
    /// loading unchanged.
    #[serde(default)]
    pub notes: Vec<NoteBlock>,
}

impl Document {
    pub fn new() -> Self {
        Document {
            version: DOC_VERSION,
            pdf_sha256: String::new(),
            pages: Vec::new(),
            notes: Vec::new(),
        }
    }
}

impl Default for Document {
    fn default() -> Self {
        Self::new()
    }
}

fn finite(v: f32) -> bool {
    v.is_finite()
}

/// Characters that must never appear in note text: control characters
/// (except newline) and Unicode bidirectional/format controls, which can
/// visually reorder surrounding text — a classic spoofing vector when the
/// note is later rendered in a PDF or any other viewer.
pub fn is_forbidden_text_char(c: char) -> bool {
    (c.is_control() && c != '\n')
        || matches!(
            c,
            '\u{200B}'..='\u{200F}'      // zero-width + LRM/RLM
            | '\u{202A}'..='\u{202E}'    // LRE/RLE/PDF/LRO/RLO
            | '\u{2066}'..='\u{2069}'    // LRI/RLI/FSI/PDI
            | '\u{FEFF}'                 // BOM / zero-width no-break space
        )
}

/// Strip forbidden characters and cap length. Used for every path that
/// accepts text typed by (or loaded for) the user.
pub fn sanitize_text(s: &str) -> String {
    sanitize_text_capped(s, MAX_TEXT_LEN)
}

/// As [`sanitize_text`] with an explicit cap (notes blocks are longer).
pub fn sanitize_text_capped(s: &str, cap: usize) -> String {
    s.chars()
        .filter(|c| !is_forbidden_text_char(*c))
        .take(cap)
        .collect()
}

/// Validate a base64 payload: charset only (standard alphabet + padding) and
/// length cap. We never decode it in Rust — the host displays it — so a
/// malformed payload can at worst fail to render as an image.
pub fn valid_b64_png(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_CLIPPING_B64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

/// Strict validation of a deserialized document. Rejects on any violation;
/// never partially applies. Coordinates are clamped to page bounds.
pub fn validate(doc: &mut Document) -> Result<(), String> {
    if doc.version != DOC_VERSION {
        return Err(format!("unsupported file version {}", doc.version));
    }
    if doc.pdf_sha256.len() > 64 || !doc.pdf_sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid pdf hash".into());
    }
    if doc.pages.len() > MAX_PAGES {
        return Err("too many pages".into());
    }
    if doc.notes.len() > MAX_NOTE_BLOCKS {
        return Err("too many note blocks".into());
    }
    for block in &doc.notes {
        match block {
            NoteBlock::Text { content } => {
                if content.chars().count() > MAX_NOTE_TEXT_LEN {
                    return Err("note text too long".into());
                }
                if content.chars().any(is_forbidden_text_char) {
                    return Err("forbidden characters in note".into());
                }
            }
            NoteBlock::Clipping {
                png_b64,
                source_page,
                caption,
            } => {
                if !valid_b64_png(png_b64) {
                    return Err("invalid clipping image data".into());
                }
                if *source_page as usize >= MAX_PAGES {
                    return Err("clipping source page out of range".into());
                }
                if caption.chars().count() > MAX_CAPTION_LEN
                    || caption.chars().any(is_forbidden_text_char)
                {
                    return Err("invalid clipping caption".into());
                }
            }
            // Sketch surfaces are validated in the surface loop below.
            NoteBlock::Sketch { .. } => {}
        }
    }
    let mut seen_ids = std::collections::HashSet::new();
    for page in &mut doc.pages {
        validate_page(page, &mut seen_ids)?;
    }
    // Sketch surfaces are full pages and get the identical treatment, sharing
    // the same id-uniqueness namespace as PDF-page annotations.
    for block in &mut doc.notes {
        if let NoteBlock::Sketch { surface } = block {
            validate_page(surface, &mut seen_ids)?;
        }
    }
    Ok(())
}

/// Validate and clamp a single drawing surface (PDF page or sketch).
fn validate_page(
    page: &mut Page,
    seen_ids: &mut std::collections::HashSet<u64>,
) -> Result<(), String> {
    if !finite(page.width) || !finite(page.height) {
        return Err("non-finite page size".into());
    }
    if page.width < 0.0
        || page.height < 0.0
        || page.width > MAX_PAGE_DIM
        || page.height > MAX_PAGE_DIM
    {
        return Err("page size out of range".into());
    }
    if page.items.len() > MAX_ITEMS_PER_PAGE {
        return Err("too many items on a page".into());
    }
    let (w, h) = (page.width.max(1.0), page.height.max(1.0));
    for item in &mut page.items {
        if !seen_ids.insert(item.id()) {
            return Err("duplicate item id".into());
        }
        match item {
            Item::Stroke(s) => {
                if s.points.is_empty() || s.points.len() > MAX_POINTS_PER_STROKE {
                    return Err("stroke point count out of range".into());
                }
                if !finite(s.width) {
                    return Err("non-finite stroke width".into());
                }
                s.width = s.width.clamp(MIN_STROKE_WIDTH, MAX_STROKE_WIDTH);
                for p in &mut s.points {
                    if !finite(p[0]) || !finite(p[1]) {
                        return Err("non-finite stroke point".into());
                    }
                    p[0] = p[0].clamp(0.0, w);
                    p[1] = p[1].clamp(0.0, h);
                }
            }
            Item::Shape(s) => {
                if !finite(s.width) || s.rect.iter().any(|v| !finite(*v)) {
                    return Err("non-finite shape values".into());
                }
                s.width = s.width.clamp(MIN_STROKE_WIDTH, MAX_STROKE_WIDTH);
                s.rect[0] = s.rect[0].clamp(0.0, w);
                s.rect[1] = s.rect[1].clamp(0.0, h);
                s.rect[2] = s.rect[2].clamp(0.0, w);
                s.rect[3] = s.rect[3].clamp(0.0, h);
            }
            Item::Text(t) => {
                if t.content.chars().count() > MAX_TEXT_LEN {
                    return Err("text too long".into());
                }
                if t.content.chars().any(is_forbidden_text_char) {
                    return Err("forbidden characters in text".into());
                }
                if !finite(t.size) || !finite(t.pos[0]) || !finite(t.pos[1]) {
                    return Err("non-finite text values".into());
                }
                t.size = t.size.clamp(MIN_TEXT_SIZE, MAX_TEXT_SIZE);
                t.pos[0] = t.pos[0].clamp(0.0, w);
                t.pos[1] = t.pos[1].clamp(0.0, h);
            }
        }
    }
    Ok(())
}

/// Highest item id across all surfaces (PDF pages and sketches); 0 if none.
pub fn max_id(doc: &Document) -> u64 {
    let pdf = doc.pages.iter().flat_map(|p| p.items.iter().map(Item::id));
    let sketch = doc.notes.iter().filter_map(|b| match b {
        NoteBlock::Sketch { surface } => Some(surface),
        _ => None,
    });
    pdf.chain(sketch.flat_map(|p| p.items.iter().map(Item::id)))
        .max()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc_with(items: Vec<Item>) -> Document {
        Document {
            version: DOC_VERSION,
            pdf_sha256: "ab12".into(),
            pages: vec![Page {
                width: 600.0,
                height: 800.0,
                items,
            }],
            notes: Vec::new(),
        }
    }

    #[test]
    fn notes_validation() {
        let mut d = doc_with(vec![]);
        d.notes.push(NoteBlock::Text {
            content: "good point about Q3\nfollow up".into(),
        });
        d.notes.push(NoteBlock::Clipping {
            png_b64: "iVBORw0KGgoAAAANSUhEUg==".into(),
            source_page: 2,
            caption: "eq. 4".into(),
        });
        assert!(validate(&mut d).is_ok());

        // hostile payloads rejected
        d.notes.push(NoteBlock::Clipping {
            png_b64: "<script>".into(),
            source_page: 0,
            caption: String::new(),
        });
        assert!(validate(&mut d).is_err());
        d.notes.pop();
        d.notes.push(NoteBlock::Text {
            content: "evil \u{202E}".into(),
        });
        assert!(validate(&mut d).is_err());
    }

    #[test]
    fn old_files_without_notes_still_load() {
        let json = r#"{"version":1,"pdf_sha256":"","pages":[]}"#;
        let mut d: Document = serde_json::from_str(json).unwrap();
        assert!(validate(&mut d).is_ok());
        assert!(d.notes.is_empty());
    }

    #[test]
    fn accepts_valid_doc() {
        let mut d = doc_with(vec![Item::Stroke(Stroke {
            id: 1,
            kind: PenKind::Pen,
            color: Color::Red,
            width: 2.0,
            points: vec![[1.0, 2.0], [3.0, 4.0]],
        })]);
        assert!(validate(&mut d).is_ok());
    }

    #[test]
    fn rejects_bad_version() {
        let mut d = doc_with(vec![]);
        d.version = 99;
        assert!(validate(&mut d).is_err());
    }

    #[test]
    fn rejects_nonfinite_point() {
        let mut d = doc_with(vec![Item::Stroke(Stroke {
            id: 1,
            kind: PenKind::Pen,
            color: Color::Red,
            width: 2.0,
            points: vec![[f32::NAN, 2.0]],
        })]);
        assert!(validate(&mut d).is_err());
    }

    #[test]
    fn rejects_empty_stroke_and_dup_ids() {
        let mut d = doc_with(vec![Item::Stroke(Stroke {
            id: 1,
            kind: PenKind::Pen,
            color: Color::Red,
            width: 2.0,
            points: vec![],
        })]);
        assert!(validate(&mut d).is_err());

        let s = Stroke {
            id: 7,
            kind: PenKind::Pen,
            color: Color::Red,
            width: 2.0,
            points: vec![[0.0, 0.0]],
        };
        let mut d2 = doc_with(vec![Item::Stroke(s.clone()), Item::Stroke(s)]);
        assert!(validate(&mut d2).is_err());
    }

    #[test]
    fn rejects_long_text_and_clamps_coords() {
        let mut d = doc_with(vec![Item::Text(Text {
            id: 1,
            pos: [99999.0, -5.0],
            content: "<script>alert(1)</script>".into(),
            color: Color::Black,
            size: 200.0,
        })]);
        assert!(validate(&mut d).is_ok());
        if let Item::Text(t) = &d.pages[0].items[0] {
            assert_eq!(t.pos, [600.0, 0.0]);
            assert_eq!(t.size, MAX_TEXT_SIZE);
            // content preserved verbatim (rendered via canvas fillText, never HTML)
            assert!(t.content.contains("<script>"));
        } else {
            panic!()
        }

        let mut d2 = doc_with(vec![Item::Text(Text {
            id: 1,
            pos: [0.0, 0.0],
            content: "x".repeat(MAX_TEXT_LEN + 1),
            color: Color::Black,
            size: 12.0,
        })]);
        assert!(validate(&mut d2).is_err());
    }

    #[test]
    fn sanitize_strips_hostile_characters() {
        // Controls (NUL, bell, escape, DEL), bidi overrides, zero-width
        // characters, and the BOM are all removed; newline survives.
        let hostile = "a\u{0}\u{7}\u{1b}\u{7f}b\u{202E}evil\u{2066}c\u{200B}\u{FEFF}\nd";
        assert_eq!(sanitize_text(hostile), "abevilc\nd");
        // Length cap applies after filtering.
        assert_eq!(
            sanitize_text(&"x".repeat(MAX_TEXT_LEN + 50)).len(),
            MAX_TEXT_LEN
        );
    }

    #[test]
    fn validate_rejects_bidi_in_loaded_files() {
        let mut d = doc_with(vec![Item::Text(Text {
            id: 1,
            pos: [10.0, 10.0],
            content: "pay \u{202E}001\u{202C} dollars".into(),
            color: Color::Black,
            size: 12.0,
        })]);
        assert!(validate(&mut d).is_err());
    }

    #[test]
    fn rejects_unknown_fields() {
        let json = r#"{"version":1,"pdf_sha256":"","pages":[],"evil":true}"#;
        assert!(serde_json::from_str::<Document>(json).is_err());
    }

    #[test]
    fn save_load_roundtrip() {
        let mut d = doc_with(vec![Item::Text(Text {
            id: 3,
            pos: [10.0, 20.0],
            content: "marks: 5/10 ✓".into(),
            color: Color::Green,
            size: 14.0,
        })]);
        validate(&mut d).unwrap();
        let s = serde_json::to_string(&d).unwrap();
        let mut back: Document = serde_json::from_str(&s).unwrap();
        validate(&mut back).unwrap();
        assert_eq!(serde_json::to_string(&back).unwrap(), s);
        assert_eq!(max_id(&back), 3);
    }
}
