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
pub const MAX_JSON_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Color {
    Black,
    Red,
    Blue,
    Green,
    Yellow,
}

impl Color {
    /// Closed enum -> fixed CSS strings. User input can never inject CSS.
    pub fn css(self) -> &'static str {
        match self {
            Color::Black => "#1a1a1a",
            Color::Red => "#d32f2f",
            Color::Blue => "#1565c0",
            Color::Green => "#2e7d32",
            Color::Yellow => "#f9d000",
        }
    }

    /// RGB components in `0..=1`, matching [`Color::css`]. Used for PDF export.
    pub fn rgb(self) -> (f32, f32, f32) {
        match self {
            Color::Black => (0.102, 0.102, 0.102),
            Color::Red => (0.827, 0.184, 0.184),
            Color::Blue => (0.082, 0.396, 0.753),
            Color::Green => (0.180, 0.490, 0.196),
            Color::Yellow => (0.976, 0.816, 0.000),
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub version: u32,
    pub pdf_sha256: String,
    pub pages: Vec<Page>,
}

impl Document {
    pub fn new() -> Self {
        Document {
            version: DOC_VERSION,
            pdf_sha256: String::new(),
            pages: Vec::new(),
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
    let mut seen_ids = std::collections::HashSet::new();
    for page in &mut doc.pages {
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
                    if t.content.chars().any(|c| c.is_control() && c != '\n') {
                        return Err("control characters in text".into());
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
    }
    Ok(())
}

/// Highest item id in the document (0 if none).
pub fn max_id(doc: &Document) -> u64 {
    doc.pages
        .iter()
        .flat_map(|p| p.items.iter().map(Item::id))
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
        }
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
