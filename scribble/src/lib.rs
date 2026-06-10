//! Scribble — classroom PDF annotation core (Rust → WASM).
//! All annotation state, tool logic, undo/redo, hit-testing, and
//! serialization live here. JS is a thin glue layer.

#![forbid(unsafe_code)]

mod export;
mod history;
mod model;

use history::{Command, History};
use model::*;
use wasm_bindgen::prelude::*;
use web_sys::CanvasRenderingContext2d;

/// Must match the `/CA` of the highlight ExtGState in the PDF exporter.
const HIGHLIGHT_ALPHA: f64 = 0.35;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tool {
    Pen,
    Highlighter,
    Text,
    Eraser,
    Shape(ShapeKind),
}

#[wasm_bindgen]
pub struct App {
    doc: Document,
    history: History,
    tool: Tool,
    color: Color,
    pen_width: f32,
    hl_width: f32,
    text_size: f32,
    next_id: u64,
    dirty: bool,
    /// In-progress stroke: (page index, stroke).
    current: Option<(usize, Stroke)>,
    /// In-progress drag-placed shape: (page index, shape).
    current_shape: Option<(usize, Shape)>,
    /// Items removed during an in-progress eraser drag.
    erase_pending: Option<(usize, Vec<Item>)>,
}

#[wasm_bindgen]
impl App {
    #[wasm_bindgen(constructor)]
    pub fn new() -> App {
        App {
            doc: Document::new(),
            history: History::default(),
            tool: Tool::Pen,
            color: Color::Black,
            pen_width: 2.5,
            hl_width: 14.0,
            text_size: 16.0,
            next_id: 1,
            dirty: false,
            current: None,
            current_shape: None,
            erase_pending: None,
        }
    }

    // ---------- setup ----------

