//! `cataly slot <name> [--lane <key>] [--priority 1-9] [--timeout <duration>] -- <command> [args]`
//! (LANE-10, COORD-31; LANE req. 21, COORD req. 42-46): waits for the named slot, runs the command
//! in this terminal with its own streams, and ends with its exit status. The slot is held until both
//! this client and the command have exited. A stop or interrupt while waiting withdraws the request
//! and exits with 128 plus the signal; one after the grant but before the start runs nothing. While
//! the command runs, TERM and HUP are passed on; a terminal interrupt already reached the command and
//! is not sent twice. After a hub restart the client re-asserts its hold.

use std::io::IsTerminal as _;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::signal::unix::{SignalKind, signal};

use super::exit;

const RECONNECT: Duration = Duration::from_secs(1);

struct Request {
    name: String,
    lane: Option<String>,
    priority: Option<u8>,
    timeout: Option<Duration>,
    argv: Vec<String>,
}

fn usage(why: &str) -> Result<Request, String> {
    Err(format!(
        "{why}; usage: cataly slot <name> [--lane <key>] [--priority 1-9] [--timeout <duration>] -- <command> [args]"
    ))
}

fn parse(words: &[String]) -> Result<Request, String> {
    let Some(split) = words.iter().position(|w| w == "--") else {
        return usage("the command follows '--'");
    };
    let (head, argv) = words.split_at(split);
    let argv: Vec<String> = argv.iter().skip(1).cloned().collect();
    if argv.is_empty() || argv.iter().any(String::is_empty) {
        return usage("no command after '--'");
    }
    let mut it = head.iter();
    let mut req = Request {
        name: String::new(),
        lane: None,
        priority: None,
        timeout: None,
        argv,
    };
    while let Some(w) = it.next() {
        let mut value = || {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{w} needs a value"))
        };
        match w.as_str() {
            "--lane" => req.lane = Some(value()?),
            "--priority" => {
                let p = value()?;
                req.priority = Some(
                    p.parse()
                        .ok()
                        .filter(|p| (1..=9).contains(p))
                        .ok_or("--priority must be 1 to 9")?,
                );
            }
            "--timeout" => {
                let t = value()?;
                req.timeout = Some(
                    crate::config::parse_duration(&t)
                        .ok_or("--timeout needs a duration like 10m")?,
                );
            }
            flag if flag.starts_with('-') => return usage(&format!("unknown flag {flag}")),
            name if req.name.is_empty() => req.name = name.to_string(),
            extra => return usage(&format!("unexpected word {extra}")),
        }
    }
    if req.name.is_empty() {
        return usage("no slot name");
    }
    Ok(req)
}

type Conn = (Lines<BufReader<OwnedReadHalf>>, OwnedWriteHalf);

async fn connect(socket: &Path, params: Value) -> std::io::Result<Conn> {
    super::client::check_socket(socket).map_err(|e| std::io::Error::other(e.to_string()))?;
    let stream = UnixStream::connect(socket).await?;
    let (read, mut write) = stream.into_split();
    let line = format!(
        "{}\n",
        json!({ "v": crate::proto::VERSION, "id": 1, "method": crate::proto::method::SLOT, "params": params })
    );
    write.write_all(line.as_bytes()).await?;
    Ok((BufReader::new(read).lines(), write))
}

fn status_code(status: std::process::ExitStatus) -> u8 {
    use std::os::unix::process::ExitStatusExt as _;
    status.code().map_or_else(
        || u8::try_from(128 + status.signal().unwrap_or(0)).unwrap_or(exit::FAILED),
        |c| u8::try_from(c).unwrap_or(exit::FAILED),
    )
}

fn say(text: &str) {
    super::out::error_line(&format!("cataly slot: {text}"));
}

/// Runs the slot command; returns the exit status.
pub(crate) fn run(words: &[String], socket: &Path) -> u8 {
    let req = match parse(words) {
        Ok(r) => r,
        Err(e) => {
            say(&e);
            return exit::USAGE;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            say(&e.to_string());
            return exit::INTERNAL;
        }
    };
    runtime.block_on(slot(&req, socket))
}

