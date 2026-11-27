use std::{path::Path, time::Instant};
use tokio::sync::watch;

use super::{
    bump_change_counter, jobs, new_task, register_task, BackgroundTask, BackgroundTaskState,
    TaskShared, MAX_RUNNING_TASKS_PER_SESSION, MAX_RUNNING_TASKS_TOTAL,
};

pub(crate) async fn register_yielded_task(
    st: &mut crate::state::AppState,
    session_id: &str,
    command: &str,
    shell_id: &str,
    workspace: &Path,
    started_at: Instant,
    cancellation: Option<&watch::Receiver<bool>>,
    initial_output: TaskShared,
) -> Result<Option<(BackgroundTask, watch::Receiver<bool>, serde_json::Value)>, String> {
    if st.shutting_down
        || cancellation.is_some_and(|receiver| *receiver.borrow())
        || st.background_tasks.running_count_for(session_id) >= MAX_RUNNING_TASKS_PER_SESSION
        || st.background_tasks.running_count() >= MAX_RUNNING_TASKS_TOTAL
        || !crate::mode_runs::authorization(&st.db, session_id)
            .map_err(|err| err.to_string())?
            .is_some_and(|auth| {
                auth.mode == "agent" && auth.policy == crate::sessions::ToolPolicy::Agent
            })
    {
        return Ok(None);
    }
    let (task, stop_rx) = new_task(
        session_id,
        command,
        shell_id,
        workspace,
        started_at,
        initial_output,
    );
    let snapshot = jobs::snapshot(&task, true).await;
    register_task(&mut st.background_tasks, &task);
    bump_change_counter();
    Ok(Some((task, stop_rx, snapshot)))
}

impl BackgroundTask {
    pub(crate) async fn append_yielded_output(&self, is_stdout: bool, text: &str) {
        if !text.is_empty() {
            self.shared.lock().await.append_output(is_stdout, text);
        }
    }

    pub(crate) async fn finish_yielded(
        &self,
        state: BackgroundTaskState,
        exit_code: Option<i32>,
        error: Option<&str>,
    ) {
        let mut shared = self.shared.lock().await;
        if let Some(error) = error {
            shared.append_output(false, &format!("\n{error}\n"));
        }
        shared.state = state;
        shared.exit_code = exit_code;
        self.settled.send_replace(Some(self.started_at.elapsed()));
        bump_change_counter();
    }
}
