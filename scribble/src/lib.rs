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
    /// Pick, move and edit existing annotations (handled by the host UI
    /// through the item-drag API; the tool itself draws nothing).
    Select,
    Pen,
    Highlighter,
    Text,
    Eraser,
    Shape(ShapeKind),
}

/// State of an in-progress move of an existing item.
struct DragState {
    surface: Surface,
    id: u64,
    /// Item as it was when the drag began (for undo and for cancel).
    original: Item,
    /// Pointer position where the item was grabbed.
    grab: (f32, f32),
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
    /// In-progress stroke: (surface, stroke).
    current: Option<(Surface, Stroke)>,
    /// In-progress drag-placed shape: (surface, shape).
    current_shape: Option<(Surface, Shape)>,
    /// Items removed during an in-progress eraser drag: (surface, items).
    erase_pending: Option<(Surface, Vec<(usize, Item)>)>,
    /// Existing item being moved or resized with the select tool.
    item_drag: Option<DragState>,
    /// Active color palette (display preference; files store color names).
    palette: Palette,
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
            item_drag: None,
            palette: Palette::Standard,
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
            "select" => Tool::Select,
            "pen" => Tool::Pen,
            "highlighter" => Tool::Highlighter,
            "text" => Tool::Text,
            "eraser" => Tool::Eraser,
            "circle" => Tool::Shape(ShapeKind::Circle),
            "arrow" => Tool::Shape(ShapeKind::Arrow),
            "tick" => Tool::Shape(ShapeKind::Tick),
            "cross" => Tool::Shape(ShapeKind::Cross),
            "rect" => Tool::Shape(ShapeKind::Rect),
            "fillrect" => Tool::Shape(ShapeKind::FillRect),
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

    /// Switch display palette ("standard" | "safe"). Colors in files are
    /// semantic names, so this changes rendering only — never the document.
    pub fn set_palette(&mut self, name: &str) -> bool {
        match Palette::from_name(name) {
            Some(p) => {
                self.palette = p;
                true
            }
            None => false,
        }
    }

    /// Display color (CSS) of `name` under the active palette, for swatches.
    pub fn color_css(&self, name: &str) -> String {
        Color::from_name(name)
            .map(|c| c.css(self.palette).to_string())
            .unwrap_or_default()
    }

    // ---------- pointer input (page coordinates, scale 1) ----------

    /// Pointer press on a PDF page.
    pub fn pointer_down(&mut self, page: usize, x: f32, y: f32, erase_radius: f32) {
        self.pointer_down_on(Surface::Pdf(page), x, y, erase_radius);
    }

    /// Pointer press on a sketch note (by its index in the notes list).
    pub fn pointer_down_sketch(&mut self, note: usize, x: f32, y: f32, erase_radius: f32) {
        self.pointer_down_on(Surface::Sketch(note), x, y, erase_radius);
    }