#[allow(clippy::too_many_lines)]
async fn slot(req: &Request, socket: &Path) -> u8 {
    let (Ok(mut int), Ok(mut term), Ok(mut hup)) = (
        signal(SignalKind::interrupt()),
        signal(SignalKind::terminate()),
        signal(SignalKind::hangup()),
    ) else {
        say("signal handlers could not be installed");
        return exit::INTERNAL;
    };
    let params = json!({ "name": req.name, "lane": req.lane, "priority": req.priority });
    let deadline = req.timeout.map(|t| Instant::now() + t);
    let mut conn: Option<Conn> = None;
    let mut place = 0;
    // Wait for the grant.
    loop {
        if conn.is_none() {
            match connect(socket, params.clone()).await {
                Ok(c) => conn = Some(c),
                Err(e) if place == 0 => {
                    say(&format!("the hub is not running ({e})"));
                    return exit::NO_HUB;
                }
                Err(_) => {}
            }
        }
        // Without `--timeout` the wait ends only with a grant or a signal (LANE req. 21).
        let left = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        if left.is_some_and(|l| l.is_zero()) {
            say(&format!(
                "no grant for slot {} within the timeout",
                req.name
            ));
            return exit::FAILED;
        }
        let expired = async {
            match left {
                Some(left) => tokio::time::sleep(left).await,
                None => std::future::pending().await,
            }
        };
        let Some((lines, _)) = conn.as_mut() else {
            tokio::select! {
                () = tokio::time::sleep(left.map_or(RECONNECT, |l| RECONNECT.min(l))) => continue,
                _ = int.recv() => return 130,
                _ = term.recv() => return 143,
                _ = hup.recv() => return 129,
            }
        };
        tokio::select! {
            line = lines.next_line() => {
                let Ok(Some(line)) = line else {
                    // The hub went away while we waited: ask again once it is back.
                    conn = None;
                    place = place.max(1);
                    tokio::time::sleep(RECONNECT).await;
                    continue;
                };
                let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                if let Some(e) = v.get("err") {
                    say(e.get("message").and_then(Value::as_str).unwrap_or("refused"));
                    return exit::FAILED;
                }
                match v.pointer("/item/state").and_then(Value::as_str) {
                    Some("granted") => break,
                    Some("waiting") => {
                        let n = v.pointer("/item/place").and_then(Value::as_u64).unwrap_or(0);
                        if n != place {
                            say(&format!("slot {}: place {n} in the queue", req.name));
                            place = n;
                        }
                    }
                    _ => {
                        conn = None;
                    }
                }
            }
            () = expired => {
                say(&format!("no grant for slot {} within the timeout", req.name));
                return exit::FAILED;
            }
            _ = int.recv() => return 130,
            _ = term.recv() => return 143,
            _ = hup.recv() => return 129,
        }
    }
    // Granted. A signal that arrived meanwhile releases the slot and runs nothing.
    for (sig, code) in [(&mut int, 130), (&mut term, 143), (&mut hup, 129)] {
        if tokio::time::timeout(Duration::ZERO, sig.recv())
            .await
            .is_ok()
        {
            return code;
        }
    }
    let program = req.argv.first().map_or("", String::as_str);
    let mut child = match tokio::process::Command::new(program)
        .args(req.argv.iter().skip(1))
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            say(&format!("{program}: {e}"));
            return 127;
        }
    };
    let pid = child.id().unwrap_or(0);
    let mut hold = conn;
    if let Some((_, w)) = hold.as_mut()
        && w.write_all(format!("{}\n", json!({ "pid": pid })).as_bytes())
            .await
            .is_err()
    {
        hold = None;
    }
    let forward = |sig: rustix::process::Signal| {
        if let Some(p) = i32::try_from(pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        {
            let _ = rustix::process::kill_process(p, sig);
        }
    };
    loop {
        let lost = async {
            match hold.as_mut() {
                Some((lines, _)) => while let Ok(Some(_)) = lines.next_line().await {},
                None => tokio::time::sleep(RECONNECT).await,
            }
        };
        tokio::select! {
            status = child.wait() => {
                return status.map_or(exit::FAILED, status_code);
            }
            _ = int.recv() => {
                // The terminal sent it to the command's process group already.
                if !std::io::stdin().is_terminal() {
                    forward(rustix::process::Signal::INT);
                }
            }
            _ = term.recv() => forward(rustix::process::Signal::TERM),
            _ = hup.recv() => forward(rustix::process::Signal::HUP),
            () = lost => {
                // Re-assert the hold with the running command's pid (COORD req. 46).
                let mut again = params.clone();
                if let Some(map) = again.as_object_mut() {
                    map.insert("pid".into(), json!(pid));
                }
                hold = connect(socket, again).await.ok();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<String> {
        s.split(' ').map(str::to_string).collect()
    }

    #[test]
    fn parses_the_command_after_the_dashes() {
        let r = parse(&words("build --priority 2 --lane web-1 -- make -j 4")).unwrap();
        assert_eq!(
            (r.name.as_str(), r.priority, r.lane.as_deref()),
            ("build", Some(2), Some("web-1"))
        );
        assert_eq!(r.argv, ["make", "-j", "4"]);
        assert!(parse(&words("build make")).is_err());
        assert!(parse(&words("build --")).is_err());
        assert!(parse(&words("build --priority 0 -- x")).is_err());
        assert!(parse(&words("-- x")).is_err());
    }

    /// Runs `slot` against a hub that keeps it waiting for `held`, then grants it.
    async fn granted_after(held: Duration, args: &str) -> u8 {
        let dir = crate::sys::fs::tests::scratch("slot-wait");
        let socket = dir.join("hub.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let hub = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            lines.next_line().await.unwrap();
            let item = |state: &str| {
                format!(
                    "{}\n",
                    json!({ "v": 1, "id": 1, "item": { "state": state, "place": 1 } })
                )
            };
            write.write_all(item("waiting").as_bytes()).await.unwrap();
            tokio::time::sleep(held).await;
            let _ = write.write_all(item("granted").as_bytes()).await;
            // Hold the connection until the client is done.
            while let Ok(Some(_)) = lines.next_line().await {}
        });
        let code = slot(&parse(&words(args)).unwrap(), &socket).await;
        hub.abort();
        code
    }

    /// LANE req. 21: with no `--timeout` a waiter outlasts a slot held for hours; with one it gives
    /// up when the timeout runs out.
    #[tokio::test(start_paused = true)]
    async fn only_a_given_timeout_ends_the_wait() {
        let three_hours = Duration::from_hours(3);
        assert_eq!(granted_after(three_hours, "build -- true").await, 0);
        assert_eq!(
            granted_after(three_hours, "build --timeout 10m -- true").await,
            exit::FAILED
        );
    }
}
