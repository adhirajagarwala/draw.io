//! Bounded undo/redo command stack.

use crate::model::Item;
use std::collections::VecDeque;

pub const MAX_HISTORY: usize = 200;

#[derive(Clone, Debug)]
pub enum Command {
    /// An item was added to `page`.
    Add { page: usize, item: Item },
    /// Items were removed from `page` (eraser).
    Remove { page: usize, items: Vec<Item> },
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
}
