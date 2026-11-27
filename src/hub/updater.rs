//! `update.install`: the lead starts `cataly update` when the owner asked for it (owner decision 12:
//! nothing installs by itself; the owner's request, named by its message, is what starts it). The
//! update runs as its own process outside the hub, because it stops the hub, switches the binary
//! and starts the hub again; it waits for busy sessions as `cataly update` always does (DESIGN 11.3).

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

use super::Hub;
use crate::params as p;
use crate::sys::now_ms;

/// What the updater needs from the hub's environment to find this user's files, service manager and
/// package managers.
const PASSED_ENV: [&str; 6] = [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
];

/// Starts the update and answers at once; the hub stops once the lead's turn has ended.
pub(crate) fn install(hub: &Hub, input: &Value) -> Result<String, String> {
    p::MESSAGE
        .need(input, 400, true)
        .map_err(|_| "message: the owner's message asking for the update".to_string())?;
    let exe = std::env::current_exe().map_err(|e| format!("this binary's path: {e}"))?;
    let log = hub.paths.logs_dir.join("update.log");
    let systemd = cfg!(target_os = "linux") && std::env::var_os("INVOCATION_ID").is_some();
    let mut command = command(&exe, &log, systemd, now_ms(), |name| std::env::var_os(name));
    if !systemd {
        let out = std::fs::File::create(&log).map_err(|e| format!("{}: {e}", log.display()))?;
        let err = out
            .try_clone()
            .map_err(|e| format!("{}: {e}", log.display()))?;
        command.stdout(out).stderr(err);
    }
    command
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("the update did not start: {e}"))?;
    Ok(format!(
        "the update runs on its own (log: {}). It waits up to a minute for busy sessions, then stops \
         the hub, installs the newest release and starts the hub again, which announces the new \
         version. End this turn now so the lead is idle.",
        log.display()
    ))
}

/// The updater's command. Under a systemd user service the hub's own processes are stopped with
/// it, so the updater runs as a transient unit of its own; elsewhere a process group of its own
/// keeps it alive when the hub ends.
fn command(
    exe: &Path,
    log: &Path,
    systemd: bool,
    at_ms: i64,
    env: impl Fn(&str) -> Option<OsString>,
) -> Command {
    if systemd {
        let mut c = Command::new("systemd-run");
        c.args(["--user", "--collect", "--quiet"])
            .arg(format!("--unit=cataly-update-{at_ms}"))
            .arg(format!(
                "--property=StandardOutput=truncate:{}",
                log.display()
            ))
            .arg("--property=StandardError=inherit");
        for name in PASSED_ENV {
            if let Some(value) = env(name) {
                let mut set = OsString::from(format!("--setenv={name}="));
                set.push(value);
                c.arg(set);
            }
        }
        c.arg(exe).arg("update");
        c
    } else {
        use std::os::unix::process::CommandExt;
        let mut c = Command::new(exe);
        c.arg("update").process_group(0);
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(c: &Command) -> Vec<String> {
        c.get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn under_systemd_the_update_is_a_unit_of_its_own_with_the_hubs_paths() {
        let env = |name: &str| (name == "PATH").then(|| OsString::from("/bin:/usr/bin"));
        let c = command(
            Path::new("/opt/cataly"),
            Path::new("/s/logs/update.log"),
            true,
            7,
            env,
        );
        assert_eq!(c.get_program(), "systemd-run");
        assert_eq!(
            args(&c),
            [
                "--user",
                "--collect",
                "--quiet",
                "--unit=cataly-update-7",
                "--property=StandardOutput=truncate:/s/logs/update.log",
                "--property=StandardError=inherit",
                "--setenv=PATH=/bin:/usr/bin",
                "/opt/cataly",
                "update",
            ]
        );
    }

    #[test]
    fn elsewhere_the_binary_runs_update_itself() {
        let c = command(
            Path::new("/opt/cataly"),
            Path::new("/s/logs/update.log"),
            false,
            7,
            |_| None,
        );
        assert_eq!(c.get_program(), "/opt/cataly");
        assert_eq!(args(&c), ["update"]);
    }
}
