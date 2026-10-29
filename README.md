# Wayfinder Map Service

Wayfinder Map Service 是一套与客户端无关的决策地图系统，供 ChatGPT、Codex 以及其他具备 MCP 能力的智能体使用。

它把两条显式工作流合在一起：

- `@grilling` 按轮次探查当前的决策前沿（decision frontier）。
- `@wayfinder` 把长期工作管理为一张持久的地图（Map），记录目的地（destinations）、决策（decisions）、工单（tickets）、依赖（dependencies）、证据（evidence）和修订（revisions）。

服务持有权威状态。客户端通过 `map_create`、`map_list`、`map_read`、`map_apply` 和 `map_wait` 五个 MCP 工具交互。

## 当前状态

`main` 上已接受 M1 地图核心和本地 MCP/SQLite 服务。Node.js 钉在 26.3.0。存储是私有 SQLite：`initializeSQLite(path)` 创建新数据库，`openSQLite(path)` 只打开受支持的已有数据库。领域入口保持纯粹。SQLite 只用于这个本地切片。

服务和它携带的探索工作流共用 `package.json` 里的一个语义化版本号，从 1.0.1 起（[ADR 0004](docs/adr/0004-one-release-version.md)）；升哪一位见[规格 §14.3](docs/spec/mcp-sqlite.md)，每版的变化见 [CHANGELOG](CHANGELOG.md)。普通 PR 只记 Unreleased，发布按[发版车步骤](docs/implementation/releases.md)集中升一次版本；未发布构建报带 dev 后缀的 Release Version。兼容客户端凭 MCP 初始化说明和上述五份工具描述创建、恢复、认领并推进地图。新探索地图以[这份 MCP 工作流](docs/agents/exploration-mcp.md)为唯一权威。发生冲突时，该次请求作废；客户端重读并报告新的 Revision，停到人看到后再发出新请求。

本地 MCP 服务同时提供只读的地图查看页，只能从本机打开：`http://127.0.0.1:<port>/` 列出所有地图，`/maps/<mapId>` 画出一张地图，新 Revision 提交后几秒内自动更新。`map_create` 和 `map_read` 的结果带着这个链接（`viewerUrl`）。查看页不写地图，ChatGPT 测试隧道也不转发它。见[查看页规格](docs/spec/map-viewer.md)和[实现记录](docs/implementation/map-viewer.md)。

4.0.0 默认开启答题台，并移除关闭模式；旧的显式关闭配置会拒绝启动。`wayfinder desk <地图 ID>` 打开只写答复的带钥匙入口；查看、地图编辑和 agent 结算的边界见[实现记录](docs/implementation/answer-desk-viewer.md)。

删除仍在规划，规格尚未接受；回滚 2026-10-25 起不做了。实现跟踪见 [GitHub Issues](https://github.com/LambdaTheory/wayfinder_map_service/issues)，规划入口见 [GitHub 规划地图](docs/planning/README.md)。v1 契约中网页渲染的缩放和过滤、MCP Apps UI、OAuth 和 PostgreSQL 尚未进入这个本地切片。

## 启动

按需的 ChatGPT 测试会话在仓库根目录使用已被忽略的 `.env.local`。其中 `WAYFINDER_DATABASE_PATH` 指向已有私有 SQLite 的绝对路径。启动：

```sh
npm run serv
```

`serv` 即 `chatgpt:test`：先构建，再在 `.env.local` 存在时加载它，然后以前台方式连接 Cloudflare。它不新建数据库。会话期间转发地址公开，且没有用户认证。见[测试手册](docs/implementation/local-chatgpt-test-runbook.md)。

本地 MCP 服务：

```sh
npm run --silent start
```

在进程环境中提供 `WAYFINDER_DATABASE_PATH`、`WAYFINDER_PORT`、`WAYFINDER_TOKEN`、`WAYFINDER_ACTOR_ID` 和 `WAYFINDER_CLIENT_ID`。服务只打开已有的受支持私有库，监听 `127.0.0.1:<port>/mcp`。见[操作者配置](docs/implementation/local-mcp-service.md)。

一致的本地备份：

```sh
npm run --silent backup -- <absolute-source> <fresh-absolute-destination>
```

`--silent` 避免 npm 回显私有路径。见[故障与备份证据](docs/implementation/sqlite-failure-backup.md)。

## 项目文档

- [领域语言](GLOSSARY.md)
- [v1 可执行规格](docs/spec/v1.md)
- [已接受的 M1 实现规格](docs/spec/m1.md)
- [已接受的本地 MCP/SQLite 实现规格](docs/spec/mcp-sqlite.md)
- [Local Map viewer specification and Answer Desk amendment](docs/spec/map-viewer.md)
- [Answer Desk specification — accepted 2026-10-26; default on from 4.0.0](docs/spec/answer-desk.md)
- [已接受的行为测试与验收需求](docs/spec/behaviour-testing.md)（场景库和 Codex 运行器已实现，其余按工单推进）
- [行为测试运行结果](docs/implementation/behaviour-runs.md)
- [专用 Wayfinder Agent 启动器](scripts/wayfinder-agent/README.md)（`wayfinder` 命令）
- [M1 可执行验收矩阵](docs/implementation/m1-acceptance.md)
- [自包含工作流验收](docs/implementation/mcp-self-contained-workflow.md)
- [进行中的规划地图](docs/planning/README.md)
- [M1 规划归档](docs/archive/m1-planning/README.md)
- [ADR 0001：远端地图作为权威状态](docs/adr/0001-remote-map-is-authoritative.md)
- [ADR 0002：MCP 工具是主要接口](docs/adr/0002-mcp-tools-are-the-primary-interface.md)
- [ADR 0003：MCP 服务携带版本化探索工作流](docs/adr/0003-mcp-service-carries-the-versioned-exploration-workflow.md)
- [ADR 0004：服务和工作流共用一个版本号](docs/adr/0004-one-release-version.md)
- [ADR 0005: writes attest the rules version](docs/adr/0005-writes-attest-the-rules-version.md)
- [ADR 0006: keyed answers in the Map viewer](docs/adr/0006-answer-desk-in-the-map-viewer.md)
- [ADR 0007: task-capable Answer Desk delivery](docs/adr/0007-map-wait-for-answer-delivery.md)
- [智能体工作流与项目本地技能](AGENTS.md)
- [Matt Pocock 技能出处](docs/agents/skills-provenance.md)

## 出处

交互方法源自 Matt Pocock 以 MIT 许可证发布的 [`mattpocock/skills`](https://github.com/mattpocock/skills)。本项目保留上游出处，同时维护一份面向收敛、持久化、可移植性与恢复的产品专用改编。
