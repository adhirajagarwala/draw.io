//! Bounded undo/redo command stack.

use crate::model::{Item, Surface};
use std::collections::VecDeque;

pub const MAX_HISTORY: usize = 200;

#[derive(Clone, Debug)]
pub enum Command {
    /// An item was added to `surface`.
    Add { surface: Surface, item: Item },
    /// Items were removed from `surface` (eraser/delete). Each item carries the
    /// index it occupied so undo can restore it to its original z-position.
    Remove {
        surface: Surface,
        items: Vec<(usize, Item)>,
    },
    /// An item on `surface` was replaced in place (moved, resized or edited).
    Replace {
        surface: Surface,
        old: Box<Item>,
        new: Box<Item>,
    },
}

#[derive(Default)]
pub struct History {
    undo: VecDeque<Command>,
    redo: Vec<Command>,
}

impl History {
    pub fn push(&mut self, cmd: Command) {
        if self.undo.len() >= MAX_HISTORY {
            self.undo.pop_front();
        }
        self.undo.push_back(cmd);
        self.redo.clear();
    }

    pub fn pop_undo(&mut self) -> Option<Command> {
        let cmd = self.undo.pop_back()?;
        self.redo.push(cmd.clone());
        Some(cmd)
    }

    pub fn pop_redo(&mut self) -> Option<Command> {
        let cmd = self.redo.pop()?;
        if self.undo.len() >= MAX_HISTORY {
            self.undo.pop_front();
        }
        self.undo.push_back(cmd.clone());
        Some(cmd)
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }

    /// True if any queued command targets a sketch surface (whose note index
    /// can shift when notes are added, removed, or reordered).
    pub fn references_sketch(&self) -> bool {
        let is_sketch = |c: &Command| {
            matches!(
                match c {
                    Command::Add { surface, .. } => surface,
                    Command::Remove { surface, .. } => surface,
                    Command::Replace { surface, .. } => surface,
                },
                Surface::Sketch(_)
            )
        };
        self.undo.iter().any(is_sketch) || self.redo.iter().any(is_sketch)
    }
}
