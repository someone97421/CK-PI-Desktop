use std::ffi::{OsStr, OsString};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use base64::Engine as _;
use serde_json::{json, Value};
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, CREATE_NEW_CONSOLE, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION,
    STARTUPINFOW,
};

use super::{shell, windows_breakaway_allowed, BashExecutionOptions, WINDOWS_CREATE_BREAKAWAY_FROM_JOB};

type LaunchError = (String, String);

fn invalid(message: impl Into<String>) -> LaunchError {
    ("INVALID_ARGUMENT".into(), message.into())
}

fn wide(value: &OsStr) -> Result<Vec<u16>, LaunchError> {
    let mut units: Vec<u16> = value.encode_wide().collect();
    if units.contains(&0) {
        return Err(invalid("visible process argument contains an embedded NUL"));
    }
    units.push(0);
    Ok(units)
}

// Windows argv escaping; cmd's /C command is appended separately using its own syntax.
fn quoted(value: &OsStr) -> OsString {
    let mut result = vec![b'"' as u16];
    let mut slashes = 0;
    for unit in value.encode_wide() {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        let count = if unit == b'"' as u16 { slashes * 2 + 1 } else { slashes };
        result.extend(std::iter::repeat_n(b'\\' as u16, count));
        slashes = 0;
        result.push(unit);
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    result.push(b'"' as u16);
    use std::os::windows::ffi::OsStringExt;
    OsString::from_wide(&result)
}

pub(super) fn launch(
    workspace: &Path,
    scratch: Option<&Path>,
    command: &str,
    options: &BashExecutionOptions,
) -> Result<Value, LaunchError> {
    if command.contains('\0') {
        return Err(invalid("command contains an embedded NUL"));
    }
    let resolved = shell::resolve_shell(&options.command_shell_id)
        .map_err(|message| ("SHELL_NOT_FOUND".into(), message))?;
    let mut command_line = quoted(resolved.program.as_os_str());
    match options.command_shell_id.as_str() {
        shell::WINDOWS_POWERSHELL_ID | shell::PWSH_ID => {
            let script = format!(
                "$OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding = $OutputEncoding; & {{\n{command}\n}}"
            );
            let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
            command_line.push(" -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ");
            command_line.push(base64::engine::general_purpose::STANDARD.encode(bytes));
        }
        shell::CMD_ID => {
            command_line.push(format!(" /D /V:OFF /S /C \"chcp 65001>nul && {command}\""));
        }
        shell::GIT_BASH_ID => {
            command_line.push(" --noprofile --norc -c ");
            command_line.push(quoted(OsStr::new(command)));
        }
        _ => return Err(invalid("visible console execution requires a Windows shell")),
    }
    let mut command_line = wide(&command_line)?;
    if command_line.len() > shell::MAX_WINDOWS_COMMAND_LINE_UNITS {
        return Err(invalid("command line is too long for Windows"));
    }
    let program = wide(resolved.program.as_os_str())?;
    let workspace = wide(workspace.as_os_str())?;
    let mut environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let mut set_env = |name: &str, value: OsString| {
        environment.retain(|(key, _)| !key.to_string_lossy().eq_ignore_ascii_case(name));
        environment.push((OsString::from(name), value));
    };
    if let Some(scratch) = scratch {
        set_env("PI_SCRATCH_DIR", shell::format_scratch_dir_for_shell(
            shell::dialect_for_id(&options.command_shell_id), scratch,
        ).into_os_string());
    }
    if let Some(path) = shell::user_login_path() {
        set_env("PATH", OsString::from(path));
    }
    for (name, value) in &options.extra_env {
        if name.is_empty() || name.contains(['=', '\0']) {
            return Err(invalid("visible process has an invalid environment variable name"));
        }
        set_env(name, OsString::from(value));
    }
    environment.sort_by_cached_key(|(name, _)| name.to_string_lossy().to_uppercase());
    let mut env_block = Vec::new();
    for (name, value) in environment {
        let mut entry = name;
        entry.push("=");
        entry.push(value);
        env_block.extend(wide(&entry)?);
    }
    env_block.push(0);
    if options.cancellation.as_ref().is_some_and(|receiver| *receiver.borrow()) {
        return Err(("TOOL_ABORTED".into(), "bash aborted before visible process launch".into()));
    }
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    let mut flags = CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT;
    if windows_breakaway_allowed() {
        flags |= WINDOWS_CREATE_BREAKAWAY_FROM_JOB;
    }
    // No inherited handles or STARTF_USESTDHANDLES: Windows attaches all three
    // standard streams to the new console instead of the tool's output pipes.
    let created = unsafe {
        CreateProcessW(
            program.as_ptr(), command_line.as_mut_ptr(),
            std::ptr::null(), std::ptr::null(), 0, flags,
            env_block.as_ptr().cast(), workspace.as_ptr(), &startup, &mut process,
        )
    };
    if created == 0 {
        return Err(("TOOL_FAILED".into(), format!("visible process launch failed: {}", io::Error::last_os_error())));
    }
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    Ok(json!({
        "status": "started",
        "visible": true,
        "processId": process.dwProcessId,
        "commandShellId": options.command_shell_id,
        "stdout": "Command started in a separate Windows console. Output is displayed there; completion and exit code have not been observed.",
        "stderr": "",
        "truncated": false,
    }))
}
