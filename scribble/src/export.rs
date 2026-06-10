//! Vector PDF content-stream generation for annotations.
//!
//! The exported PDF places each original page as a raster image and overlays
//! annotations as native PDF vector operators (crisp at any zoom, and text
//! notes remain real, selectable PDF text).
//!
//! Coordinates are converted from canvas space (origin top-left, y down) to
//! PDF space (origin bottom-left, y up). All numbers are emitted with fixed
//! precision from already-validated, clamped values — no user-controlled
//! string ever reaches the operator stream except via [`escape_pdf_text`].

use crate::model::{Color, Item, Page, Palette, PenKind, Shape, ShapeKind, Stroke, Text};
use std::fmt::Write;

/// ExtGState resource name the host must register on each page:
/// `<< /CA 0.35 /ca 0.35 /BM /Multiply >>` (highlighter transparency).
pub const HIGHLIGHT_GSTATE: &str = "GShl";
/// Font resource name the host must register: Helvetica with WinAnsiEncoding.
pub const TEXT_FONT: &str = "F1";

/// Bézier circle constant.
const KAPPA: f32 = 0.552_284_8;

fn num(v: f32) -> String {
    // Fixed two-decimal formatting; normalizes -0.00 to 0.00.
    let v = if v.abs() < 0.005 { 0.0 } else { v };
    format!("{v:.2}")
}

fn set_stroke(out: &mut String, color: Color, width: f32, p: Palette) {
    let (r, g, b) = color.rgb(p);
    let _ = writeln!(
        out,
        "{} {} {} RG {} w 1 J 1 j",
        num(r),
        num(g),
        num(b),
        num(width)
    );
}

/// Escape text for a PDF literal string. Printable ASCII passes through,
/// `( ) \` are escaped, other Latin-1 bytes are emitted as octal escapes
/// (WinAnsiEncoding), anything else becomes `?`.
fn escape_pdf_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '(' | ')' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            ' '..='~' => out.push(c),
            c if (0xA0..=0xFF).contains(&(c as u32)) => {
                let _ = write!(out, "\\{:03o}", c as u32);
            }
            _ => out.push('?'),
        }
    }
    out
}

fn stroke_ops(out: &mut String, s: &Stroke, h: f32, pal: Palette) {
    if s.points.is_empty() {
        return;
    }
    out.push_str("q\n");
    if s.kind == PenKind::Highlighter {
        let _ = writeln!(out, "/{HIGHLIGHT_GSTATE} gs");
        let (r, g, b) = s.color.highlight_rgb(pal);
        let _ = writeln!(
            out,
            "{} {} {} RG {} w 1 J 1 j",
            num(r),
            num(g),
            num(b),
            num(s.width)
        );
    } else {
        set_stroke(out, s.color, s.width, pal);
    }
    let p0 = s.points[0];
    let _ = writeln!(out, "{} {} m", num(p0[0]), num(h - p0[1]));
    if s.points.len() == 1 {
        let _ = writeln!(out, "{} {} l", num(p0[0] + 0.1), num(h - p0[1]));
    } else {
        for p in &s.points[1..] {
            let _ = writeln!(out, "{} {} l", num(p[0]), num(h - p[1]));
        }
    }
    out.push_str("S\nQ\n");
}

fn line(out: &mut String, x0: f32, y0: f32, x1: f32, y1: f32, h: f32) {
    let _ = writeln!(
        out,
        "{} {} m {} {} l",
        num(x0),
        num(h - y0),
        num(x1),
        num(h - y1)
    );
}

fn shape_ops(out: &mut String, s: &Shape, h: f32, pal: Palette) {
    let [x0, y0, x1, y1] = s.rect;
    let (lo_x, hi_x) = (x0.min(x1), x0.max(x1));
    let (lo_y, hi_y) = (y0.min(y1), y0.max(y1));
    if s.kind == ShapeKind::FillRect {
        // Highlight box: translucent fill via the highlight ExtGState.
        let (r, g, b) = s.color.highlight_rgb(pal);
        out.push_str("q\n");
        let _ = writeln!(out, "/{HIGHLIGHT_GSTATE} gs");
        let _ = writeln!(out, "{} {} {} rg", num(r), num(g), num(b));
        let _ = writeln!(
            out,
            "{} {} {} {} re f",
            num(lo_x),
            num(h - hi_y),
            num(hi_x - lo_x),
            num(hi_y - lo_y)
        );
        out.push_str("Q\n");
        return;
    }
    out.push_str("q\n");
    set_stroke(out, s.color, s.width, pal);
    match s.kind {
        ShapeKind::FillRect => unreachable!("handled above"),
        ShapeKind::Rect => {
            let _ = writeln!(
                out,
                "{} {} {} {} re",
                num(lo_x),
                num(h - hi_y),
                num(hi_x - lo_x),
                num(hi_y - lo_y)
            );
        }
        ShapeKind::Circle => {
            // Ellipse inscribed in the normalized rect, four Bézier arcs.
            let (lo_x, hi_x) = (x0.min(x1), x0.max(x1));
            let (lo_y, hi_y) = (y0.min(y1), y0.max(y1));
            let (cx, cy) = ((lo_x + hi_x) / 2.0, (lo_y + hi_y) / 2.0);
            let (rx, ry) = ((hi_x - lo_x) / 2.0, (hi_y - lo_y) / 2.0);
            let (kx, ky) = (rx * KAPPA, ry * KAPPA);
            let f = |x: f32, y: f32| format!("{} {}", num(x), num(h - y));
            let _ = writeln!(out, "{} m", f(cx + rx, cy));
            let _ = writeln!(
                out,
                "{} {} {} c",
                f(cx + rx, cy + ky),
                f(cx + kx, cy + ry),
                f(cx, cy + ry)
            );
            let _ = writeln!(
                out,
                "{} {} {} c",
                f(cx - kx, cy + ry),
                f(cx - rx, cy + ky),
                f(cx - rx, cy)
            );
            let _ = writeln!(
                out,
                "{} {} {} c",
                f(cx - rx, cy - ky),
                f(cx - kx, cy - ry),
                f(cx, cy - ry)
            );
            let _ = writeln!(
                out,
                "{} {} {} c",
                f(cx + kx, cy - ry),
                f(cx + rx, cy - ky),
                f(cx + rx, cy)
            );
        }
        ShapeKind::Arrow => {
            line(out, x0, y0, x1, y1, h);
            let ang = (y1 - y0).atan2(x1 - x0);
            let head = (10.0 + s.width * 2.0).min(24.0);
            for da in [2.6_f32, -2.6_f32] {
                line(
                    out,
                    x1,
                    y1,
                    x1 + head * (ang + da).cos(),
                    y1 + head * (ang + da).sin(),
                    h,
                );
            }
        }
        ShapeKind::Tick => {
            let (lo_x, hi_x) = (x0.min(x1), x0.max(x1));
            let (lo_y, hi_y) = (y0.min(y1), y0.max(y1));
            let (w_, h_) = (hi_x - lo_x, hi_y - lo_y);
            line(out, lo_x, lo_y + 0.55 * h_, lo_x + 0.35 * w_, hi_y, h);
            line(out, lo_x + 0.35 * w_, hi_y, hi_x, lo_y + 0.08 * h_, h);
        }
        ShapeKind::Cross => {
            let (lo_x, hi_x) = (x0.min(x1), x0.max(x1));
            let (lo_y, hi_y) = (y0.min(y1), y0.max(y1));
            line(out, lo_x, lo_y, hi_x, hi_y, h);
            line(out, hi_x, lo_y, lo_x, hi_y, h);
        }
    }
    out.push_str("S\nQ\n");
}

