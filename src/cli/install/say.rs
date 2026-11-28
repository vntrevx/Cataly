//! What `cataly update` and `cataly rollback` (and the steps `cataly install` shares with them) tell
//! the owner, in his language (`[hub] language`). A developer's error (a file, a network or a
//! store failure) stays as it was said, inside these sentences.

use crate::config::Language;

/// The owner's language for one install command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Say(pub(super) Language);

impl Say {
    /// The prefix of a held outcome.
    pub(super) fn held(self) -> &'static str {
        match self.0 {
            Language::Korean => "보류",
            Language::English => "held",
        }
    }

    /// The prefix of a switched-back outcome.
    pub(super) fn switched_back(self) -> &'static str {
        match self.0 {
            Language::Korean => "되돌림",
            Language::English => "switched back",
        }
    }

    /// The prefix of an outcome that needs the owner.
    pub(super) fn needs_attention(self) -> &'static str {
        match self.0 {
            Language::Korean => "확인 필요",
            Language::English => "needs attention",
        }
    }

    pub(super) fn locked(self) -> String {
        match self.0 {
            Language::Korean => {
                "다른 설치 작업이 진행 중입니다. 그 작업이 끝난 뒤 다시 실행하세요.".into()
            }
            Language::English => "another install operation is running".into(),
        }
    }

    pub(super) fn not_installed(self) -> String {
        match self.0 {
            Language::Korean => {
                "이 컴퓨터에는 Cataly가 설치되어 있지 않습니다. 먼저 install.sh, npm \
                                 또는 Bun으로 설치하세요."
                    .into()
            }
            Language::English => {
                "Cataly is not installed here; use install.sh, npm or Bun first".into()
            }
        }
    }

    /// `why`, then that nothing changed.
    pub(super) fn nothing_changed(self, why: &str) -> String {
        match self.0 {
            Language::Korean => format!("{why}. 아무것도 바뀌지 않았습니다."),
            Language::English => format!("{why}; nothing changed"),
        }
    }

    pub(super) fn up_to_date(self, current: &str, tag: &str) -> String {
        match self.0 {
            Language::Korean => format!("cataly {current} 버전이 최신입니다 (최신 릴리스 {tag})."),
            Language::English => format!("cataly {current} is up to date ({tag} is the release)"),
        }
    }

    pub(super) fn already_installed(self, current: &str) -> String {
        match self.0 {
            Language::Korean => format!(
                "cataly {current} 버전이 이미 설치되어 있습니다. 아무것도 바뀌지 않았습니다."
            ),
            Language::English => {
                format!("cataly {current} is already installed; nothing changed")
            }
        }
    }

    pub(super) fn older_than_installed(self, new: &str, installed: &str) -> String {
        match self.0 {
            Language::Korean => format!(
                "{new} 버전은 설치된 {installed} 버전보다 오래되었습니다. 이전 버전으로는 \
                 `cataly rollback`으로만 돌아갑니다."
            ),
            Language::English => format!(
                "{new} is older than the installed {installed}; only `cataly rollback` goes back"
            ),
        }
    }

    pub(super) fn warning(self, what: &str) -> String {
        match self.0 {
            Language::Korean => format!("경고: {what}"),
            Language::English => format!("warning: {what}"),
        }
    }

    pub(super) fn omp_missing(self) -> String {
        match self.0 {
            Language::Korean => "OMP를 찾지 못했습니다. 허브를 시작하기 전에 설치하세요.".into(),
            Language::English => "OMP was not found; install it before starting the hub".into(),
        }
    }

    pub(super) fn omp_too_old(self, found: &str, minimum: &str) -> String {
        match self.0 {
            Language::Korean => format!(
                "OMP {found} 버전은 이 버전에 필요한 {minimum}보다 오래되었습니다. 먼저 `omp update`로 \
                 OMP를 업데이트하세요."
            ),
            Language::English => format!(
                "OMP {found} is older than the {minimum} this version needs; update OMP first with \
                 `omp update`"
            ),
        }
    }

    /// The files switched from `from` to `to`; a hub that answers stays on `from` (`stays`).
    pub(super) fn switched_files(self, from: &str, to: &str, stays: bool) -> String {
        match (self.0, stays) {
            (Language::Korean, false) => format!("cataly {from} -> {to} 전환을 마쳤습니다."),
            (Language::Korean, true) => format!(
                "cataly {from} -> {to} 전환을 마쳤습니다. 실행 중인 허브는 다시 시작할 때까지 {from} \
                 버전으로 동작합니다."
            ),
            (Language::English, false) => format!("cataly {from} -> {to}"),
            (Language::English, true) => {
                format!("cataly {from} -> {to}; the running hub stays on {from} until it restarts")
            }
        }
    }

    /// `cataly rollback --no-restart`, or a rollback with no hub running.
    pub(super) fn rolled_back_files(self, from: &str, to: &str, stays: bool) -> String {
        match (self.0, stays) {
            (Language::Korean, false) => format!("cataly {from} -> {to} 되돌렸습니다."),
            (Language::Korean, true) => format!(
                "cataly {from} -> {to} 되돌렸습니다. 실행 중인 허브는 다시 시작할 때까지 {from} \
                 버전으로 동작합니다."
            ),
            (Language::English, false) => format!("rolled back: cataly {from} -> {to}"),
            (Language::English, true) => format!(
                "rolled back: cataly {from} -> {to}; the running hub stays on {from} until it \
                 restarts"
            ),
        }
    }

    /// The hub restarted on `to`, answering `answered_ms` after the old one closed.
    pub(super) fn switched(self, from: &str, to: &str, answered_ms: u128) -> String {
        match self.0 {
            Language::Korean => format!(
                "cataly {from} -> {to} 전환을 마쳤습니다. 새 허브가 이전 허브가 닫힌 뒤 \
                 {answered_ms}ms 만에 응답했습니다."
            ),
            Language::English => format!(
                "cataly {from} -> {to}; the new hub answered {answered_ms} ms after the old one \
                 closed"
            ),
        }
    }

    pub(super) fn see_status_install(self, why: &str) -> String {
        match self.0 {
            Language::Korean => format!("{why}. `cataly status --install`을 실행하세요."),
            Language::English => format!("{why}; run `cataly status --install`"),
        }
    }

    pub(super) fn stopped_see_status_install(self, why: &str) -> String {
        match self.0 {
            Language::Korean => {
                format!("{why}. 허브는 멈춰 있습니다. `cataly status --install`을 실행하세요.")
            }
            Language::English => {
                format!("{why}; the hub is stopped; run `cataly status --install`")
            }
        }
    }

    pub(super) fn not_started_again(self, why: &str) -> String {
        match self.0 {
            Language::Korean => format!("{why}. 허브가 다시 시작되지 않았습니다."),
            Language::English => format!("{why}; the hub did not start again"),
        }
    }

    /// The new version did not come up and migrated the store beyond what `was` reads.
    pub(super) fn store_moved_on(self, why: &str, floor: i64, was: &str) -> String {
        match self.0 {
            Language::Korean => format!(
                "{why}. 저장소가 이제 스키마 {floor} 이상을 요구해 {was} 버전은 읽을 수 없습니다. 새 \
                 버전이 선택된 채로 남아 있습니다. 호환되는 저장소 백업을 복원하거나 새 허브를 \
                 고치세요."
            ),
            Language::English => format!(
                "{why}; the store now requires schema {floor}; {was} cannot read it. The new version \
                 remains selected; restore a compatible store backup or repair the new hub."
            ),
        }
    }

    pub(super) fn switch_back_refused(self, why: &str, was: &str, error: &str) -> String {
        match self.0 {
            Language::Korean => {
                format!("{why}. {was} 버전으로 자동으로 되돌리지 않았습니다: {error}")
            }
            Language::English => {
                format!("{why}; automatic switch-back to {was} was refused: {error}")
            }
        }
    }

    pub(super) fn switch_back_failed(self, why: &str, was: &str, error: &str) -> String {
        match self.0 {
            Language::Korean => format!("{why}. {was} 버전으로 되돌리지 못했습니다: {error}"),
            Language::English => format!("{why}; switching back to {was} failed: {error}"),
        }
    }

    /// `version` did not come up (`why`), on its own.
    pub(super) fn did_not_come_up(self, version: &str, why: &str) -> String {
        match self.0 {
            Language::Korean => format!("{version} 버전이 올라오지 않았습니다 ({why})"),
            Language::English => format!("{version} did not come up ({why})"),
        }
    }

    /// `version` did not come up (`why`) and `was` runs again.
    pub(super) fn came_back(self, version: &str, why: &str, was: &str) -> String {
        match self.0 {
            Language::Korean => format!(
                "{version} 버전이 올라오지 않아 ({why}) {was} 버전으로 되돌렸습니다. {was} 버전이 \
                 다시 실행 중입니다."
            ),
            Language::English => format!("{version} did not come up ({why}); {was} runs again"),
        }
    }

    pub(super) fn neither_came_up(self, version: &str, why: &str, was: &str, e: &str) -> String {
        match self.0 {
            Language::Korean => format!(
                "{version} 버전이 올라오지 않았고 ({why}) {was} 버전도 올라오지 않았습니다 ({e})."
            ),
            Language::English => {
                format!("{version} did not come up ({why}) and {was} did not either ({e})")
            }
        }
    }

    pub(super) fn hub_not_started(self, e: &str) -> String {
        match self.0 {
            Language::Korean => format!("허브가 시작되지 않았습니다: {e}"),
            Language::English => format!("the hub did not start: {e}"),
        }
    }

    pub(super) fn no_hub_reported(self, version: &str, seconds: u64) -> String {
        match self.0 {
            Language::Korean => {
                format!("{seconds}초 안에 {version} 버전으로 응답한 허브가 없습니다")
            }
            Language::English => format!("no hub reported {version} within {seconds} s"),
        }
    }

    pub(super) fn hub_did_not_stop(self, e: &str) -> String {
        match self.0 {
            Language::Korean => {
                format!("허브가 멈추지 않았습니다: {e}. 아무것도 바뀌지 않았습니다.")
            }
            Language::English => format!("the hub did not stop: {e}; nothing changed"),
        }
    }

    pub(super) fn hub_did_not_end(self) -> String {
        match self.0 {
            Language::Korean => {
                "허브가 멈추기로 했지만 제시간에 끝나지 않았습니다. 아무것도 바뀌지 않았습니다."
                    .into()
            }
            Language::English => {
                "the hub accepted the stop but did not end in time; nothing changed".into()
            }
        }
    }

    /// Said once when the hub accepted the stop and a voice call winds down first.
    pub(super) fn voice_winding_down(self, seconds: u64) -> String {
        match self.0 {
            Language::Korean => format!("음성 통화를 정리하는 중이에요 (최대 {seconds}초)"),
            Language::English => format!("winding down the voice call (up to {seconds} s)"),
        }
    }

    /// The hub accepted the stop but had not ended once its voice call's bound had passed.
    pub(super) fn voice_did_not_end(self, seconds: u64) -> String {
        match self.0 {
            Language::Korean => format!(
                "허브가 멈추기로 했지만 음성 통화 정리 시간({seconds}초)이 지나도 끝나지 않았습니다. \
                 아무것도 바뀌지 않았습니다. 허브가 멈춘 뒤 다시 실행하세요."
            ),
            Language::English => format!(
                "the hub accepted the stop but had not ended after its voice call's {seconds} s \
                 wind-down; nothing changed. Run it again once the hub has stopped."
            ),
        }
    }

    /// Said once per distinct reason while a busy session holds the switch.
    pub(super) fn busy_waiting(self, busy: &str) -> String {
        match self.0 {
            Language::Korean => {
                format!("작업 중인 세션을 기다리는 중입니다 ({busy}). 최대 60초 기다립니다.")
            }
            Language::English => format!("waiting for a busy session ({busy}), up to 60 s"),
        }
    }

    /// Why the switch is held after 60 s of a busy session.
    pub(super) fn busy_held(self, busy: &str) -> String {
        match self.0 {
            Language::Korean => format!(
                "업데이트가 작업 중인 세션을 기다리고 있습니다 ({busy}). 작업 중인 세션은 멈추지 \
                 않습니다. 작업이 끝나면 다시 실행해주세요. 아무것도 바뀌지 않았습니다."
            ),
            Language::English => format!(
                "the update is waiting for a busy session ({busy}); busy sessions are never \
                 stopped. Run it again once that work is done. Nothing changed."
            ),
        }
    }

    pub(super) fn no_stable_release(self) -> String {
        match self.0 {
            Language::Korean => {
                "아직 안정 릴리스가 없습니다. --tag v<버전>으로 릴리스를 지정하세요.".into()
            }
            Language::English => {
                "no stable release is published yet; name one with --tag v<version>".into()
            }
        }
    }

    pub(super) fn foreign_package(self, dir: &str) -> String {
        match self.0 {
            Language::Korean => format!(
                "이 Cataly는 {dir}에서 실행되지만, 그곳은 전역 npm이나 Bun 설치로 만든 곳이 아닙니다. \
                 그곳에 설치한 패키지 관리자로 업데이트하세요."
            ),
            Language::English => format!(
                "this Cataly runs from {dir}, which no global npm or Bun install made; update it \
                 with the package manager that put it there"
            ),
        }
    }

    pub(super) fn package_from(self, manager: &str) -> String {
        match self.0 {
            Language::Korean => format!(
                "이 Cataly는 {manager}(으)로 설치되었습니다. --from은 install.sh 설치용이니 --from \
                 없이 `cataly update`를 실행하세요."
            ),
            Language::English => format!(
                "this Cataly was installed with {manager}; --from is for install.sh installs, so \
                 run `cataly update` without it"
            ),
        }
    }

    pub(super) fn installing(self, version: &str, manager: &str) -> String {
        match self.0 {
            Language::Korean => {
                format!("{manager}(으)로 cataly {version}을(를) 설치하는 중입니다.")
            }
            Language::English => format!("installing cataly {version} with {manager}"),
        }
    }

    pub(super) fn wrong_package_version(self, found: &str, version: &str) -> String {
        match self.0 {
            Language::Korean => {
                format!("패키지 관리자가 cataly {version}이(가) 아닌 {found}을(를) 설치했습니다")
            }
            Language::English => {
                format!("the package manager installed cataly {found}, not {version}")
            }
        }
    }

    pub(super) fn installed_again(self, why: &str, version: &str) -> String {
        match self.0 {
            Language::Korean => format!("{why}. {version} 버전을 다시 설치했습니다."),
            Language::English => format!("{why}; {version} was installed again"),
        }
    }

    pub(super) fn install_again_failed(self, why: &str, version: &str, e: &str) -> String {
        match self.0 {
            Language::Korean => {
                format!("{why}. {version} 버전을 다시 설치하지 못했습니다: {e}")
            }
            Language::English => format!("{why}; installing {version} again failed: {e}"),
        }
    }

    pub(super) fn runs_again(self, why: &str, version: &str) -> String {
        match self.0 {
            Language::Korean => format!("{why}. {version} 버전이 다시 실행 중입니다."),
            Language::English => format!("{why}; {version} runs again"),
        }
    }

    pub(super) fn did_not_come_back(self, why: &str, version: &str, e: &str, hint: &str) -> String {
        match self.0 {
            Language::Korean => format!(
                "{why}. {version} 버전이 돌아오지 않았습니다 ({e}). `{hint}`(으)로 설치하세요."
            ),
            Language::English => {
                format!("{why}; {version} did not come back ({e}); install it with `{hint}`")
            }
        }
    }

    pub(super) fn package_keeps_no_previous(self, manager: &str, hint: &str) -> String {
        match self.0 {
            Language::Korean => format!(
                "이 Cataly는 {manager}(으)로 설치되어 이전 버전을 보관하지 않습니다. 원하는 버전을 \
                 `{hint}`(으)로 설치하세요."
            ),
            Language::English => format!(
                "this Cataly was installed with {manager}, which keeps no previous version; \
                 install the one you want with `{hint}`"
            ),
        }
    }

    pub(super) fn no_previous(self) -> String {
        match self.0 {
            Language::Korean => "되돌릴 이전 버전이 없습니다.".into(),
            Language::English => "there is no previous version to roll back to".into(),
        }
    }

    pub(super) fn previous_is(self, previous: &str, expect: &str) -> String {
        match self.0 {
            Language::Korean => {
                format!("이전 버전은 {expect}이(가) 아니라 {previous}입니다.")
            }
            Language::English => format!("the previous version is {previous}, not {expect}"),
        }
    }

    /// The `--help` summary of `update` or `rollback` (`path`) in this language; `None` for
    /// English, which is the command table's own summary, and for any other command.
    pub(super) fn help(self, path: &[&str]) -> Option<&'static str> {
        match (self.0, path) {
            (Language::Korean, ["update"]) => Some(
                "최신 안정 릴리스(또는 --tag로 지정한 릴리스, 또는 --from <폴더>)를 설치하고 실행 \
                 중인 허브를 그 버전으로 다시 시작합니다. --no-restart를 주면 허브는 다시 시작할 \
                 때까지 이전 버전으로 동작합니다.",
            ),
            (Language::Korean, ["rollback"]) => Some(
                "이전 버전으로 되돌리고(--expect <버전>으로 어느 버전인지 확인) 실행 중인 허브를 \
                 그 버전으로 다시 시작합니다. --no-restart를 주면 허브는 그대로 둡니다.",
            ),
            _ => None,
        }
    }
}
