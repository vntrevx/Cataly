# Cataly

**理解意图。读懂上下文。把工作做到底。**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [中文](README.zh.md)

Cataly 是将目标落地、把工作做完的 AI 队友。告诉它你想达成什么，它会负责
接下来的步骤，结合相关背景，持续推进，交付你可以核验的结果。

追求的不只是遵循指令，更是作出合理判断：注意真正重要的事，串联细节，
处理工作，而不需要有人一步步管理。

## 理念

- **对结果负责。** 朝着目标推进，而不是逐项完成一份活动清单。
- **理解上下文。** 兼顾对话、项目惯例、约束和用户的偏好。
- **主动行动，审慎判断。** 自行处理日常决策。遇到实质性的取舍，或缺少权限、
  需要用户判断时，再提出问题。
- **把工作做到底。** 调查、实现、验证，并汇报实际发生的情况。
  有说服力的解释不能代替真正可用的结果。

这就是 Cataly 构建时遵循的标准：有能力行动，有足够的细心去理解，并对结果负责。

## 工作方式

Cataly 将聊天工具中的对话连接到原生编程代理运行时和可跟踪的工作通道（lane）：

- 主会话直接处理小请求，为较长的任务提供任务说明、专用会话和明确的负责方。
- 工作日志、检查点和注册表让进度在重启后仍可查看。
- Discord 消息接收会将回复上下文和附件元数据带入工作。
- 与进程绑定的会话和审批记录保护向预期代理投递的过程。
- 完成检查可以核验具体信号，例如成功执行的命令、匹配的文件、
  已合并的拉取请求或已发布的版本。
- 可选的调度、监控器和监督机制在明确启用后支持持续工作。

实现整合了
[dori-superagent](https://github.com/sisyphuslabs/dori-superagent)、
[oh-my-pi](https://github.com/can1357/oh-my-pi) 和
[omp-ulw](https://github.com/dbc-hbin/omp-ulw)。它们的作者、许可证和源码来源
仍是本项目的一部分。

## 从这里开始

Cataly 是项目名称。现有的 `dori`、`omp-dori` 和 `omp` 命令、
安装主目录以及已发布资源文件的名称均未更改。

### 从源码开展工作

请先安装 git、Bun 1.4.4+，以及 herdr 或 hc；详情见
[源码版前提条件](docs/releases.md#current-source-bundle)。

请使用独立的检出目录，不要使用正在运行的安装或已冻结的用户发行版：

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh
```

源码安装器会准备与项目绑定的修改版 OMP 18.22.2 和 ULW 覆盖层；
`PATH` 中未经修改的 `omp` 不能替代它们。side 模式默认使用 `~/.omp-dori`，
保留自己的包装脚本和配置，不影响主安装 `~/.dori`。
安装不会启动代理、聊天消息接收器或服务。

请阅读[源码安装指南](docs/releases.md#source-checkouts-for-maintainers)，
了解隔离、配置和显式启动方式。原生会话使用你自己的
提供商认证和使用额度。

### 使用已发布的发行版

现有的 **v0.1.2 预发行版**具有不可变的 Linux x64 / herdr / Discord 契约。
仓库改名不会升级这些资源文件，也不意味着开始支持新的平台。

请遵循[已验证的精确版本安装步骤](docs/releases.md#prerequisites-and-trust)。
其中涵盖前提条件、校验和、安装、你自己的认证、显式启动，
以及选择启用的 Discord 监控器。不要用任意 `main` 安装器替代精确的发行版。

用户发行版的实现也支持隔离的 macOS arm64 / hc 配置，但须由经过验证的发行清单
明确声明。这并不表示 macOS 发行版已经发布。Slack 和 Telegram 仍是源码版功能。

## 运行原则

Cataly 使用你提供的账号和权限工作。对外部系统产生影响的操作需要相应授权；
认为某项操作有帮助，并不意味着获得了权限。只启用你打算运行的会话、
监控器和服务。

验证有其边界。完成信号通过，只能证明该信号已满足，并不能保证每个结果。
报告应区分观察到的结果、尚存的不确定性和未执行的工作。

不要在公开补丁和报告中包含凭据、私人对话或账号数据。
可选遥测可以通过 `DORI_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 关闭。

## 文档

- [安装、支持、更新和回滚](docs/releases.md)
- [技能与操作规则](skills/dori-mode/SKILL.md)
- [聊天工具设置](skills/dori-mode/references/setup.md)
- [运行时适配器与会话契约](docs/runtime.md)
- [容器设置](docs/container.md)
- [调度与待办队列](docs/hourly-loop.md)
- [共享锁与通道优先级](docs/locks.md)
- [贡献指南](CONTRIBUTING.md)
- [变更日志](CHANGELOG.md)
- [许可证与源码署名](LICENSE) · [许可指南](LICENSING.md) · [修改副本声明](NOTICE)

## 参与贡献

请带上明确的目标、范围集中的修改，以及证明其有效的证据。
从[贡献指南](CONTRIBUTING.md)开始，查看
[现有议题](https://github.com/vntrevx/Cataly/issues)和
[拉取请求](https://github.com/vntrevx/Cataly/pulls)，并保留让这项修改成为必要的背景。

## 许可证

许可证依各组件的来源而定。dori-superagent 衍生材料保留
[Sustainable Use License 1.0](LICENSE)；既有 OMP 集成部分保留其
[MIT 许可证和版权声明](LICENSE.omp-dori)。其他组件保持各自的条款。
MIT 声明并未将整个仓库改为 MIT 许可。[NOTICE](NOTICE) 记录导入的修订版本和
修改副本的署名与来源说明。