fn text_ops(out: &mut String, t: &Text, h: f32, pal: Palette) {
    let (r, g, b) = t.color.rgb(pal);
    out.push_str("q\nBT\n");
    let _ = writeln!(out, "/{TEXT_FONT} {} Tf", num(t.size));
    let _ = writeln!(out, "{} {} {} rg", num(r), num(g), num(b));
    let _ = writeln!(out, "{} TL", num(t.size * 1.25));
    let _ = writeln!(out, "{} {} Td", num(t.pos[0]), num(h - t.pos[1]));
    for (i, ln) in t.content.split('\n').enumerate() {
        if i > 0 {
            out.push_str("T*\n");
        }
        let _ = writeln!(out, "({}) Tj", escape_pdf_text(ln));
    }
    out.push_str("ET\nQ\n");
}

/// Black text block at an absolute PDF-space position (used for the exported
/// notes pages). Lines are pre-wrapped by the caller; escaping happens here.
pub fn text_block_ops(lines: &[&str], x: f32, y_pdf: f32, size: f32) -> String {
    let mut out = String::new();
    out.push_str("q\nBT\n");
    let _ = writeln!(out, "/{TEXT_FONT} {} Tf", num(size));
    out.push_str("0.10 0.10 0.10 rg\n");
    let _ = writeln!(out, "{} TL", num(size * 1.35));
    let _ = writeln!(out, "{} {} Td", num(x), num(y_pdf));
    for (i, ln) in lines.iter().enumerate() {
        if i > 0 {
            out.push_str("T*\n");
        }
        let _ = writeln!(out, "({}) Tj", escape_pdf_text(ln));
    }
    out.push_str("ET\nQ\n");
    out
}

/// PDF content-stream operators for every annotation on `page`, in insertion
/// order (matching on-screen rendering).
pub fn page_ops(page: &Page, pal: Palette) -> String {
    let h = page.height;
    let mut out = String::new();
    for item in &page.items {
        match item {
            Item::Stroke(s) => stroke_ops(&mut out, s, h, pal),
            Item::Shape(s) => shape_ops(&mut out, s, h, pal),
            Item::Text(t) => text_ops(&mut out, t, h, pal),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_pdf_specials_and_non_ascii() {
        assert_eq!(escape_pdf_text(r"a(b)c\d"), r"a\(b\)c\\d");
        assert_eq!(escape_pdf_text("café"), "caf\\351");
        assert_eq!(escape_pdf_text("日本"), "??");
    }

    #[test]
    fn stroke_ops_flip_y_and_are_ascii() {
        let s = Stroke {
            id: 1,
            kind: PenKind::Pen,
            color: Color::Red,
            width: 2.0,
            points: vec![[10.0, 10.0], [20.0, 30.0]],
        };
        let mut out = String::new();
        stroke_ops(&mut out, &s, 800.0, Palette::Standard);
        assert!(out.contains("10.00 790.00 m"));
        assert!(out.contains("20.00 770.00 l"));
        assert!(out.is_ascii());
    }

    #[test]
    fn text_ops_escape_injection_attempt() {
        let t = Text {
            id: 1,
            pos: [5.0, 20.0],
            content: ") Tj ET Q /evil (".into(),
            color: Color::Black,
            size: 12.0,
        };
        let mut out = String::new();
        text_ops(&mut out, &t, 100.0, Palette::Standard);
        // The hostile string must stay inside an escaped literal.
        assert!(out.contains(r"(\) Tj ET Q /evil \() Tj"));
    }

    #[test]
    fn no_negative_zero() {
        assert_eq!(num(-0.0001), "0.00");
    }
}
