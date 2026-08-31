# Claude to Codex (C2C)

[English](README.md) | [Bahasa Indonesia](README.id.md) | **简体中文**

> Claude 负责思考，Codex 负责执行。

## 这是什么

本项目把 Claude 网页版作为 Codex 编码会话的规划与审查大脑，同时把所有执行权保留在 Codex 手里。

不需要 Claude API Key，也不使用逆向代理。Claude 通过一条 OAuth 保护的公网只读 MCP 连接，按需读取当前工作区的信息。

> 本项目基于 [@XiaoDuoYa](https://github.com/XiaoDuoYa) 的 [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) 的原始创意与架构，现已发展为面向 Claude Web 的独立实现，并扩展为一条连接器服务多个 Codex 工作区。感谢原作者的创意。

职责边界很明确：

- Claude：推理、规划、检查、Review。
- Codex：编辑文件、Shell、git、测试、修复和提交。
- C2C Bridge：只读地提供工作区和 Codex 已记录的执行信息。

Claude 不会获得写文件、删除文件、执行任意命令或提交代码的 MCP 工具。

## 环境要求

- Node.js >= 20
- git
- 公网 MCP 连接需要 `cloudflared`
- Claude Web 支持自定义远程 Connector

## 安装

```bash
git clone https://github.com/willio/claude-to-codex.git ~/claude-to-codex
cd ~/claude-to-codex
corepack pnpm install
corepack pnpm build
```

然后把 `skill/SKILL.md` 安装为 Codex Skill，并按照其中的首次配置流程操作。

## 首次配置

运行：

```bash
c2c setup
```

C2C 会启动本地 Bridge、建立公网 HTTPS Tunnel，并返回 MCP 地址和一次性配对码。

接下来在 Claude Web：

1. 打开 **Customize > Connectors**。
2. 用 C2C 提供的 MCP 地址添加 Custom Connector。
3. 完成 OAuth 授权。
4. 在 C2C 授权页面输入一次性配对码。
5. 启用 Connector，然后让 Claude 调用 `workspace_info`，确认连接的是正确工作区。

在 Claude 中添加 Connector 是明确的用户操作。Codex Skill 会准备和诊断本地端，但不会假装可以自动操作 Claude 的 Connector UI。

默认可以使用 Cloudflare Quick Tunnel；其公网地址在重启后可能改变。如果需要稳定地址，可以配置 Named Tunnel。

## 工作流程

协调协议保持极小：

```text
INIT -> PLAN -> EXECUTED -> REVIEW -> DONE
```

Claude 通过 MCP 自己读取源码、git diff、git 状态和 Codex 已记录的执行结果，不需要 Codex 在对话中粘贴大量文件内容或日志。

目前提供 8 个只读 MCP 工具：

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`

其中 `test_status` 和 `execution_summary` 只读取 Codex 已记录的数据，不会执行测试或命令。

## 架构

```text
             +---------------------------+
             |       Claude Web          |
             |    推理 / 规划 / 审查     |
             +-------------+-------------+
                           |
                    Remote MCP + OAuth
                           |
                           v
             +---------------------------+
             |        C2C Bridge         |
             |         只读 MCP          |
             | OAuth + 一次性配对码      |
             |   Cloudflare Tunnel       |
             +-------------+-------------+
                           |
                          只读
                           v
             +---------------------------+
             |         本地工作区        |
             +-------------^-------------+
                           |
                    编辑 / git / shell
                           |
             +-------------+-------------+
             |       Codex Harness       |
             |     执行 / 测试 / 修复    |
             +---------------------------+
```

## 安全模型

- **从构造上只读**：MCP 服务端没有写文件、删除、Shell、commit 或任意执行工具。
- **工作区隔离**：授权绑定单一工作区；路径校验阻止 `../`、绝对路径和 symlink 逃逸。
- **敏感文件策略**：`.env*`、密钥、SSH 和凭据默认拒绝；`.env.example` 可读取，`.c2cignore` 可以继续追加排除规则。
- **公网地址不等于权限**：MCP Endpoint 强制 OAuth；知道 Tunnel URL 本身无法读取工作区。
- **一次性配对**：浏览器只接触短期配对码，不接触本地长期凭据。
- **工作区内容不可信**：源码或文档中的文字只是数据，不能扩大 Claude 的权限。

完整威胁模型见 [docs/security.md](docs/security.md)。

## CLI

```bash
c2c setup
c2c start
c2c status
c2c doctor
c2c pair
c2c unpair
c2c logs
c2c stop
```

`c2c doctor` 用于检查本地 Bridge、Tunnel、Codex Sandbox 配置和 Connector Endpoint。如果 Quick Tunnel 地址改变，它会定位当前工作区需要重新添加的 Claude Connector。

## 兼容策略

这是原 ChatGPT 实现的 Claude 专用 Fork。迁移采用明确的兼容层，而不是简单全文替换。

如果机器上已经存在旧的 `codex-with-chatgpt` App State，而新的 `codex-with-claude` 目录还不存在，C2C 会继续使用旧目录，避免 OAuth、Workspace ID、Endpoint、Session 和执行记录突然丢失。新安装默认使用 `codex-with-claude`。

少量内部常量和机器可读的 `chatgptRepair` doctor 字段（现以 `connectorRepair` 为准）暂时保留历史 ChatGPT 名称，避免已有调用方突然失效。详见 [docs/migration.md](docs/migration.md)。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

CI 会在 Frozen Lockfile 安装后执行 TypeScript 检查、完整测试和 Build。

目录结构：

```text
src/
  auth/       OAuth 2.1、PKCE、DCR、Refresh Rotation、吊销
  bridge/     本机回环 HTTP 服务和管理 API
  cli/        c2c CLI
  execution/  Review 所需的执行记录
  mcp/        只读 MCP 工具
  pairing/    一次性配对码
  process/    Daemon 生命周期
  tunnel/     Cloudflare Quick / Named Tunnel
  workspace/  路径边界、敏感文件策略、搜索、git
skill/        Codex Skill
tests/        单元测试和集成测试
docs/         架构、协议、安全、迁移、故障排查
```

## 当前状态

Claude 适配已经覆盖 Connector Endpoint、OAuth 展示、Codex Skill、App State 兼容、CI，以及核心只读 MCP 安全边界。仍保留的旧 CLI 机器字段只用于兼容，后续应通过有版本的迁移再移除。

非官方社区项目，与 Anthropic 或 OpenAI 均无关联，也未获其背书。

## 许可证

[MIT](LICENSE)
