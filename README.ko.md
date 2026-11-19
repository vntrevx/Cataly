# Cataly

**의도를 이해하고, 맥락을 읽고, 끝까지 완수합니다.**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [中文](README.zh.md)

Cataly는 목표를 완성된 결과로 만드는 AI 동료입니다. 이루고 싶은 일을 알려주면,
다음 단계를 책임지고 주변 맥락을 고려하며 직접 확인할 수 있는 결과를
낼 때까지 작업을 이어갑니다.

지시를 따르는 데 그치지 않고 올바른 판단을 내리는 것이 목표입니다.
중요한 점을 짚고 세부 사항을 연결하며, 매 단계마다 관리받지 않아도
작업을 처리하는 것을 지향합니다.

## 지향하는 원칙

- **결과를 책임집니다.** 활동 목록을 채우는 대신 목표 달성을 위해 일합니다.
- **맥락을 이해합니다.** 대화, 프로젝트 관례, 제약 조건과 사용자의 선호를
  함께 고려합니다.
- **신중하게 주도합니다.** 일상적인 판단은 스스로 내립니다. 실질적인 절충이
  필요하거나 권한이 없어 사용자의 판단이 필요할 때 질문합니다.
- **끝까지 완수합니다.** 조사하고, 구현하고, 검증한 뒤 실제로 무엇이
  이루어졌는지 보고합니다. 설득력 있는 설명은 작동하는 결과를 대신할 수 없습니다.

Cataly는 이 기준을 중심으로 만들어집니다. 행동할 역량, 맥락을 이해하는
세심함, 그리고 결과에 대한 책임을 갖추는 것입니다.

## 작동 방식

Cataly는 메신저 대화를 네이티브 코딩 에이전트 런타임과 진행 상황을 추적하는
작업 레인에 연결합니다.

- 리드는 작은 요청을 직접 처리하고, 긴 작업에는 작업 설명, 전용 세션과
  책임질 담당자를 지정합니다.
- 작업 로그, 체크포인트와 레지스트리를 통해 재시작 후에도 진행 상황을 확인할 수 있습니다.
- Discord 수신 기능은 답장 맥락과 첨부 파일 메타데이터를 작업에 전달합니다.
- 프로세스에 연결된 세션·승인 기록으로 의도한 에이전트에게 전달되도록 보호합니다.
- 완료 검사는 명령 성공, 파일 일치, 병합된 풀 리퀘스트나 게시된 버전 같은
  구체적인 신호를 확인할 수 있습니다.
- 선택적 스케줄링, 모니터와 감독 기능은 명시적으로 활성화했을 때 지속적인
  작업을 지원합니다.

