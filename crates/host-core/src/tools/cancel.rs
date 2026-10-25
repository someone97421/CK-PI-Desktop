//! Cooperative cancellation for the blocking file-tool bodies.
//!
//! `tools.abort` flips the tool call's watch flag, but a body already running
//! on the blocking pool cannot be dropped. The flag is installed for the
//! duration of that body so the directory walk, the in-process Grep loop and
//! the `rg` child can stop early instead of finishing work nobody will read.

use std::cell::RefCell;
use tokio::sync::watch;

thread_local! {
    static CURRENT: RefCell<Option<watch::Receiver<bool>>> = const { RefCell::new(None) };
}

pub(super) struct CancellationGuard;

pub(super) fn install(receiver: Option<watch::Receiver<bool>>) -> CancellationGuard {
    CURRENT.with(|current| *current.borrow_mut() = receiver);
    CancellationGuard
}

impl Drop for CancellationGuard {
    fn drop(&mut self) {
        CURRENT.with(|current| *current.borrow_mut() = None);
    }
}

/// The receiver of the body running on this thread, for helper threads.
pub(super) fn current() -> Option<watch::Receiver<bool>> {
    CURRENT.with(|current| current.borrow().clone())
}

/// Whether the tool call running on this thread was aborted.
pub(super) fn cancelled() -> bool {
    CURRENT.with(|current| {
        current
            .borrow()
            .as_ref()
            .is_some_and(|receiver| *receiver.borrow())
    })
}
