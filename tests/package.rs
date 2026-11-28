//! npm and Bun installs: the `cataly` launcher under Node and Bun (arguments, standard streams,
//! exit status, signals, a missing platform package), and a binary that runs from a package
//! folder: it links its extension, writes a user service that runs it from that folder, and
//! `cataly update` upgrades it through a fake npm or Bun with the ordered hub stop and restart.
//! Everything runs in a temporary home and package prefix.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use support::github::FakeGithub;
use support::release::{
    V1, bump, hub_version, release, stop_hub, target, text, trust_test_key, variant, with_env,
};
use support::{BIN, TestHub, path_without_omp};

fn executable(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A global npm prefix holding the launcher and, unless `platform` is false, a platform package
/// whose `cataly` is `binary_script`. Returns the launcher.
fn launcher_prefix(root: &Path, binary_script: &str, platform: bool) -> PathBuf {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("npm/cataly");
    let package = root.join("lib/node_modules/cataly");
    std::fs::create_dir_all(package.join("bin")).unwrap();
    std::fs::copy(repo.join("package.json"), package.join("package.json")).unwrap();
    let launcher = package.join("bin/cataly.js");
    std::fs::copy(repo.join("bin/cataly.js"), &launcher).unwrap();
    if platform {
        let dir = package.join(format!("node_modules/cataly-{}", target()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            format!("{{\"name\":\"cataly-{}\",\"version\":\"0.0.0\"}}", target()),
        )
        .unwrap();
        executable(&dir.join("cataly"), binary_script);
    }
    launcher
}

fn launch(runtime: &str, launcher: &Path, args: &[&str]) -> Output {
    Command::new(runtime)
        .arg(launcher)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

/// A preload that holds the launcher for a second right after it starts the binary.
const SLOW_SPAWN: &str = "const cp = require(\"node:child_process\");\n\
    const spawn = cp.spawn;\n\
    cp.spawn = (...args) => {\n\
    \tconst child = spawn(...args);\n\
    \tcp.spawnSync(\"sleep\", [\"1\"]);\n\
    \treturn child;\n\
    };\n";

/// Starts the launcher with the binary's `wait` (with `preload` loaded first), sends the launcher
/// a TERM once the binary is ready, and checks that the binary got it and its status is the
/// launcher's. A TERM that ends the launcher instead fails within 20 s, the binary killed.
fn term_reaches_the_binary(runtime: &str, launcher: &Path, preload: Option<&Path>) {
    let mut command = Command::new(runtime);
    if let Some(preload) = preload {
        command
            .arg(if runtime == "bun" {
                "--preload"
            } else {
                "--require"
            })
            .arg(preload);
    }
    let mut child = command
        .arg(launcher)
        .arg("wait")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    // Lines are read off this thread, so a binary left running cannot block the test.
    let stdout = child.stdout.take().unwrap();
    let (tx, lines) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let next = || lines.recv_timeout(Duration::from_secs(20)).ok();
    let deadline = Instant::now() + Duration::from_secs(20);
    while next().as_deref() != Some("ready") {
        assert!(
            Instant::now() < deadline,
            "{runtime}: the binary never got ready"
        );
    }
    Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    let status = child.wait().unwrap();
    let said = next();
    if said.as_deref() != Some("got-term") {
        // The binary still runs: end it, so it does not outlive the test.
        let package = launcher.parent().unwrap().parent().unwrap();
        let _ = Command::new("pkill")
            .args(["-KILL", "-f", &package.display().to_string()])
            .status();
    }
    assert_eq!(
        said.as_deref(),
        Some("got-term"),
        "{runtime} {preload:?}: {status}"
    );
    assert_eq!(status.code(), Some(3), "{runtime} {preload:?}");
}

#[test]
fn the_launcher_runs_the_platform_binary_under_node_and_bun() {
    let root = PathBuf::from(format!("/tmp/cy-launch-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let script = "#!/bin/sh\nprintf 'args:%s|' \"$@\"\necho\necho to-stderr >&2\n\
                  case \"$1\" in\nexit) exit \"$2\" ;;\nsignal) kill -TERM $$ ;;\n\
                  wait) trap 'echo got-term; exit 3' TERM; echo ready; while :; do sleep 0.05; done ;;\n\
                  esac\n";
    let launcher = launcher_prefix(&root.join("with"), script, true);
    let missing = launcher_prefix(&root.join("without"), script, false);
    for runtime in ["node", "bun"] {
        let out = launch(runtime, &launcher, &["a", "b c"]);
        assert!(out.status.success(), "{runtime}: {}", text(&out));
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "args:a|args:b c|\n",
            "{runtime}"
        );
        assert_eq!(String::from_utf8_lossy(&out.stderr), "to-stderr\n");

        let out = launch(runtime, &launcher, &["exit", "7"]);
        assert_eq!(out.status.code(), Some(7), "{runtime}: {}", text(&out));

        let out = launch(runtime, &launcher, &["signal"]);
        assert!(
            out.status.signal() == Some(15) || out.status.code() == Some(143),
            "{runtime}: {}",
            text(&out)
        );

        // A TERM sent to the launcher reaches the binary, which decides how it ends.
        term_reaches_the_binary(runtime, &launcher, None);
        // Also one sent while the launcher has not gone on after starting the binary (a busy
        // machine): the preload holds it there for a second, and the binary is ready meanwhile.
        let slow = root.join("slow-spawn.js");
        std::fs::write(&slow, SLOW_SPAWN).unwrap();
        term_reaches_the_binary(runtime, &launcher, Some(&slow));

        let out = launch(runtime, &missing, &["version"]);
        assert_eq!(out.status.code(), Some(1), "{runtime}");
        let said = String::from_utf8_lossy(&out.stderr);
        assert!(
            said.contains(&format!("cataly-{} is not installed", target())),
            "{runtime}: {said}"
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// The sandbox's PATH with the fake tools in `<root>/bin` first.
fn fake_path(hub: &TestHub) -> PathBuf {
    let mut path = std::ffi::OsString::from(hub.root.join("bin"));
    path.push(":");
    path.push(path_without_omp());
    PathBuf::from(path)
}

/// This build of Cataly in a package folder, with its extension, as npm or Bun leaves it.
fn place_package(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let binary = dir.join("cataly");
    std::fs::copy(BIN, &binary).unwrap();
    let ext = Command::new(BIN).arg("extension").output().unwrap();
    std::fs::write(dir.join("cataly.ts"), ext.stdout).unwrap();
    binary
}

/// A fake package manager at `<root>/bin/<name>`: it logs its arguments and its `BUN_INSTALL`,
/// refuses anything but `expect <spec>` while `<root>/fail` exists or for an unknown version, and
/// otherwise puts the build of that version into `dir`, as a global install would.
fn fake_manager(hub: &TestHub, name: &str, expect: &str, dir: &Path, builds: &[(&str, &Path)]) {
    let cases = builds.iter().fold(String::new(), |mut s, (v, path)| {
        use std::fmt::Write as _;
        let _ = writeln!(s, "'{expect} cataly@{v}') src='{}' ;;", path.display());
        s
    });
    let script = format!(
        "#!/bin/sh\nroot='{root}'\ndir='{dir}'\n\
         echo \"$* BUN_INSTALL=${{BUN_INSTALL:-}}\" >> \"$root/{name}.log\"\n\
         if [ -e \"$root/fail\" ]; then echo 'registry down' >&2; exit 1; fi\n\
         case \"$*\" in\n{cases}*) echo \"unexpected: $*\" >&2; exit 9 ;;\nesac\n\
         cp \"$src\" \"$dir/cataly.part\" && mv \"$dir/cataly.part\" \"$dir/cataly\"\n\
         \"$dir/cataly\" extension > \"$dir/cataly.ts\"\n",
        root = hub.root.display(),
        dir = dir.display(),
    );
    executable(&hub.root.join("bin").join(name), &script);
}

fn run_with(hub: &TestHub, program: &Path, args: &[&str]) -> Output {
    with_env(hub, program)
        .env("PATH", fake_path(hub))
        .args(args)
        .output()
        .unwrap()
}

fn extension_link(hub: &TestHub) -> PathBuf {
    hub.root.join("home/.omp/agent/extensions/cataly.ts")
}

/// A hub running from an npm package links its extension; `cataly update` stops it in order, has
/// npm install the release's version into the same prefix, starts the new binary from the same
/// path and waits for it to answer with the new version.
#[test]
fn an_npm_install_updates_through_npm_and_restarts_the_hub() {
    let v2 = bump(V1, 1);
    let github = FakeGithub::start();
    let mut hub = TestHub::new(&format!(
        "[update]\napi_base = \"{}\"\ncheck = false\n",
        github.base()
    ));
    trust_test_key(&mut hub);
    let new = variant(&v2, false);
    github.publish(&format!("v{v2}"), release(&hub.root.join("r2"), &new, &v2));
    // The binary finds its package through its canonical path; macOS's `/tmp` is a symlink.
    let prefix = std::fs::canonicalize(&hub.root).unwrap().join("npm");
    let dir = prefix.join(format!(
        "lib/node_modules/cataly/node_modules/cataly-{}",
        target()
    ));
    let binary = place_package(&dir);
    let expect = format!("install --global --prefix {}", prefix.display());
    fake_manager(
        &hub,
        "npm",
        &expect,
        &dir,
        &[(V1, Path::new(BIN)), (&v2, &new)],
    );

    let mut first = with_env(&hub, &binary)
        .env("PATH", fake_path(&hub))
        .arg("hub")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    hub.until(Duration::from_secs(30), || {
        (hub_version(&hub).as_deref() == Some(V1)).then_some(())
    });
    assert_eq!(
        std::fs::read_link(extension_link(&hub)).unwrap(),
        dir.join("cataly.ts"),
        "the hub linked its package's extension"
    );

    let out = run_with(&hub, &binary, &["update"]);
    assert!(out.status.success(), "{}", text(&out));
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(said.contains(&format!("cataly {V1} -> {v2}")), "{said}");
    assert!(
        said.contains(&format!("npm(으)로 cataly {v2}을(를) 설치하는 중입니다.")),
        "{said}"
    );
    assert!(
        first.wait().unwrap().success(),
        "the old hub stopped in order"
    );
    assert_eq!(hub_version(&hub).as_deref(), Some(v2.as_str()));
    let log = std::fs::read_to_string(hub.root.join("npm.log")).unwrap();
    assert_eq!(
        log.lines().collect::<Vec<_>>(),
        [format!("{expect} cataly@{v2} BUN_INSTALL=")]
    );
    let out = run_with(&hub, &binary, &["version", "--json"]);
    assert!(String::from_utf8_lossy(&out.stdout).contains(&v2));
    assert_eq!(
        std::fs::read_link(extension_link(&hub)).unwrap(),
        dir.join("cataly.ts"),
        "the link still holds, now to the new extension"
    );

    let out = run_with(&hub, &binary, &["update"]);
    assert!(out.status.success(), "{}", text(&out));
    assert!(
        String::from_utf8_lossy(&out.stdout).contains(&format!("cataly {v2} 버전이 최신입니다")),
        "{}",
        text(&out)
    );
    stop_hub(&hub);
}

/// A Bun install: a failing `bun add` changes nothing; a working one installs into the same
/// `BUN_INSTALL`. Rollback is refused with the command to use, the service runs the binary from
/// the package folder, and uninstall removes the extension link and names `bun remove`.
#[test]
fn a_bun_install_updates_through_bun() {
    let v2 = bump(V1, 1);
    let github = FakeGithub::start();
    // In English: the npm case above speaks the default Korean.
    let mut hub = TestHub::new(&format!(
        "[hub]\nlanguage = \"en\"\n[update]\napi_base = \"{}\"\ncheck = false\n",
        github.base()
    ));
    trust_test_key(&mut hub);
    hub.install_fake("omp");
    // Both service managers are fakes: on macOS a real `launchctl` would start the hub.
    for manager in ["systemctl", "launchctl"] {
        executable(
            &hub.root.join("bin").join(manager),
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$(dirname \"$0\")/manager.log\"\n",
        );
    }
    let new = variant(&v2, false);
    github.publish(&format!("v{v2}"), release(&hub.root.join("r2"), &new, &v2));
    let home = std::fs::canonicalize(&hub.root).unwrap().join("bun");
    let dir = home.join(format!("install/global/node_modules/cataly-{}", target()));
    let binary = place_package(&dir);
    fake_manager(&hub, "bun", "add --global", &dir, &[(&v2, &new)]);

    std::fs::write(hub.root.join("fail"), "").unwrap();
    let out = run_with(&hub, &binary, &["update"]);
    assert_eq!(out.status.code(), Some(6), "held: {}", text(&out));
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(
        said.starts_with("cataly: held: ")
            && said.contains("registry down")
            && said.contains("nothing changed"),
        "{said}"
    );
    std::fs::remove_file(hub.root.join("fail")).unwrap();

    let out = run_with(&hub, &binary, &["update", "--no-restart"]);
    assert!(out.status.success(), "{}", text(&out));
    assert!(
        String::from_utf8_lossy(&out.stdout).contains(&format!("cataly {V1} -> {v2}")),
        "{}",
        text(&out)
    );
    let log = std::fs::read_to_string(hub.root.join("bun.log")).unwrap();
    assert_eq!(
        log.lines().last().unwrap(),
        format!("add --global cataly@{v2} BUN_INSTALL={}", home.display())
    );
    let out = run_with(&hub, &binary, &["version", "--json"]);
    assert!(String::from_utf8_lossy(&out.stdout).contains(&v2));

    let out = run_with(&hub, &binary, &["rollback"]);
    assert_eq!(out.status.code(), Some(6), "{}", text(&out));
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("bun add --global cataly@<version>"),
        "{}",
        text(&out)
    );

    // The service Cataly created runs the package's binary, a path the next upgrade keeps.
    let root = hub.root.join("home/.local/share/cataly");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("service"), "").unwrap();
    let out = run_with(&hub, &binary, &["service", "refresh"]);
    assert!(out.status.success(), "{}", text(&out));
    if cfg!(target_os = "linux") {
        let unit =
            std::fs::read_to_string(hub.root.join("config/systemd/user/cataly.service")).unwrap();
        assert!(
            unit.contains(&format!("ExecStart={} hub\n", binary.display())),
            "{unit}"
        );
    } else {
        let agent = std::fs::read_to_string(
            hub.root
                .join("home/Library/LaunchAgents/dev.cataly.hub.plist"),
        )
        .unwrap();
        assert!(
            agent.contains(&format!("<string>{}</string></array>", binary.display())),
            "{agent}"
        );
    }
    std::fs::remove_file(root.join("service")).unwrap();

    std::fs::create_dir_all(extension_link(&hub).parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(dir.join("cataly.ts"), extension_link(&hub)).unwrap();
    let out = run_with(&hub, &binary, &["uninstall"]);
    assert!(out.status.success(), "{}", text(&out));
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("bun remove --global cataly"),
        "{}",
        text(&out)
    );
    assert!(std::fs::symlink_metadata(extension_link(&hub)).is_err());
    assert!(binary.exists(), "the package manager's files are its own");
}