    /// Record the SHA-256 (hex) of the loaded PDF. Computed by JS via WebCrypto.
    pub fn set_pdf_sha256(&mut self, hex: &str) -> Result<(), String> {
        if hex.len() > 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("invalid sha256".to_string());
        }
        self.doc.pdf_sha256 = hex.to_ascii_lowercase();
        Ok(())
    }

    pub fn pdf_sha256(&self) -> String {
        self.doc.pdf_sha256.clone()
    }

    /// Register a page's size (PDF coordinates at scale 1).
    pub fn ensure_page(&mut self, index: usize, width: f32, height: f32) -> Result<(), String> {
        if index >= MAX_PAGES {
            return Err("too many pages".to_string());
        }
        if !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
            || width > MAX_PAGE_DIM
            || height > MAX_PAGE_DIM
        {
            return Err("invalid page size".to_string());
        }
        while self.doc.pages.len() <= index {
            self.doc.pages.push(Page::empty());
        }
        let page = &mut self.doc.pages[index];
        page.width = width;
        page.height = height;
        Ok(())
    }

    // ---------- tool state ----------

    pub fn set_tool(&mut self, name: &str) -> bool {
        self.tool = match name {
            "pen" => Tool::Pen,
            "highlighter" => Tool::Highlighter,
            "text" => Tool::Text,
            "eraser" => Tool::Eraser,
            "circle" => Tool::Shape(ShapeKind::Circle),
            "arrow" => Tool::Shape(ShapeKind::Arrow),
            "tick" => Tool::Shape(ShapeKind::Tick),
            "cross" => Tool::Shape(ShapeKind::Cross),
            _ => return false,
        };
        true
    }

    /// Pen / shape stroke width by named size.
    pub fn set_pen_width(&mut self, name: &str) -> bool {
        self.pen_width = match name {
            "thin" => 1.5,
            "medium" => 2.5,
            "thick" => 4.5,
            _ => return false,
        };
        true
    }

    pub fn set_color(&mut self, name: &str) -> bool {
        match Color::from_name(name) {
            Some(c) => {
                self.color = c;
                true
            }
            None => false,
        }
    }

    // ---------- pointer input (page coordinates, scale 1) ----------

    pub fn pointer_down(&mut self, page: usize, x: f32, y: f32, erase_radius: f32) {
        if page >= self.doc.pages.len() || !x.is_finite() || !y.is_finite() {
            return;
        }
        match self.tool {
            Tool::Pen | Tool::Highlighter => {
                let (kind, width) = if self.tool == Tool::Pen {
                    (PenKind::Pen, self.pen_width)
                } else {
                    (PenKind::Highlighter, self.hl_width)
                };
                let (px, py) = self.clamp_to_page(page, x, y);
                self.current = Some((
                    page,
                    Stroke {
                        id: self.next_id,
                        kind,
                        color: self.color,
                        width,
                        points: vec![[px, py]],
                    },
                ));
            }
            Tool::Shape(kind) => {
                let (px, py) = self.clamp_to_page(page, x, y);
                self.current_shape = Some((
                    page,
                    Shape {
                        id: self.next_id,
                        kind,
                        color: self.color,
                        width: self.pen_width,
                        rect: [px, py, px, py],
                    },
                ));
            }
            Tool::Eraser => {
                self.erase_pending = Some((page, Vec::new()));
                self.erase_at(page, x, y, erase_radius);
            }
            Tool::Text => {}
        }
    }

    pub fn pointer_move(&mut self, x: f32, y: f32, erase_radius: f32) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        if let Some((page, _)) = self.current {
            let (px, py) = self.clamp_to_page(page, x, y);
            if let Some((_, s)) = &mut self.current {
                if s.points.len() < MAX_POINTS_PER_STROKE {
                    s.points.push([px, py]);
                }
            }
        } else if let Some((page, _)) = self.current_shape {
            let (px, py) = self.clamp_to_page(page, x, y);
            if let Some((_, s)) = &mut self.current_shape {
                s.rect[2] = px;
                s.rect[3] = py;
            }
        } else if let Some((page, _)) = self.erase_pending {
            self.erase_at(page, x, y, erase_radius);
        }
    }

    pub fn pointer_up(&mut self) {
        if let Some((page, stroke)) = self.current.take() {
            self.commit(page, Item::Stroke(stroke));
        }
        if let Some((page, mut shape)) = self.current_shape.take() {
            // A click without a drag places a sensibly sized default marker.
            const MIN_DRAG: f32 = 4.0;
            const DEFAULT_SIZE: f32 = 18.0;
            if (shape.rect[2] - shape.rect[0]).abs() < MIN_DRAG
                && (shape.rect[3] - shape.rect[1]).abs() < MIN_DRAG
            {
                shape.rect[2] = shape.rect[0] + DEFAULT_SIZE;
                shape.rect[3] = shape.rect[1] - DEFAULT_SIZE;
            }
            self.commit(page, Item::Shape(shape));
        }
        if let Some((page, removed)) = self.erase_pending.take() {
            if !removed.is_empty() {
                self.history.push(Command::Remove {
                    page,
                    items: removed,
                });
                self.dirty = true;
            }
        }
    }

    /// Cancel any in-progress stroke/shape/erase (e.g. pointer left the canvas).
    pub fn pointer_cancel(&mut self) {
        self.current = None;
        self.current_shape = None;
        // Committed erasures stay; record them so undo works.
        if let Some((page, removed)) = self.erase_pending.take() {
            if !removed.is_empty() {
                self.history.push(Command::Remove {
                    page,
                    items: removed,
                });
                self.dirty = true;
            }
        }
    }

    // ---------- text ----------

    pub fn add_text(&mut self, page: usize, x: f32, y: f32, content: &str) -> Result<(), String> {
        if page >= self.doc.pages.len() {
            return Err("no such page".to_string());
        }
        if self.doc.pages[page].items.len() >= MAX_ITEMS_PER_PAGE {
            return Err("page is full".to_string());
        }
        if !x.is_finite() || !y.is_finite() {
            return Err("invalid position".to_string());
        }
        let content: String = content
            .chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .take(MAX_TEXT_LEN)
            .collect();
        if content.trim().is_empty() {
            return Ok(());
        }
        let (px, py) = self.clamp_to_page(page, x, y);
        let item = Item::Text(Text {
            id: self.next_id,
            pos: [px, py],
            content,
            color: self.color,
            size: self.text_size,
        });
        self.next_id += 1;
        self.doc.pages[page].items.push(item.clone());
        self.history.push(Command::Add { page, item });
        self.dirty = true;
        Ok(())
    }

    // ---------- undo / redo ----------

    pub fn undo(&mut self) {
        if let Some(cmd) = self.history.pop_undo() {
            match cmd {
                Command::Add { page, item } => self.remove_by_id(page, item.id()),
                Command::Remove { page, items } => self.re_add(page, items),
            }
            self.dirty = true;
        }
    }

    pub fn redo(&mut self) {
        if let Some(cmd) = self.history.pop_redo() {
            match cmd {
                Command::Add { page, item } => self.re_add(page, vec![item]),
                Command::Remove { page, items } => {
                    for it in &items {
                        self.remove_by_id(page, it.id());
                    }
                }
            }
            self.dirty = true;
        }
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    // ---------- save / load ----------

    pub fn save_json(&mut self) -> Result<String, String> {
        let s = serde_json::to_string(&self.doc).map_err(|e| format!("serialize failed: {e}"))?;
        self.dirty = false;
        Ok(s)
    }

    /// Load annotations from JSON. Input is treated as hostile: size-capped,
    /// strictly parsed, fully validated. On any error the current document is
    /// left untouched.
    pub fn load_json(&mut self, json: &str) -> Result<(), String> {
        if json.len() > MAX_JSON_BYTES {
            return Err("file too large".to_string());
        }
        let mut doc: Document =
            serde_json::from_str(json).map_err(|_| "not a valid annotation file".to_string())?;
        validate(&mut doc)?;
        self.next_id = max_id(&doc) + 1;
        self.doc = doc;
        self.history.clear();
        self.current = None;
        self.erase_pending = None;
        self.dirty = false;
        Ok(())
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn page_count(&self) -> usize {
        self.doc.pages.len()
    }

    // ---------- rendering ----------

    /// Draw all annotations for `page` onto the (already cleared) annotation
    /// canvas context at the given zoom scale.
    pub fn render(&self, ctx: &CanvasRenderingContext2d, page: usize, scale: f64) {
        let Some(p) = self.doc.pages.get(page) else {
            return;
        };
        if !(0.05..=20.0).contains(&scale) {
            return;
        }
        ctx.save();
        ctx.scale(scale, scale).ok();
        ctx.set_line_cap("round");
        ctx.set_line_join("round");
        for item in &p.items {
            draw_item(ctx, item);
        }
        if let Some((cur_page, stroke)) = &self.current {
            if *cur_page == page {
                draw_stroke(ctx, stroke);
            }
        }
        if let Some((cur_page, shape)) = &self.current_shape {
            if *cur_page == page {
                draw_shape(ctx, shape);
            }
        }
        ctx.restore();
    }

    // ---------- PDF export ----------

    /// Vector PDF content-stream operators for all annotations on `page`.
    /// The host embeds these after drawing the page image; it must register
    /// the resources named by `highlight_gstate_name()` / `text_font_name()`.
    pub fn export_pdf_ops(&self, page: usize) -> String {
        self.doc
            .pages
            .get(page)
            .map(export::page_ops)
            .unwrap_or_default()
    }

    pub fn highlight_gstate_name(&self) -> String {
        export::HIGHLIGHT_GSTATE.to_string()
    }

    pub fn text_font_name(&self) -> String {
        export::TEXT_FONT.to_string()
    }

    // ---------- internals ----------

    fn clamp_to_page(&self, page: usize, x: f32, y: f32) -> (f32, f32) {
        match self.doc.pages.get(page) {
            Some(p) if p.width > 0.0 && p.height > 0.0 => {
                (x.clamp(0.0, p.width), y.clamp(0.0, p.height))
            }
            _ => (x.clamp(0.0, MAX_PAGE_DIM), y.clamp(0.0, MAX_PAGE_DIM)),
        }
    }

    /// Append a finished item to its page and record it for undo.
    fn commit(&mut self, page: usize, item: Item) {
        self.next_id = self.next_id.max(item.id() + 1);
        if page < self.doc.pages.len() && self.doc.pages[page].items.len() < MAX_ITEMS_PER_PAGE {
            self.doc.pages[page].items.push(item.clone());
            self.history.push(Command::Add { page, item });
            self.dirty = true;
        }
    }

    fn remove_by_id(&mut self, page: usize, id: u64) {
        if let Some(p) = self.doc.pages.get_mut(page) {
            p.items.retain(|it| it.id() != id);
        }
    }

    fn re_add(&mut self, page: usize, items: Vec<Item>) {
        if let Some(p) = self.doc.pages.get_mut(page) {
            for item in items {
                if p.items.len() < MAX_ITEMS_PER_PAGE {
                    p.items.push(item);
                }
            }
        }
    }

    fn erase_at(&mut self, page: usize, x: f32, y: f32, radius: f32) {
        let radius = if radius.is_finite() {
            radius.clamp(1.0, 100.0)
        } else {
            8.0
        };
        let Some(p) = self.doc.pages.get_mut(page) else {
            return;
        };
        let mut removed = Vec::new();
        p.items.retain(|item| {
            let hit = match item {
                Item::Stroke(s) => stroke_hit(s, x, y, radius),
                Item::Text(t) => text_hit(t, x, y, radius),
                Item::Shape(s) => shape_hit(s, x, y, radius),
            };
            if hit {
                removed.push(item.clone());
            }
            !hit
        });
        if let Some((_, pending)) = &mut self.erase_pending {
            pending.extend(removed);
        }
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- hit testing ----------

fn dist_sq_point_segment(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (dx, dy) = (bx - ax, by - ay);
    let len_sq = dx * dx + dy * dy;
    let t = if len_sq <= f32::EPSILON {
        0.0
    } else {
        (((px - ax) * dx + (py - ay) * dy) / len_sq).clamp(0.0, 1.0)
    };
    let (cx, cy) = (ax + t * dx, ay + t * dy);
    (px - cx) * (px - cx) + (py - cy) * (py - cy)
}

fn stroke_hit(s: &Stroke, x: f32, y: f32, radius: f32) -> bool {
    let r = radius + s.width * 0.5;
    let r_sq = r * r;
    if s.points.len() == 1 {
        let p = s.points[0];
        let (dx, dy) = (x - p[0], y - p[1]);
        return dx * dx + dy * dy <= r_sq;
    }
    s.points
        .windows(2)
        .any(|w| dist_sq_point_segment(x, y, w[0][0], w[0][1], w[1][0], w[1][1]) <= r_sq)
}

fn shape_hit(s: &Shape, x: f32, y: f32, radius: f32) -> bool {
    // Bounding-box test, padded by the eraser radius (consistent with text).
    let (x0, x1) = (s.rect[0].min(s.rect[2]), s.rect[0].max(s.rect[2]));
    let (y0, y1) = (s.rect[1].min(s.rect[3]), s.rect[1].max(s.rect[3]));
    x >= x0 - radius && x <= x1 + radius && y >= y0 - radius && y <= y1 + radius
}

fn text_hit(t: &Text, x: f32, y: f32, radius: f32) -> bool {
    // Approximate bounding box (canvas text metrics unavailable here).
    let w = t.content.chars().count() as f32 * t.size * 0.6;
    let h = t.size * 1.2;
    let (x0, y0) = (t.pos[0] - radius, t.pos[1] - h - radius);
    let (x1, y1) = (t.pos[0] + w + radius, t.pos[1] + radius);
    x >= x0 && x <= x1 && y >= y0 && y <= y1
}

// ---------- drawing ----------

fn draw_item(ctx: &CanvasRenderingContext2d, item: &Item) {
    match item {
        Item::Stroke(s) => draw_stroke(ctx, s),
        Item::Text(t) => draw_text(ctx, t),
        Item::Shape(s) => draw_shape(ctx, s),
    }
}

fn draw_shape(ctx: &CanvasRenderingContext2d, s: &Shape) {
    let [x0, y0, x1, y1] = s.rect.map(f64::from);
    let (lo_x, hi_x) = (x0.min(x1), x0.max(x1));
    let (lo_y, hi_y) = (y0.min(y1), y0.max(y1));
    ctx.save();
    ctx.set_stroke_style_str(s.color.css());
    ctx.set_line_width(f64::from(s.width));
    ctx.begin_path();
    match s.kind {
        ShapeKind::Circle => {
            let (cx, cy) = ((lo_x + hi_x) / 2.0, (lo_y + hi_y) / 2.0);
            let (rx, ry) = ((hi_x - lo_x) / 2.0, (hi_y - lo_y) / 2.0);
            ctx.ellipse(cx, cy, rx, ry, 0.0, 0.0, std::f64::consts::TAU)
                .ok();
        }
        ShapeKind::Arrow => {
            ctx.move_to(x0, y0);
            ctx.line_to(x1, y1);
            let ang = (y1 - y0).atan2(x1 - x0);
            let head = (10.0 + f64::from(s.width) * 2.0).min(24.0);
            for da in [2.6_f64, -2.6_f64] {
                ctx.move_to(x1, y1);
                ctx.line_to(x1 + head * (ang + da).cos(), y1 + head * (ang + da).sin());
            }
        }
        ShapeKind::Tick => {
            let (w, h) = (hi_x - lo_x, hi_y - lo_y);
            ctx.move_to(lo_x, lo_y + 0.55 * h);
            ctx.line_to(lo_x + 0.35 * w, hi_y);
            ctx.line_to(hi_x, lo_y + 0.08 * h);
        }
        ShapeKind::Cross => {
            ctx.move_to(lo_x, lo_y);
            ctx.line_to(hi_x, hi_y);
            ctx.move_to(hi_x, lo_y);
            ctx.line_to(lo_x, hi_y);
        }
    }
    ctx.stroke();
    ctx.restore();
}

fn draw_stroke(ctx: &CanvasRenderingContext2d, s: &Stroke) {
    if s.points.is_empty() {
        return;
    }
    ctx.save();
    if s.kind == PenKind::Highlighter {
        ctx.set_global_alpha(HIGHLIGHT_ALPHA);
        ctx.set_global_composite_operation("multiply").ok();
    }
    ctx.set_stroke_style_str(s.color.css());
    ctx.set_line_width(s.width as f64);
    ctx.begin_path();
    ctx.move_to(s.points[0][0] as f64, s.points[0][1] as f64);
    if s.points.len() == 1 {
        // Dot: tiny segment so round caps render it.
        ctx.line_to(s.points[0][0] as f64 + 0.1, s.points[0][1] as f64);
    } else {
        for p in &s.points[1..] {
            ctx.line_to(p[0] as f64, p[1] as f64);
        }
    }
    ctx.stroke();
    ctx.restore();
}

fn draw_text(ctx: &CanvasRenderingContext2d, t: &Text) {
    ctx.save();
    ctx.set_fill_style_str(t.color.css());
    // Font string built only from a clamped number + fixed family. Text content
    // goes through fill_text (pure canvas drawing) — XSS is structurally impossible.
    ctx.set_font(&format!(
        "{}px sans-serif",
        t.size.clamp(MIN_TEXT_SIZE, MAX_TEXT_SIZE)
    ));
    let line_h = (t.size * 1.25) as f64;
    for (i, line) in t.content.split('\n').enumerate() {
        ctx.fill_text(line, t.pos[0] as f64, t.pos[1] as f64 + i as f64 * line_h)
            .ok();
    }
    ctx.restore();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_with_page() -> App {
        let mut a = App::new();
        a.ensure_page(0, 600.0, 800.0).unwrap();
        a
    }

    #[test]
    fn draw_undo_redo() {
        let mut a = app_with_page();
        a.pointer_down(0, 10.0, 10.0, 8.0);
        a.pointer_move(20.0, 20.0, 8.0);
        a.pointer_up();
        assert_eq!(a.doc.pages[0].items.len(), 1);
        a.undo();
        assert_eq!(a.doc.pages[0].items.len(), 0);
        a.redo();
        assert_eq!(a.doc.pages[0].items.len(), 1);
    }

    #[test]
    fn eraser_removes_and_undoes() {
        let mut a = app_with_page();
        a.pointer_down(0, 10.0, 10.0, 8.0);
        a.pointer_move(20.0, 20.0, 8.0);
        a.pointer_up();
        a.set_tool("eraser");
        a.pointer_down(0, 15.0, 15.0, 8.0);
        a.pointer_up();
        assert_eq!(a.doc.pages[0].items.len(), 0);
        a.undo();
        assert_eq!(a.doc.pages[0].items.len(), 1);
    }

    #[test]
    fn text_sanitized_and_capped() {
        let mut a = app_with_page();
        a.add_text(0, 5.0, 5.0, "hi\u{0007}there\nline2").unwrap();
        if let Item::Text(t) = &a.doc.pages[0].items[0] {
            assert_eq!(t.content, "hithere\nline2");
        } else {
            panic!()
        }
        // whitespace-only text is ignored
        a.add_text(0, 5.0, 5.0, "   ").unwrap();
        assert_eq!(a.doc.pages[0].items.len(), 1);
    }

    #[test]
    fn save_load_roundtrip_via_api() {
        let mut a = app_with_page();
        a.set_pdf_sha256("AB12CD").unwrap();
        a.pointer_down(0, 10.0, 10.0, 8.0);
        a.pointer_up();
        let json = a.save_json().unwrap();
        assert!(!a.is_dirty());
        let mut b = App::new();
        b.load_json(&json).unwrap();
        assert_eq!(b.page_count(), 1);
        assert_eq!(b.pdf_sha256(), "ab12cd");
        assert_eq!(b.doc.pages[0].items.len(), 1);
    }

    #[test]
    fn hostile_json_rejected_doc_untouched() {
        let mut a = app_with_page();
        a.pointer_down(0, 10.0, 10.0, 8.0);
        a.pointer_up();
        for bad in [
            "not json",
            r#"{"version":1,"pdf_sha256":"<x>","pages":[]}"#,
            r#"{"version":1,"pdf_sha256":"","pages":[{"width":1e30,"height":10,"items":[]}]}"#,
            r#"{"version":2,"pdf_sha256":"","pages":[]}"#,
        ] {
            assert!(a.load_json(bad).is_err());
        }
        assert_eq!(a.doc.pages[0].items.len(), 1);
    }

    #[test]
    fn shape_commit_export_undo() {
        let mut a = app_with_page();
        assert!(a.set_tool("circle"));
        assert!(a.set_pen_width("thick"));
        a.pointer_down(0, 50.0, 50.0, 8.0);
        a.pointer_move(120.0, 100.0, 8.0);
        a.pointer_up();
        assert_eq!(a.doc.pages[0].items.len(), 1);
        let ops = a.export_pdf_ops(0);
        assert!(ops.contains(" c\n"), "circle should emit Bézier ops");
        a.undo();
        assert!(a.export_pdf_ops(0).is_empty());
        a.redo();
        assert_eq!(a.doc.pages[0].items.len(), 1);
    }

    #[test]
    fn click_places_default_sized_shape() {
        let mut a = app_with_page();
        a.set_tool("tick");
        a.pointer_down(0, 300.0, 300.0, 8.0);
        a.pointer_up();
        match &a.doc.pages[0].items[0] {
            Item::Shape(s) => assert!((s.rect[2] - s.rect[0]).abs() > 4.0),
            other => panic!("expected shape, got {other:?}"),
        }
    }

    #[test]
    fn export_ops_cover_highlight_and_text() {
        let mut a = app_with_page();
        a.set_tool("highlighter");
        a.pointer_down(0, 10.0, 10.0, 8.0);
        a.pointer_move(60.0, 10.0, 8.0);
        a.pointer_up();
        a.add_text(0, 20.0, 40.0, "ok (5/5)").unwrap();
        let ops = a.export_pdf_ops(0);
        assert!(ops.contains(&format!("/{} gs", a.highlight_gstate_name())));
        assert!(ops.contains(&format!("/{} ", a.text_font_name())));
        assert!(ops.contains(r"(ok \(5/5\)) Tj"));
    }

    #[test]
    fn shape_survives_save_load() {
        let mut a = app_with_page();
        a.set_tool("arrow");
        a.pointer_down(0, 10.0, 80.0, 8.0);
        a.pointer_move(90.0, 20.0, 8.0);
        a.pointer_up();
        let json = a.save_json().unwrap();
        let mut b = App::new();
        b.load_json(&json).unwrap();
        assert!(matches!(b.doc.pages[0].items[0], Item::Shape(_)));
        // eraser can remove it
        b.set_tool("eraser");
        b.pointer_down(0, 50.0, 50.0, 8.0);
        b.pointer_up();
        assert!(b.doc.pages[0].items.is_empty());
    }

    #[test]
    fn out_of_range_input_ignored() {
        let mut a = app_with_page();
        a.pointer_down(5, 10.0, 10.0, 8.0); // no such page
        a.pointer_up();
        assert_eq!(a.page_count(), 1);
        a.pointer_down(0, f32::NAN, 10.0, 8.0);
        a.pointer_up();
        assert_eq!(a.doc.pages[0].items.len(), 0);
    }
}