이 구현은
[dori-superagent](https://github.com/sisyphuslabs/dori-superagent),
[oh-my-pi](https://github.com/can1357/oh-my-pi),
[omp-ulw](https://github.com/dbc-hbin/omp-ulw)를 결합합니다. 각 프로젝트의
저자, 라이선스와 소스 출처는 계속 이 프로젝트의 일부로 남습니다.

## 시작하기

Cataly는 프로젝트 이름입니다. 기존 `dori`, `omp-dori`, `omp` 명령,
설치 홈 디렉터리와 게시된 배포 파일 이름은 바뀌지 않았습니다.

### 소스에서 작업하기

먼저 git, Bun 1.4.4+, herdr 또는 hc를 설치하세요.
자세한 내용은 [소스 사전 요구 사항](docs/releases.md#current-source-bundle)을 참고하세요.

실행 중인 설치나 고정된 사용자용 릴리스가 아닌 별도의 체크아웃을 사용하세요.

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh
```

소스 설치기는 프로젝트에 묶인 수정 OMP 18.22.2와 ULW 오버레이를 준비합니다.
`PATH`에 있는 기본 배포판 `omp`는 이를 대체할 수 없습니다. Side 모드는
기본적으로 `~/.omp-dori`를 사용하며 자체 래퍼와 설정을 유지하고, 주 설치인
`~/.dori`는 건드리지 않습니다. 설치는 에이전트, 메신저 수신기나 서비스를 시작하지 않습니다.

격리, 설정과 명시적 시작 방법은
[소스 설치 가이드](docs/releases.md#source-checkouts-for-maintainers)를
읽어보세요. 네이티브 세션은 본인의 제공업체 인증과 사용량 한도를 사용합니다.

### 게시된 릴리스 사용하기

기존 **v0.1.2 프리릴리스**에는 변경되지 않는 Linux x64 / herdr / Discord
계약이 적용됩니다. 저장소 이름이 바뀌어도 이 배포 파일이 업그레이드되거나
새로운 플랫폼 지원이 생기지는 않습니다.

[검증된 정확한 릴리스 설치 절차](docs/releases.md#prerequisites-and-trust)를 따르세요.
사전 요구 사항, 체크섬, 설치, 본인 인증, 명시적 시작과 선택적으로 활성화하는
Discord 모니터를 다룹니다. 정확한 릴리스 대신 임의의 `main` 설치기를
사용하지 마세요.

사용자용 구현은 검증된 릴리스 매니페스트에 명시된 경우 격리된 macOS arm64 / hc
프로필도 지원합니다. 이는 macOS 릴리스가 게시되었다는 뜻이 아닙니다.
Slack과 Telegram은 여전히 소스 기능입니다.

## 운영 원칙

Cataly는 사용자가 제공한 계정과 권한으로 작동합니다. 외부에 영향을 주는
작업에는 해당 승인이 필요하며, 도움이 될 것이라는 판단만으로 권한이 생기지
않습니다. 실행하려는 세션, 모니터와 서비스만 활성화하세요.

검증에는 한계가 있습니다. 완료 신호가 통과했다는 것은 그 신호에 대한
증거이지 모든 결과를 보장하는 것은 아닙니다. 보고에서는 관찰한 결과,
남아 있는 불확실성과 수행하지 않은 작업을 구분해야 합니다.

인증 정보, 비공개 대화와 계정 데이터를 공개 패치나 보고서에 넣지 마세요.
선택적 텔레메트리는 `DORI_TELEMETRY=0` 또는 `DO_NOT_TRACK=1`로
비활성화할 수 있습니다.

## 문서

- [설치, 지원, 업데이트와 롤백](docs/releases.md)
- [스킬과 운영 규칙](skills/dori-mode/SKILL.md)
- [메신저 설정](skills/dori-mode/references/setup.md)
- [런타임 어댑터와 세션 계약](docs/runtime.md)
- [컨테이너 설정](docs/container.md)
- [스케줄링과 백로그](docs/hourly-loop.md)
- [공유 잠금과 레인 우선순위](docs/locks.md)
- [기여 안내](CONTRIBUTING.md)
- [변경 기록](CHANGELOG.md)
- [라이선스와 소스 출처 표시](LICENSE) · [라이선스 안내](LICENSING.md) · [수정본 고지](NOTICE)

## 기여하기

명확한 목표, 범위가 분명한 변경과 작동한다는 증거를 준비하세요.
[기여 안내](CONTRIBUTING.md)에서 시작하고,
[기존 이슈](https://github.com/vntrevx/Cataly/issues)와
[풀 리퀘스트](https://github.com/vntrevx/Cataly/pulls)를 확인하며,
변경이 필요했던 맥락을 보존하세요.

## 라이선스

라이선스는 각 구성 요소의 출처를 따릅니다. dori-superagent에서 파생된
자료에는 [Sustainable Use License 1.0](LICENSE)이 유지되며,
기존 OMP 통합 부분은 [MIT 라이선스와 저작권 고지](LICENSE.omp-dori)를 유지합니다.
다른 구성 요소도 각자의 조건을 유지합니다. MIT 고지는 저장소 전체를
재허가하지 않습니다. [NOTICE](NOTICE)에 가져온 리비전과
수정본의 출처 표시를 기록합니다.