    fn pointer_down_on(&mut self, surface: Surface, x: f32, y: f32, erase_radius: f32) {
        if !self.surface_exists(surface) || !x.is_finite() || !y.is_finite() {
            return;
        }
        match self.tool {
            Tool::Pen | Tool::Highlighter => {
                let (kind, width) = if self.tool == Tool::Pen {
                    (PenKind::Pen, self.pen_width)
                } else {
                    (PenKind::Highlighter, self.hl_width)
                };
                let (px, py) = self.clamp_to_page(surface, x, y);
                self.current = Some((
                    surface,
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
                let (px, py) = self.clamp_to_page(surface, x, y);
                self.current_shape = Some((
                    surface,
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
                self.erase_pending = Some((surface, Vec::new()));
                self.erase_at(surface, x, y, erase_radius);
            }
            // Select and Text presses are orchestrated by the host UI via
            // find_item / begin_item_drag / add_text.
            Tool::Select | Tool::Text => {}
        }
    }

    pub fn pointer_move(&mut self, x: f32, y: f32, erase_radius: f32) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        if let Some((surface, _)) = self.current {
            let (px, py) = self.clamp_to_page(surface, x, y);
            if let Some((_, s)) = &mut self.current {
                if s.points.len() < MAX_POINTS_PER_STROKE {
                    s.points.push([px, py]);
                }
            }
        } else if let Some((surface, _)) = self.current_shape {
            let (px, py) = self.clamp_to_page(surface, x, y);
            if let Some((_, s)) = &mut self.current_shape {
                s.rect[2] = px;
                s.rect[3] = py;
            }
        } else if let Some((surface, _)) = self.erase_pending {
            self.erase_at(surface, x, y, erase_radius);
        }
    }

    pub fn pointer_up(&mut self) {
        if let Some((surface, stroke)) = self.current.take() {
            self.commit(surface, Item::Stroke(stroke));
        }
        if let Some((surface, mut shape)) = self.current_shape.take() {
            // A click without a drag places a sensibly sized default marker.
            const MIN_DRAG: f32 = 4.0;
            const DEFAULT_SIZE: f32 = 18.0;
            if (shape.rect[2] - shape.rect[0]).abs() < MIN_DRAG
                && (shape.rect[3] - shape.rect[1]).abs() < MIN_DRAG
            {
                shape.rect[2] = shape.rect[0] + DEFAULT_SIZE;
                shape.rect[3] = shape.rect[1] - DEFAULT_SIZE;
            }
            self.commit(surface, Item::Shape(shape));
        }
        if let Some((surface, removed)) = self.erase_pending.take() {
            if !removed.is_empty() {
                self.history.push(Command::Remove {
                    surface,
                    items: removed,
                });
                self.dirty = true;
            }
        }
    }

    /// Cancel any in-progress stroke/shape/drag/erase (e.g. pointer lost).
    pub fn pointer_cancel(&mut self) {
        self.current = None;
        self.current_shape = None;
        // A cancelled move reverts the item to where it started — in place, so it
        // keeps its z-position rather than jumping to the top of the stack.
        if let Some(drag) = self.item_drag.take() {
            self.replace_by_id(drag.surface, drag.original);
        }
        // Committed erasures stay; record them so undo works.
        if let Some((surface, removed)) = self.erase_pending.take() {
            if !removed.is_empty() {
                self.history.push(Command::Remove {
                    surface,
                    items: removed,
                });
                self.dirty = true;
            }
        }
    }

    // ---------- text ----------

    pub fn add_text(&mut self, page: usize, x: f32, y: f32, content: &str) -> Result<(), String> {
        self.add_text_on(Surface::Pdf(page), x, y, content)
    }

    pub fn add_text_sketch(
        &mut self,
        note: usize,
        x: f32,
        y: f32,
        content: &str,
    ) -> Result<(), String> {
        self.add_text_on(Surface::Sketch(note), x, y, content)
    }

    fn add_text_on(
        &mut self,
        surface: Surface,
        x: f32,
        y: f32,
        content: &str,
    ) -> Result<(), String> {
        let full = matches!(self.page_ref(surface), Some(p) if p.items.len() >= MAX_ITEMS_PER_PAGE);
        if self.page_ref(surface).is_none() {
            return Err("no such surface".to_string());
        }
        if full {
            return Err("surface is full".to_string());
        }
        if !x.is_finite() || !y.is_finite() {
            return Err("invalid position".to_string());
        }
        let content = sanitize_text(content);
        if content.trim().is_empty() {
            return Ok(());
        }
        let (px, py) = self.clamp_to_page(surface, x, y);
        let item = Item::Text(Text {
            id: self.next_id,
            pos: [px, py],
            content,
            color: self.color,
            size: self.text_size,
        });
        self.next_id += 1;
        self.commit(surface, item);
        Ok(())
    }

    // ---------- text move / edit ----------
    //
    // Item ids cross the WASM boundary as f64 (avoids BigInt friction in JS);
    // every id is validated as a non-negative integer before use.

    // PDF-page selection API. Each method has a `*_sketch` twin targeting a
    // note sketch; both delegate to one surface-generic implementation.

    pub fn find_item(&self, page: usize, x: f32, y: f32) -> f64 {
        self.find_item_on(Surface::Pdf(page), x, y)
    }
    pub fn find_item_sketch(&self, note: usize, x: f32, y: f32) -> f64 {
        self.find_item_on(Surface::Sketch(note), x, y)
    }
    fn find_item_on(&self, surface: Surface, x: f32, y: f32) -> f64 {
        let Some(p) = self.page_ref(surface) else {
            return -1.0;
        };
        if !x.is_finite() || !y.is_finite() {
            return -1.0;
        }
        p.items
            .iter()
            .rev()
            .find(|item| match item {
                Item::Stroke(s) => stroke_hit(s, x, y, 4.0),
                Item::Text(t) => text_hit(t, x, y, 4.0),
                Item::Shape(s) => shape_hit(s, x, y, 4.0),
            })
            .map(|item| item.id() as f64)
            .unwrap_or(-1.0)
    }

    pub fn is_text(&self, page: usize, id: f64) -> bool {
        self.find_text_item(Surface::Pdf(page), id).is_some()
    }
    pub fn is_text_sketch(&self, note: usize, id: f64) -> bool {
        self.find_text_item(Surface::Sketch(note), id).is_some()
    }

    pub fn text_content(&self, page: usize, id: f64) -> String {
        self.find_text_item(Surface::Pdf(page), id)
            .map(|t| t.content.clone())
            .unwrap_or_default()
    }
    pub fn text_content_sketch(&self, note: usize, id: f64) -> String {
        self.find_text_item(Surface::Sketch(note), id)
            .map(|t| t.content.clone())
            .unwrap_or_default()
    }

    pub fn text_pos(&self, page: usize, id: f64) -> Vec<f32> {
        self.find_text_item(Surface::Pdf(page), id)
            .map(|t| t.pos.to_vec())
            .unwrap_or_default()
    }
    pub fn text_pos_sketch(&self, note: usize, id: f64) -> Vec<f32> {
        self.find_text_item(Surface::Sketch(note), id)
            .map(|t| t.pos.to_vec())
            .unwrap_or_default()
    }

    /// Start moving an existing item (any kind). `x`, `y` is the grab point.
    pub fn begin_item_drag(&mut self, page: usize, id: f64, x: f32, y: f32) -> bool {
        self.begin_item_drag_on(Surface::Pdf(page), id, x, y)
    }
    pub fn begin_item_drag_sketch(&mut self, note: usize, id: f64, x: f32, y: f32) -> bool {
        self.begin_item_drag_on(Surface::Sketch(note), id, x, y)
    }
    fn begin_item_drag_on(&mut self, surface: Surface, id: f64, x: f32, y: f32) -> bool {
        if !x.is_finite() || !y.is_finite() {
            return false;
        }
        let Some(id) = checked_id(id) else {
            return false;
        };
        let Some(p) = self.page_ref(surface) else {
            return false;
        };
        let Some(item) = p.items.iter().find(|it| it.id() == id) else {
            return false;
        };
        self.item_drag = Some(DragState {
            surface,
            id,
            original: item.clone(),
            grab: (x, y),
        });
        true
    }

    /// Move the dragged item with the pointer (rigid, clamped to its surface).
    pub fn drag_item(&mut self, x: f32, y: f32) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        let Some(drag) = &self.item_drag else {
            return;
        };
        let (surface, id, grab) = (drag.surface, drag.id, drag.grab);
        let original = drag.original.clone();
        let Some(p) = self.page_ref(surface) else {
            return;
        };
        let (dx, dy) = clamp_translation(&original, x - grab.0, y - grab.1, p.width, p.height);
        let moved = translate_item(&original, dx, dy);
        if let Some(p) = self.page_mut(surface) {
            if let Some(slot) = p.items.iter_mut().find(|it| it.id() == id) {
                *slot = moved;
            }
        }
    }

    pub fn item_bbox_of(&self, page: usize, id: f64) -> Vec<f32> {
        self.item_bbox_on(Surface::Pdf(page), id)
    }
    pub fn item_bbox_of_sketch(&self, note: usize, id: f64) -> Vec<f32> {
        self.item_bbox_on(Surface::Sketch(note), id)
    }
    fn item_bbox_on(&self, surface: Surface, id: f64) -> Vec<f32> {
        let Some(id) = checked_id(id) else {
            return Vec::new();
        };
        self.page_ref(surface)
            .and_then(|p| p.items.iter().find(|it| it.id() == id))
            .map(|it| item_bbox(it).to_vec())
            .unwrap_or_default()
    }

    pub fn item_kind(&self, page: usize, id: f64) -> String {
        self.item_kind_on(Surface::Pdf(page), id)
    }
    pub fn item_kind_sketch(&self, note: usize, id: f64) -> String {
        self.item_kind_on(Surface::Sketch(note), id)
    }
    fn item_kind_on(&self, surface: Surface, id: f64) -> String {
        let Some(id) = checked_id(id) else {
            return String::new();
        };
        self.page_ref(surface)
            .and_then(|p| p.items.iter().find(|it| it.id() == id))
            .map(|it| match it {
                Item::Stroke(_) => "stroke",
                Item::Text(_) => "text",
                Item::Shape(_) => "shape",
            })
            .unwrap_or("")
            .to_string()
    }

    /// Scale the item under drag about an anchor point (a resize preview).
    pub fn scale_dragged_item(&mut self, anchor_x: f32, anchor_y: f32, sx: f32, sy: f32) {
        if !anchor_x.is_finite() || !anchor_y.is_finite() || !sx.is_finite() || !sy.is_finite() {
            return;
        }
        let (sx, sy) = (sx.clamp(0.05, 20.0), sy.clamp(0.05, 20.0));
        let Some(drag) = &self.item_drag else {
            return;
        };
        let (surface, id) = (drag.surface, drag.id);
        let original = drag.original.clone();
        let scaled = scale_item(&original, anchor_x, anchor_y, sx, sy);
        let Some(p) = self.page_mut(surface) else {
            return;
        };
        let (w, h) = (p.width.max(1.0), p.height.max(1.0));
        if let Some(slot) = p.items.iter_mut().find(|it| it.id() == id) {
            *slot = clamp_item_to_page(scaled, w, h);
        }
    }

    pub fn delete_item(&mut self, page: usize, id: f64) -> bool {
        self.delete_item_on(Surface::Pdf(page), id)
    }
    pub fn delete_item_sketch(&mut self, note: usize, id: f64) -> bool {
        self.delete_item_on(Surface::Sketch(note), id)
    }
    fn delete_item_on(&mut self, surface: Surface, id: f64) -> bool {
        let Some(id) = checked_id(id) else {
            return false;
        };
        let Some(p) = self.page_mut(surface) else {
            return false;
        };
        let Some(idx) = p.items.iter().position(|it| it.id() == id) else {
            return false;
        };
        let removed = p.items.remove(idx);
        self.history.push(Command::Remove {
            surface,
            items: vec![(idx, removed)],
        });
        self.dirty = true;
        true
    }

    /// Finish a move/resize, recording it as a single undoable step.
    pub fn end_item_drag(&mut self) {
        let Some(drag) = self.item_drag.take() else {
            return;
        };
        let Some(p) = self.page_ref(drag.surface) else {
            return;
        };
        let Some(new) = p.items.iter().find(|it| it.id() == drag.id).cloned() else {
            return;
        };
        if item_geometry_eq(&drag.original, &new) {
            return; // nothing moved
        }
        self.history.push(Command::Replace {
            surface: drag.surface,
            old: Box::new(drag.original),
            new: Box::new(new),
        });
        self.dirty = true;
    }

    /// Replace the content of an existing text note (empty content deletes it).
    pub fn update_text(&mut self, page: usize, id: f64, content: &str) -> Result<(), String> {
        self.update_text_on(Surface::Pdf(page), id, content)
    }
    pub fn update_text_sketch(
        &mut self,
        note: usize,
        id: f64,
        content: &str,
    ) -> Result<(), String> {
        self.update_text_on(Surface::Sketch(note), id, content)
    }
    fn update_text_on(&mut self, surface: Surface, id: f64, content: &str) -> Result<(), String> {
        let id = checked_id(id).ok_or("invalid id")?;
        let content = sanitize_text(content);
        let p = self.page_mut(surface).ok_or("no such surface")?;
        let idx = p
            .items
            .iter()
            .position(|it| it.id() == id && matches!(it, Item::Text(_)))
            .ok_or("no such text note")?;
        let old = p.items[idx].clone();
        if content.trim().is_empty() {
            p.items.remove(idx);
            self.history.push(Command::Remove {
                surface,
                items: vec![(idx, old)],
            });
        } else {
            if let Item::Text(t) = &mut p.items[idx] {
                t.content = content;
            }
            let new = p.items[idx].clone();
            self.history.push(Command::Replace {
                surface,
                old: Box::new(old),
                new: Box::new(new),
            });
        }
        self.dirty = true;
        Ok(())
    }

    fn find_text_item(&self, surface: Surface, id: f64) -> Option<&Text> {
        let id = checked_id(id)?;
        self.page_ref(surface)?
            .items
            .iter()
            .find_map(|it| match it {
                Item::Text(t) if t.id == id => Some(t),
                _ => None,
            })
    }

    // ---------- working-document notes ----------
    //
    // Notes are NOT routed through the undo stack: text blocks live in
    // textareas (which have native undo), and block add/remove is rare and
    // explicit. Every text path is sanitized; clippings are validated base64.

    pub fn notes_len(&self) -> usize {
        self.doc.notes.len()
    }

    /// "text" | "clipping" | "sketch" | "" (out of range).
    pub fn note_kind(&self, i: usize) -> String {
        match self.doc.notes.get(i) {
            Some(NoteBlock::Text { .. }) => "text".into(),
            Some(NoteBlock::Clipping { .. }) => "clipping".into(),
            Some(NoteBlock::Sketch { .. }) => "sketch".into(),
            None => String::new(),
        }
    }

    /// `[width, height]` of a sketch note's canvas, or empty if not a sketch.
    pub fn sketch_size(&self, i: usize) -> Vec<f32> {
        match self.doc.notes.get(i) {
            Some(NoteBlock::Sketch { surface }) => vec![surface.width, surface.height],
            _ => Vec::new(),
        }
    }

    /// PDF vector operators for a sketch note's annotations (for export).
    pub fn sketch_export_ops(&self, i: usize) -> String {
        match self.doc.notes.get(i) {
            Some(NoteBlock::Sketch { surface }) => export::page_ops(surface, self.palette),
            _ => String::new(),
        }
    }

    pub fn note_text(&self, i: usize) -> String {
        match self.doc.notes.get(i) {
            Some(NoteBlock::Text { content }) => content.clone(),
            _ => String::new(),
        }
    }

    pub fn note_caption(&self, i: usize) -> String {
        match self.doc.notes.get(i) {
            Some(NoteBlock::Clipping { caption, .. }) => caption.clone(),
            _ => String::new(),
        }
    }

    pub fn note_png(&self, i: usize) -> String {
        match self.doc.notes.get(i) {
            Some(NoteBlock::Clipping { png_b64, .. }) => png_b64.clone(),
            _ => String::new(),
        }
    }

    pub fn note_source_page(&self, i: usize) -> i32 {
        match self.doc.notes.get(i) {
            Some(NoteBlock::Clipping { source_page, .. }) => *source_page as i32,
            _ => -1,
        }
    }

    /// Append a blank sketch canvas of the given size. Returns its index.
    /// Annotations on it are NOT undone by this call's history (they have
    /// their own commands once drawn).
    pub fn add_sketch_note(&mut self, width: f32, height: f32) -> Result<usize, String> {
        if self.doc.notes.len() >= MAX_NOTE_BLOCKS {
            return Err("notes are full".into());
        }
        if !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
            || width > MAX_PAGE_DIM
            || height > MAX_PAGE_DIM
        {
            return Err("invalid sketch size".into());
        }
        self.doc.notes.push(NoteBlock::Sketch {
            surface: Page {
                width,
                height,
                items: Vec::new(),
            },
        });
        self.dirty = true;
        Ok(self.doc.notes.len() - 1)
    }

    /// Append an empty/with-content text block. Returns its index.
    pub fn add_text_note(&mut self, content: &str) -> Result<usize, String> {
        if self.doc.notes.len() >= MAX_NOTE_BLOCKS {
            return Err("notes are full".into());
        }
        self.doc.notes.push(NoteBlock::Text {
            content: sanitize_text_capped(content, MAX_NOTE_TEXT_LEN),
        });
        self.dirty = true;
        Ok(self.doc.notes.len() - 1)
    }

    /// Append a snipped clipping. Returns its index.
    pub fn add_clipping(
        &mut self,
        png_b64: &str,
        source_page: usize,
        caption: &str,
    ) -> Result<usize, String> {
        if self.doc.notes.len() >= MAX_NOTE_BLOCKS {
            return Err("notes are full".into());
        }
        if !valid_b64_png(png_b64) {
            return Err("invalid image data".into());
        }
        if source_page >= MAX_PAGES {
            return Err("bad source page".into());
        }
        self.doc.notes.push(NoteBlock::Clipping {
            png_b64: png_b64.to_string(),
            source_page: source_page as u32,
            caption: sanitize_text_capped(caption, MAX_CAPTION_LEN),
        });
        self.dirty = true;
        Ok(self.doc.notes.len() - 1)
    }

    pub fn update_note_text(&mut self, i: usize, content: &str) -> Result<(), String> {
        match self.doc.notes.get_mut(i) {
            Some(NoteBlock::Text { content: c }) => {
                *c = sanitize_text_capped(content, MAX_NOTE_TEXT_LEN);
                self.dirty = true;
                Ok(())
            }
            _ => Err("no such text block".into()),
        }
    }

    pub fn update_note_caption(&mut self, i: usize, caption: &str) -> Result<(), String> {
        match self.doc.notes.get_mut(i) {
            Some(NoteBlock::Clipping { caption: c, .. }) => {
                *c = sanitize_text_capped(caption, MAX_CAPTION_LEN);
                self.dirty = true;
                Ok(())
            }
            _ => Err("no such clipping".into()),
        }
    }

    pub fn remove_note(&mut self, i: usize) -> bool {
        if i < self.doc.notes.len() {
            self.doc.notes.remove(i);
            // Undo history addresses sketch surfaces by note index; removing a
            // block invalidates those indices, so drop history to stay sound.
            self.discard_history_referencing_sketches();
            self.dirty = true;
            true
        } else {
            false
        }
    }

    /// Move a block up (delta = -1) or down (delta = +1).
    pub fn move_note(&mut self, i: usize, delta: i32) -> bool {
        let len = self.doc.notes.len();
        let j = i as i64 + delta as i64;
        if i < len && j >= 0 && (j as usize) < len {
            self.doc.notes.swap(i, j as usize);
            self.discard_history_referencing_sketches();
            self.dirty = true;
            true
        } else {
            false
        }
    }

    /// Drop the undo history if it references any sketch surface (whose index
    /// just changed). PDF-only histories are common and kept untouched.
    fn discard_history_referencing_sketches(&mut self) {
        if self.history.references_sketch() {
            self.history.clear();
        }
        // An in-progress sketch interaction is also invalidated.
        if matches!(self.current, Some((Surface::Sketch(_), _)))
            || matches!(self.current_shape, Some((Surface::Sketch(_), _)))
            || matches!(self.erase_pending, Some((Surface::Sketch(_), _)))
            || matches!(&self.item_drag, Some(d) if matches!(d.surface, Surface::Sketch(_)))
        {
            self.current = None;
            self.current_shape = None;
            self.erase_pending = None;
            self.item_drag = None;
        }
    }

    /// PDF ops for a pre-wrapped block of note text on an exported notes
    /// page. `lines` are joined by '\n'; sanitization + escaping in Rust.
    pub fn note_text_block_ops(&self, lines: &str, x: f32, y_pdf: f32, size: f32) -> String {
        if !x.is_finite() || !y_pdf.is_finite() || !size.is_finite() {
            return String::new();
        }
        let clean = sanitize_text_capped(lines, MAX_NOTE_TEXT_LEN);
        let split: Vec<&str> = clean.split('\n').collect();
        export::text_block_ops(&split, x, y_pdf, size.clamp(4.0, 72.0))
    }

    // ---------- undo / redo ----------

    pub fn undo(&mut self) {
        if let Some(cmd) = self.history.pop_undo() {
            match cmd {
                Command::Add { surface, item } => self.remove_by_id(surface, item.id()),
                Command::Remove { surface, items } => self.re_add_at(surface, items),
                Command::Replace { surface, old, .. } => self.replace_by_id(surface, *old),
            }
            self.dirty = true;
        }
    }

    pub fn redo(&mut self) {
        if let Some(cmd) = self.history.pop_redo() {
            match cmd {
                Command::Add { surface, item } => self.re_add(surface, vec![item]),
                Command::Remove { surface, items } => {
                    for (_, it) in &items {
                        self.remove_by_id(surface, it.id());
                    }
                }
                Command::Replace { surface, new, .. } => self.replace_by_id(surface, *new),
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
        self.next_id = max_id(&doc).saturating_add(1);
        self.doc = doc;
        self.history.clear();
        self.current = None;
        self.current_shape = None;
        self.erase_pending = None;
        self.item_drag = None;
        self.dirty = false;
        Ok(())
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Re-mark unsaved. The autosave path calls this when an IndexedDB write
    /// rejects (quota/eviction) so the snapshot it just took isn't lost — the
    /// next autosave tick sees the dirty flag and retries.
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub fn page_count(&self) -> usize {
        self.doc.pages.len()
    }

    // ---------- rendering ----------

    /// Draw all annotations for a PDF page onto the (cleared) canvas.
    pub fn render(&self, ctx: &CanvasRenderingContext2d, page: usize, scale: f64) {
        self.render_surface(ctx, Surface::Pdf(page), scale);
    }

    /// Draw all annotations for a sketch note onto the (cleared) canvas.
    pub fn render_sketch(&self, ctx: &CanvasRenderingContext2d, note: usize, scale: f64) {
        self.render_surface(ctx, Surface::Sketch(note), scale);
    }

    fn render_surface(&self, ctx: &CanvasRenderingContext2d, surface: Surface, scale: f64) {
        let Some(p) = self.page_ref(surface) else {
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
            draw_item(ctx, item, self.palette);
        }
        if let Some((s, stroke)) = &self.current {
            if *s == surface {
                draw_stroke(ctx, stroke, self.palette);
            }
        }
        if let Some((s, shape)) = &self.current_shape {
            if *s == surface {
                draw_shape(ctx, shape, self.palette);
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
            .map(|p| export::page_ops(p, self.palette))
            .unwrap_or_default()
    }

    pub fn highlight_gstate_name(&self) -> String {
        export::HIGHLIGHT_GSTATE.to_string()
    }

    pub fn text_font_name(&self) -> String {
        export::TEXT_FONT.to_string()
    }

    // ---------- internals ----------

    /// Resolve a surface to its [`Page`], if it exists.
    fn page_ref(&self, s: Surface) -> Option<&Page> {
        match s {
            Surface::Pdf(i) => self.doc.pages.get(i),
            Surface::Sketch(i) => match self.doc.notes.get(i) {
                Some(NoteBlock::Sketch { surface }) => Some(surface),
                _ => None,
            },
        }
    }

    fn page_mut(&mut self, s: Surface) -> Option<&mut Page> {
        match s {
            Surface::Pdf(i) => self.doc.pages.get_mut(i),
            Surface::Sketch(i) => match self.doc.notes.get_mut(i) {
                Some(NoteBlock::Sketch { surface }) => Some(surface),
                _ => None,
            },
        }
    }

    fn surface_exists(&self, s: Surface) -> bool {
        self.page_ref(s).is_some()
    }

    fn clamp_to_page(&self, s: Surface, x: f32, y: f32) -> (f32, f32) {
        match self.page_ref(s) {
            Some(p) if p.width > 0.0 && p.height > 0.0 => {
                (x.clamp(0.0, p.width), y.clamp(0.0, p.height))
            }
            _ => (x.clamp(0.0, MAX_PAGE_DIM), y.clamp(0.0, MAX_PAGE_DIM)),
        }
    }

    /// Append a finished item to its surface and record it for undo.
    fn commit(&mut self, surface: Surface, item: Item) {
        self.next_id = self.next_id.max(item.id().saturating_add(1));
        if let Some(p) = self.page_mut(surface) {
            if p.items.len() < MAX_ITEMS_PER_PAGE {
                p.items.push(item.clone());
                self.history.push(Command::Add { surface, item });
                self.dirty = true;
            }
        }
    }

    fn remove_by_id(&mut self, surface: Surface, id: u64) {
        if let Some(p) = self.page_mut(surface) {
            p.items.retain(|it| it.id() != id);
        }
    }

    fn re_add(&mut self, surface: Surface, items: Vec<Item>) {
        if let Some(p) = self.page_mut(surface) {
            for item in items {
                if p.items.len() < MAX_ITEMS_PER_PAGE {
                    p.items.push(item);
                }
            }
        }
    }

    /// Restore removed items at their original indices (undo of erase/delete),
    /// preserving z-order. Inserting in ascending index order is correct: by the
    /// time we insert at index i, every original position < i is already filled.
    fn re_add_at(&mut self, surface: Surface, mut items: Vec<(usize, Item)>) {
        if let Some(p) = self.page_mut(surface) {
            items.sort_by_key(|(i, _)| *i);
            for (idx, item) in items {
                if p.items.len() < MAX_ITEMS_PER_PAGE {
                    let at = idx.min(p.items.len());
                    p.items.insert(at, item);
                }
            }
        }
    }

    /// Overwrite the item with `item.id()` in place (undo/redo of a move/resize/
    /// edit, or a cancelled drag), keeping its z-position. No-op if it's gone.
    fn replace_by_id(&mut self, surface: Surface, item: Item) {
        if let Some(p) = self.page_mut(surface) {
            if let Some(slot) = p.items.iter_mut().find(|it| it.id() == item.id()) {
                *slot = item;
            }
        }
    }

    fn erase_at(&mut self, surface: Surface, x: f32, y: f32, radius: f32) {
        let radius = if radius.is_finite() {
            radius.clamp(1.0, 100.0)
        } else {
            8.0
        };
        let Some(p) = self.page_mut(surface) else {
            return;
        };
        let mut removed = Vec::new();
        let mut idx = 0usize; // original index (retain visits items in order)
        p.items.retain(|item| {
            let hit = match item {
                Item::Stroke(s) => stroke_hit(s, x, y, radius),
                Item::Text(t) => text_hit(t, x, y, radius),
                Item::Shape(s) => shape_hit(s, x, y, radius),
            };
            if hit {
                removed.push((idx, item.clone()));
            }
            idx += 1;
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

/// Validate an item id received from JS as f64 (must be a non-negative
/// integer exactly representable in the f64 range we hand out).
fn checked_id(id: f64) -> Option<u64> {
    (id.is_finite() && id >= 0.0 && id.fract() == 0.0 && id < 2f64.powi(53)).then_some(id as u64)
}

// ---------- rigid moves ----------

/// Axis-aligned bounding box of an item: `[min_x, min_y, max_x, max_y]`.
fn item_bbox(item: &Item) -> [f32; 4] {
    match item {
        Item::Stroke(s) => {
            let mut bb = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
            for p in &s.points {
                bb[0] = bb[0].min(p[0]);
                bb[1] = bb[1].min(p[1]);
                bb[2] = bb[2].max(p[0]);
                bb[3] = bb[3].max(p[1]);
            }
            bb
        }
        Item::Text(t) => {
            let w = t.content.chars().count() as f32 * t.size * 0.6;
            [t.pos[0], t.pos[1] - t.size, t.pos[0] + w, t.pos[1]]
        }
        Item::Shape(s) => [
            s.rect[0].min(s.rect[2]),
            s.rect[1].min(s.rect[3]),
            s.rect[0].max(s.rect[2]),
            s.rect[1].max(s.rect[3]),
        ],
    }
}

/// Clamp a translation so the item's bounding box stays within the page.
fn clamp_translation(item: &Item, dx: f32, dy: f32, w: f32, h: f32) -> (f32, f32) {
    let bb = item_bbox(item);
    (
        dx.clamp(-bb[0], (w - bb[2]).max(-bb[0])),
        dy.clamp(-bb[1], (h - bb[3]).max(-bb[1])),
    )
}

/// Move an item rigidly by (dx, dy) without changing its shape.
fn translate_item(item: &Item, dx: f32, dy: f32) -> Item {
    let mut out = item.clone();
    match &mut out {
        Item::Stroke(s) => {
            for p in &mut s.points {
                p[0] += dx;
                p[1] += dy;
            }
        }
        Item::Text(t) => {
            t.pos[0] += dx;
            t.pos[1] += dy;
        }
        Item::Shape(s) => {
            s.rect[0] += dx;
            s.rect[1] += dy;
            s.rect[2] += dx;
            s.rect[3] += dy;
        }
    }
    out
}

/// Scale an item about an anchor point. Strokes scale their points, shapes
/// their rect; text scales position and font size (clamped) by max(sx, sy).
fn scale_item(item: &Item, ax: f32, ay: f32, sx: f32, sy: f32) -> Item {
    let mut out = item.clone();
    let tx = |x: f32| ax + (x - ax) * sx;
    let ty = |y: f32| ay + (y - ay) * sy;
    match &mut out {
        Item::Stroke(s) => {
            for p in &mut s.points {
                p[0] = tx(p[0]);
                p[1] = ty(p[1]);
            }
        }
        Item::Text(t) => {
            t.pos = [tx(t.pos[0]), ty(t.pos[1])];
            t.size = (t.size * sx.max(sy)).clamp(MIN_TEXT_SIZE, MAX_TEXT_SIZE);
        }
        Item::Shape(s) => {
            s.rect = [tx(s.rect[0]), ty(s.rect[1]), tx(s.rect[2]), ty(s.rect[3])];
        }
    }
    out
}

/// Clamp an item's geometry to the page after a scale.
fn clamp_item_to_page(mut item: Item, w: f32, h: f32) -> Item {
    match &mut item {
        Item::Stroke(s) => {
            for p in &mut s.points {
                p[0] = p[0].clamp(0.0, w);
                p[1] = p[1].clamp(0.0, h);
            }
        }
        Item::Text(t) => {
            t.pos[0] = t.pos[0].clamp(0.0, w);
            t.pos[1] = t.pos[1].clamp(0.0, h);
        }
        Item::Shape(s) => {
            s.rect[0] = s.rect[0].clamp(0.0, w);
            s.rect[1] = s.rect[1].clamp(0.0, h);
            s.rect[2] = s.rect[2].clamp(0.0, w);
            s.rect[3] = s.rect[3].clamp(0.0, h);
        }
    }
    item
}

/// True if two items have identical geometry (used to skip no-op moves).
fn item_geometry_eq(a: &Item, b: &Item) -> bool {
    match (a, b) {
        (Item::Stroke(x), Item::Stroke(y)) => x.points == y.points,
        (Item::Text(x), Item::Text(y)) => x.pos == y.pos && x.size == y.size,
        (Item::Shape(x), Item::Shape(y)) => x.rect == y.rect,
        _ => false,
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

fn draw_item(ctx: &CanvasRenderingContext2d, item: &Item, pal: Palette) {
    match item {
        Item::Stroke(s) => draw_stroke(ctx, s, pal),
        Item::Text(t) => draw_text(ctx, t, pal),
        Item::Shape(s) => draw_shape(ctx, s, pal),
    }
}

fn draw_shape(ctx: &CanvasRenderingContext2d, s: &Shape, pal: Palette) {
    let [x0, y0, x1, y1] = s.rect.map(f64::from);
    let (lo_x, hi_x) = (x0.min(x1), x0.max(x1));
    let (lo_y, hi_y) = (y0.min(y1), y0.max(y1));
    ctx.save();
    if s.kind == ShapeKind::FillRect {
        // Highlight box: translucent marker tint over the region.
        ctx.set_global_alpha(HIGHLIGHT_ALPHA);
        ctx.set_global_composite_operation("multiply").ok();
        ctx.set_fill_style_str(s.color.highlight_css(pal));
        ctx.fill_rect(lo_x, lo_y, hi_x - lo_x, hi_y - lo_y);
        ctx.restore();
        return;
    }
    ctx.set_stroke_style_str(s.color.css(pal));
    ctx.set_line_width(f64::from(s.width));
    ctx.begin_path();
    match s.kind {
        ShapeKind::FillRect => unreachable!("handled above"),
        ShapeKind::Rect => {
            ctx.rect(lo_x, lo_y, hi_x - lo_x, hi_y - lo_y);
        }
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

fn draw_stroke(ctx: &CanvasRenderingContext2d, s: &Stroke, pal: Palette) {
    if s.points.is_empty() {
        return;
    }
    ctx.save();
    if s.kind == PenKind::Highlighter {
        ctx.set_global_alpha(HIGHLIGHT_ALPHA);
        ctx.set_global_composite_operation("multiply").ok();
        // Marker tints: dark pen colors make unreadable highlights.
        ctx.set_stroke_style_str(s.color.highlight_css(pal));
    } else {
        ctx.set_stroke_style_str(s.color.css(pal));
    }
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

fn draw_text(ctx: &CanvasRenderingContext2d, t: &Text, pal: Palette) {
    ctx.save();
    ctx.set_fill_style_str(t.color.css(pal));
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

    /// A real 1×1 PNG, base64-encoded (starts with the PNG signature "iVBORw0KGgo").
    const PNG_1X1_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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
    fn item_drag_is_one_undo_step() {
        let mut a = app_with_page();
        a.add_text(0, 100.0, 100.0, "note").unwrap();
        let id = a.find_item(0, 102.0, 95.0);
        assert!(id >= 0.0);
        assert!(a.is_text(0, id));
        assert!(a.begin_item_drag(0, id, 102.0, 95.0));
        a.drag_item(202.0, 215.0);
        a.drag_item(302.0, 315.0);
        a.end_item_drag();
        assert_eq!(a.text_pos(0, id), vec![300.0, 320.0]);
        a.undo();
        assert_eq!(a.text_pos(0, id), vec![100.0, 100.0]);
        a.redo();
        assert_eq!(a.text_pos(0, id), vec![300.0, 320.0]);
    }

    #[test]
    fn stroke_moves_rigidly_and_stays_on_page() {
        let mut a = app_with_page();
        a.pointer_down(0, 10.0, 10.0, 8.0);
        a.pointer_move(50.0, 20.0, 8.0);
        a.pointer_up();
        let id = a.find_item(0, 30.0, 15.0);
        assert!(id >= 0.0);
        assert!(!a.is_text(0, id));
        a.begin_item_drag(0, id, 30.0, 15.0);
        // Try to drag far off the page; translation must be clamped.
        a.drag_item(-500.0, -500.0);
        a.end_item_drag();
        if let Item::Stroke(s) = &a.doc.pages[0].items[0] {
            assert_eq!(s.points[0], [0.0, 0.0]); // hit the page corner, intact shape
            assert_eq!(s.points[1], [40.0, 10.0]);
        } else {
            panic!("expected stroke");
        }
        a.undo();
        if let Item::Stroke(s) = &a.doc.pages[0].items[0] {
            assert_eq!(s.points[0], [10.0, 10.0]);
        } else {
            panic!("expected stroke");
        }
    }

    #[test]
    fn text_edit_and_delete_via_update() {
        let mut a = app_with_page();
        a.add_text(0, 50.0, 50.0, "old").unwrap();
        let id = a.find_item(0, 52.0, 46.0);
        a.update_text(0, id, "new words").unwrap();
        assert_eq!(a.text_content(0, id), "new words");
        a.undo();
        assert_eq!(a.text_content(0, id), "old");
        // empty content deletes, and that's undoable too
        a.update_text(0, id, "   ").unwrap();
        assert_eq!(a.doc.pages[0].items.len(), 0);
        a.undo();
        assert_eq!(a.text_content(0, id), "old");
    }

    #[test]
    fn bogus_ids_rejected() {
        let mut a = app_with_page();
        a.add_text(0, 50.0, 50.0, "x").unwrap();
        assert!(!a.begin_item_drag(0, -1.0, 0.0, 0.0));
        assert!(!a.begin_item_drag(0, 1.5, 0.0, 0.0));
        assert!(!a.begin_item_drag(0, f64::NAN, 0.0, 0.0));
        assert!(a.update_text(0, 99.0, "y").is_err());
        assert_eq!(a.find_item(0, 500.0, 500.0), -1.0);
    }

    #[test]
    fn cancelled_drag_reverts() {
        let mut a = app_with_page();
        a.add_text(0, 100.0, 100.0, "note").unwrap();
        let id = a.find_item(0, 102.0, 95.0);
        a.begin_item_drag(0, id, 102.0, 95.0);
        a.drag_item(400.0, 400.0);
        a.pointer_cancel();
        assert_eq!(a.text_pos(0, id), vec![100.0, 100.0]);
    }

    #[test]
    fn highlight_box_and_rect_export() {
        let mut a = app_with_page();
        a.set_tool("fillrect");
        a.set_color("green");
        a.pointer_down(0, 20.0, 30.0, 8.0);
        a.pointer_move(120.0, 60.0, 8.0);
        a.pointer_up();
        a.set_tool("rect");
        a.pointer_down(0, 200.0, 200.0, 8.0);
        a.pointer_move(260.0, 240.0, 8.0);
        a.pointer_up();
        let ops = a.export_pdf_ops(0);
        assert!(ops.contains("re f"), "filled highlight box");
        assert!(ops.contains("re\n"), "outlined rect");
        assert!(ops.contains(&format!("/{} gs", a.highlight_gstate_name())));
    }

    #[test]
    fn text_input_strips_bidi_overrides() {
        let mut a = app_with_page();
        a.add_text(0, 10.0, 10.0, "abc\u{202E}def\u{200B}g")
            .unwrap();
        if let Item::Text(t) = &a.doc.pages[0].items[0] {
            assert_eq!(t.content, "abcdefg");
        } else {
            panic!("expected text");
        }
    }

    #[test]
    fn resize_scales_and_undoes() {
        let mut a = app_with_page();
        a.set_tool("rect");
        a.pointer_down(0, 100.0, 100.0, 8.0);
        a.pointer_move(200.0, 150.0, 8.0);
        a.pointer_up();
        let id = a.find_item(0, 150.0, 125.0);
        let bb = a.item_bbox_of(0, id);
        assert_eq!(bb, vec![100.0, 100.0, 200.0, 150.0]);
        assert_eq!(a.item_kind(0, id), "shape");
        // resize about top-left anchor, 2x in both axes
        a.begin_item_drag(0, id, 200.0, 150.0);
        a.scale_dragged_item(100.0, 100.0, 2.0, 2.0);
        a.end_item_drag();
        assert_eq!(a.item_bbox_of(0, id), vec![100.0, 100.0, 300.0, 200.0]);
        a.undo();
        assert_eq!(a.item_bbox_of(0, id), vec![100.0, 100.0, 200.0, 150.0]);
    }

    #[test]
    fn text_resize_changes_font_size_one_undo() {
        let mut a = app_with_page();
        a.add_text(0, 100.0, 100.0, "hi").unwrap();
        let id = a.find_item(0, 102.0, 95.0);
        a.begin_item_drag(0, id, 100.0, 100.0);
        a.scale_dragged_item(100.0, 100.0, 1.5, 1.5);
        a.end_item_drag();
        if let Item::Text(t) = &a.doc.pages[0].items[0] {
            assert!((t.size - 24.0).abs() < 0.01);
        } else {
            panic!()
        }
        a.undo();
        if let Item::Text(t) = &a.doc.pages[0].items[0] {
            assert!((t.size - 16.0).abs() < 0.01);
        } else {
            panic!()
        }
    }

    #[test]
    fn delete_item_is_undoable() {
        let mut a = app_with_page();
        a.add_text(0, 50.0, 50.0, "bye").unwrap();
        let id = a.find_item(0, 52.0, 46.0);
        assert!(a.delete_item(0, id));
        assert_eq!(a.doc.pages[0].items.len(), 0);
        a.undo();
        assert_eq!(a.doc.pages[0].items.len(), 1);
        assert!(!a.delete_item(0, 999.0));
    }

    fn page_ids(a: &App) -> Vec<u64> {
        a.doc.pages[0].items.iter().map(|it| it.id()).collect()
    }

    #[test]
    fn delete_undo_restores_z_order() {
        let mut a = app_with_page();
        a.add_text(0, 10.0, 10.0, "a").unwrap();
        a.add_text(0, 30.0, 30.0, "b").unwrap();
        a.add_text(0, 50.0, 50.0, "c").unwrap();
        let ids = page_ids(&a); // draw order == z-order
        assert!(a.delete_item(0, ids[1] as f64)); // erase the MIDDLE item
        a.undo();
        assert_eq!(
            page_ids(&a),
            ids,
            "undeleted item must return to the middle, not the top"
        );
    }

    #[test]
    fn edit_undo_preserves_z_order() {
        let mut a = app_with_page();
        a.add_text(0, 10.0, 10.0, "a").unwrap();
        a.add_text(0, 30.0, 30.0, "b").unwrap();
        a.add_text(0, 50.0, 50.0, "c").unwrap();
        let ids = page_ids(&a);
        a.update_text(0, ids[1] as f64, "B!").unwrap(); // Replace the middle item
        assert_eq!(page_ids(&a), ids);
        a.undo();
        assert_eq!(
            page_ids(&a),
            ids,
            "edited item must keep its z-position after undo"
        );
    }

    #[test]
    fn load_bounds_item_id_to_js_safe_range() {
        let mut a = app_with_page();
        a.add_text(0, 50.0, 50.0, "x").unwrap();
        let json = a.save_json().unwrap();
        let id_field = format!("\"id\":{}", a.doc.pages[0].items[0].id());
        // 2^53 is out of range (loses precision in JS) → rejected.
        let mut b = App::new();
        assert!(b
            .load_json(&json.replacen(&id_field, "\"id\":9007199254740992", 1))
            .is_err());
        // 2^53 - 1 is the largest in-range id → loads without panic.
        let mut c = App::new();
        assert!(c
            .load_json(&json.replacen(&id_field, "\"id\":9007199254740991", 1))
            .is_ok());
    }

    #[test]
    fn valid_b64_png_requires_signature_and_shape() {
        assert!(crate::model::valid_b64_png(PNG_1X1_B64));
        assert!(!crate::model::valid_b64_png("aGVsbG8=")); // valid base64, not a PNG
        assert!(!crate::model::valid_b64_png("iVBORw0KGgoAA")); // PNG prefix but len % 4 != 0
        assert!(!crate::model::valid_b64_png("")); // empty
    }

    #[test]
    fn notes_blocks_roundtrip_and_validate() {
        let mut a = app_with_page();
        let i = a.add_text_note("first thought\nsecond line").unwrap();
        let j = a.add_clipping(PNG_1X1_B64, 0, "eq (3)").unwrap();
        assert_eq!(a.notes_len(), 2);
        assert_eq!(a.note_kind(i), "text");
        assert_eq!(a.note_kind(j), "clipping");
        a.update_note_text(i, "edited \u{202E}clean").unwrap();
        assert_eq!(a.note_text(i), "edited clean"); // bidi stripped
        assert!(a.add_clipping("<bad>", 0, "x").is_err());
        assert!(a.move_note(j, -1));
        assert_eq!(a.note_kind(0), "clipping");
        let json = a.save_json().unwrap();
        let mut b = App::new();
        b.load_json(&json).unwrap();
        assert_eq!(b.notes_len(), 2);
        assert_eq!(b.note_caption(0), "eq (3)");
        assert!(b.remove_note(0));
        assert_eq!(b.notes_len(), 1);
    }

    #[test]
    fn palette_switch_changes_rendering_not_document() {
        let mut a = app_with_page();
        a.set_color("green");
        a.pointer_down(0, 10.0, 10.0, 8.0);
        a.pointer_up();
        let standard = a.export_pdf_ops(0);
        assert!(a.set_palette("safe"));
        let safe = a.export_pdf_ops(0);
        assert_ne!(standard, safe, "safe palette must change emitted colors");
        assert!(safe.contains("0.55 0.32 0.04"), "green renders as brown");
        // document unchanged: same JSON either way
        let j1 = a.save_json().unwrap();
        a.set_palette("standard");
        let j2 = a.save_json().unwrap();
        assert_eq!(j1, j2);
        assert!(!a.set_palette("neon"));
    }

    #[test]
    fn note_text_block_ops_escapes() {
        let a = App::new();
        let ops = a.note_text_block_ops("line (1)\n) Tj /evil (", 50.0, 700.0, 11.0);
        assert!(ops.contains(r"(line \(1\)) Tj"));
        assert!(ops.contains(r"(\) Tj /evil \() Tj"));
    }

    #[test]
    fn draw_on_sketch_note_with_full_toolset() {
        let mut a = app_with_page();
        let n = a.add_sketch_note(400.0, 300.0).unwrap();
        assert_eq!(a.note_kind(n), "sketch");
        assert_eq!(a.sketch_size(n), vec![400.0, 300.0]);
        // pen on the sketch
        a.set_tool("pen");
        a.pointer_down_sketch(n, 10.0, 10.0, 8.0);
        a.pointer_move(80.0, 60.0, 8.0);
        a.pointer_up();
        // text on the sketch
        a.add_text_sketch(n, 20.0, 40.0, "label").unwrap();
        // a box on the sketch
        a.set_tool("rect");
        a.pointer_down_sketch(n, 100.0, 100.0, 8.0);
        a.pointer_move(200.0, 180.0, 8.0);
        a.pointer_up();
        // The sketch surface now holds 3 items; the PDF page holds none.
        // (45, 35) is the midpoint of the pen stroke (10,10)->(80,60).
        let id = a.find_item_sketch(n, 45.0, 35.0);
        assert!(id >= 0.0);
        assert_eq!(
            a.find_item(0, 45.0, 35.0),
            -1.0,
            "PDF page must be untouched"
        );
        // export emits vector ops for the sketch
        assert!(a.sketch_export_ops(n).contains(" l\n"));
    }

    #[test]
    fn sketch_undo_redo_is_isolated_from_pdf() {
        let mut a = app_with_page();
        let n = a.add_sketch_note(400.0, 300.0).unwrap();
        // draw on PDF, then on sketch
        a.set_tool("pen");
        a.pointer_down(0, 5.0, 5.0, 8.0);
        a.pointer_up();
        a.pointer_down_sketch(n, 5.0, 5.0, 8.0);
        a.pointer_up();
        // undo removes the sketch stroke (last action), PDF stroke remains
        a.undo();
        assert_eq!(a.find_item_sketch(n, 5.0, 5.0), -1.0);
        assert!(a.find_item(0, 5.0, 5.0) >= 0.0);
        a.redo();
        assert!(a.find_item_sketch(n, 5.0, 5.0) >= 0.0);
    }

    #[test]
    fn sketch_move_resize_delete() {
        let mut a = app_with_page();
        let n = a.add_sketch_note(400.0, 300.0).unwrap();
        a.add_text_sketch(n, 50.0, 50.0, "x").unwrap();
        let id = a.find_item_sketch(n, 52.0, 46.0);
        // move
        a.begin_item_drag_sketch(n, id, 50.0, 50.0);
        a.drag_item(150.0, 120.0);
        a.end_item_drag();
        assert_eq!(a.text_pos_sketch(n, id), vec![150.0, 120.0]);
        // resize (text grows font)
        a.begin_item_drag_sketch(n, id, 150.0, 120.0);
        a.scale_dragged_item(150.0, 120.0, 1.5, 1.5);
        a.end_item_drag();
        // delete
        assert!(a.delete_item_sketch(n, id));
        assert_eq!(a.find_item_sketch(n, 150.0, 120.0), -1.0);
        a.undo(); // brings it back
        assert!(a.find_item_sketch(n, 150.0, 120.0) >= 0.0);
    }

    #[test]
    fn sketch_survives_save_load_and_validates() {
        let mut a = app_with_page();
        let n = a.add_sketch_note(400.0, 300.0).unwrap();
        a.set_tool("pen");
        a.pointer_down_sketch(n, 10.0, 10.0, 8.0);
        a.pointer_move(50.0, 50.0, 8.0);
        a.pointer_up();
        let json = a.save_json().unwrap();
        let mut b = App::new();
        b.load_json(&json).unwrap();
        assert_eq!(b.note_kind(n), "sketch");
        assert!(b.find_item_sketch(n, 30.0, 30.0) >= 0.0);
        // ids stay globally unique after load (next_id past the max)
        b.add_sketch_note(100.0, 100.0).unwrap();
    }

    #[test]
    fn removing_a_note_clears_sketch_history_safely() {
        let mut a = app_with_page();
        let n0 = a.add_sketch_note(400.0, 300.0).unwrap();
        a.add_text_note("between").unwrap();
        let n2 = a.add_sketch_note(400.0, 300.0).unwrap();
        a.set_tool("pen");
        a.pointer_down_sketch(n2, 10.0, 10.0, 8.0);
        a.pointer_up();
        assert!(a.can_undo());
        // Removing the earlier sketch shifts n2's index; history must be
        // dropped rather than left pointing at the wrong surface.
        assert!(a.remove_note(n0));
        assert!(!a.can_undo(), "sketch-referencing history discarded");
        // The shifted sketch is still intact and drawable.
        let shifted = 1; // n2 moved from index 2 to 1
        assert_eq!(a.note_kind(shifted), "sketch");
        a.pointer_down_sketch(shifted, 20.0, 20.0, 8.0);
        a.pointer_up();
        assert!(a.find_item_sketch(shifted, 20.0, 20.0) >= 0.0);
    }

    #[test]
    fn sketch_validation_rejects_hostile_surface() {
        // A loaded sketch with a non-finite stroke point is rejected.
        let json = r#"{"version":1,"pdf_sha256":"","pages":[],"notes":[
            {"type":"Sketch","surface":{"width":400,"height":300,"items":[
              {"type":"Stroke","Stroke":{"id":1,"kind":"Pen","color":"Red","width":2,"points":[[1,"x"]]}}
            ]}}]}"#;
        let mut b = App::new();
        assert!(b.load_json(json).is_err());
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
