# WF-001：Windows 本地适配与验证

日期：2026-10-30（Asia/Hong_Kong）。基线：`543939e52577b7ad013d0cfe330584c60639b145`，分支 `codex/windows-support`。本报告描述个人 Fork 中的本地实现，不声称上游已经验收或发布。

## 已实现

Windows 本地 NTFS 上复用原 SQLite Adapter、领域逻辑、MCP HTTP 服务和浏览器页面；没有复制 Map 实现，也没有增加 MCP 工具。新增独立 `windows-local` 操作者入口，提供 `init / serve / status / stop / desk / backup / client-config`。

- **私有存储**：当前 Windows 用户拥有数据目录和文件；DACL 只允许该用户、SYSTEM、Administrators，目录必须给当前用户有效且可继承的完整控制。创建时直接使用受保护 ACL。包括仅继承到子项的陌生 ACE 也拒绝，不等写入后才发现泄露。已有不安全 ACL 不自动修复。高权限系统/管理员可访问是与 POSIX root 相当的本地边界。
- **路径**：限定本地固定 NTFS 卷、规范绝对路径；检查祖先所有权和不可信删除/修改/ACL 权利。拒绝重解析点、junction、符号链接、短路径别名、硬链接、UNC/设备/ADS/DOS 保留名及尾点/尾空格别名。规范数据库与备份继续拒绝仓库、worktree 和临时目录。WAL/SHM/journal 受同一策略保护。
- **运行**：Node 仍精确钉在 26.3.0；独立默认目录 `%USERPROFILE%\.wayfinder-windows`、端口 18876，可用 `WAYFINDER_WINDOWS_HOME` 选其他实例。固定实例管道持有独立随机控制令牌，优雅停止不依赖 PID；崩溃遗留记录不会导致杀错进程。不加载 `.env.local`，不写日常 Agent 全局配置，不设开机或定时任务。
- **安全答题**：服务继续生成独立的 256-bit 进程钥匙。Chrome 的独立私有资料目录与匿名调试管道承接 `#key` URL；无调试 TCP 端口。钥匙不进入 argv、环境、剪贴板、HTML、控制台、MCP 或 Map。页面沿用现有片段清理、同源写入、停手窗口、Take 与 Settlement 边界。停止清钥匙，重启换钥匙。
- **客户端**：私有连接 JSON 是客户端适配输入；自研 Agent 显式映射 URL/header，传递服务器初始化说明和工具描述。版本化工作流仍由服务携带，Skill 是方法补充。没有设定或改变模型。
- **行尾**：Git 属性保留 LF，工作流构建也把 CRLF 规范为 LF；初始化、工具说明与 Resource 在 Windows 上保留相同段落。Skill 原文和登记哈希没有改写。

使用说明：[docs/windows.md](../windows.md)。历史 `local-mcp-service.md` 的“永不迁移”描述已修正为当前源码实际行为：服务以 `migrate: true` 打开已识别的 format 1，先一致备份再事务迁移；不自动初始化、修复或重置。

## 实际环境

| 项目 | 实际值 |
| --- | --- |
| 系统 | Windows 11 专业版，10.0.26200，x64 |
| 运行时 | Node.js 26.3.0，npm 11.16.0 |
| SQLite | 内嵌 3.53.1（实际查询） |
| 浏览器 | Chrome 156.0.8078.76，分别运行 headless 和可见窗口 |
| MCP | 官方 client 2.4.0、server 2.4.0、node 2.1.2；包版本未升级，client 因 stdio 转接移入运行时依赖 |
| 协议 | 实际 SDK 连接协商 2025-11-25 与 2026-07-28 |
| 运行时位置 | `C:\Users\ttx\.cache\wayfinder-windows\node-v26.3.0-win-x64`，官方 ZIP 经同版 SHASUMS256 校验 |

没有切换 nvm 默认 Node，没有读取/复用真实 Map，没有接入维护者的日常服务或 18766，没有运行 ChatGPT 隧道。

本次未暴露 Dify MCP 的 health/recall 工具，按召回技能停止该操作，继续依据本地规格、ADR 和源码；没有读取凭据修复连接。恢复方法见 [Dify MCP 接入指南](https://dify-mcp.speedstarsunblocked.online/)，安装/更新后完全重启 Agent。

## 实测与证据

`tests/helpers/windows-smoke.mjs` 从空闲端口、全新私有目录和合成数据启动真正的 `dist/windows-local.js` 进程，使用安装的 MCP SDK 和 Windows Chrome；清理只涉及它自己创建的根目录与进程。两次完整 smoke（headless、可见窗口）均通过：

1. `init`、`client-config`、`serve`、`status` 和命名管道 `stop` 实际执行；关闭进程正常退出为 0。
2. 真正发现且仅发现 `map_create / map_list / map_read / map_apply / map_wait`。获取初始化说明中的实际开发 Release Version，未伪造发布版本。
3. 创建 Map Revision 1；一次原子批次创建 Ticket、取得 Claim 并发布 Desk Question，提交 Revision 2。陈旧 Revision 发生 Conflict；显式合成新请求中的非法后续命令使整个批次拒绝，前面的 Notes 改动不落库。
4. Chrome 经匿名管道打开页面，地址片段清空，DOM 和 Web Storage 无钥匙；浏览器页面实际点击选项并走原 `POST /api/desk`，答复保留在 Revision 2 之外。
5. 关闭 MCP、停止并重启服务，新的 SDK 会话读取到相同完整 Map、Claim 和答复；钥匙轮换，旧钥匙写入得到 403。
6. `map_wait` 取到答复，`ticket.settle` 引用当前 Desk Answer，提交 Revision 3。按旧 Revision 读取历史；另一现代协议客户端接续读取。
7. 服务运行时执行一致备份，独立 `openSQLite` 验证 Revision 3、Settlement 和 Taken 答复；再次关闭/重开原库读取 Revision 1。
8. 控制台和持久调用元数据不含令牌、钥匙、私有路径或合成决定正文；调用元数据没有缺失观察。

安全与共享回归命令：

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run --silent build
npm.cmd run --silent typecheck
npm.cmd run --silent test:windows
node tests/helpers/windows-smoke.mjs
$env:WAYFINDER_WINDOWS_VISIBLE_BROWSER = '1'
node tests/helpers/windows-smoke.mjs
git diff --check
npm.cmd audit --omit=dev --json
```

最终测试计数与默认实例状态见下方 closeout。Windows 测试入口覆盖共享领域、原子 Revision、Claims、Settlements、Frontier、MCP schemas/tools、回应处理、工作流/发版门、SQLite 持久化、Answer Desk 和 map_wait，以及 Windows ACL/路径/迁移。POSIX chmod/uid/symlink 拒绝用例在 Windows 上明确跳过，由 Windows 安全测试中的实际 ACL/junction/hardlink 检查对应覆盖。

原系统 Temp 有额外本机组的 Modify ACL，因此正确被拒绝；测试入口改用用户目录中的新私有 scratch 根目录。初次回归还发现 CRLF 破坏 Skill 哈希和工作流段落；以 LF 属性和构建规范化解决，未重算哈希。Windows 管道请求避免半关闭后再等响应，停止路径已随独立进程重启验收。

本机 Windows PowerShell 的默认 stdin 编码实际为 Big5；ACL 桥显式设为 UTF-8。九项 Windows 安全用例全部在带中文和空格的真实路径中执行，包括初始化、侧文件、钥匙、备份及旧格式迁移。不存在的驱动器也会立即拒绝，不会在查找祖先时循环。

最终可见窗口重跑发现，Chrome 的 Windows 原生遮挡优化会将被调用方应用覆盖的正常窗口报告为 `document.hidden`，暂停现有查看页轮询，答题钥匙片段也随之延后读取。独立空白页复现确认后，专用 Chrome 启动参数增加 `--disable-backgrounding-occluded-windows`；助手进程仍隐藏，交互浏览器不继承隐藏启动选项。没有修改查看页的可见性判断、轮询或钥匙协议。修复后完整可见窗口 smoke 通过。

曾尝试用 Computer Use 检查合成空白窗口；该工具因无法可靠识别浏览器 URL 而停止，之后未继续使用它。上述定位和最终验收使用受控合成进程的 CDP 管道与 SDK，不能视为人工桌面验收。

## 变更文件

| 文件 | 用途 |
| --- | --- |
| `.gitattributes` | Windows 检出 LF 约定 |
| `src/private-paths.ts` | Windows ACL/卷/祖先/别名策略及共享私有路径辅助 |
| `src/sqlite-internal.ts` | 平台策略接入，初始化/打开/备份继续复用原 Adapter |
| `src/viewer-key.ts` | 钥匙发布沿用同一私有文件策略 |
| `src/call-metadata.ts` | Windows 调用元数据的私有 ACL 验证 |
| `src/windows-browser.ts` | Chrome 匿名管道交接与进程生命周期 |
| `src/windows-local.ts` | 独立本地实例与操作者命令 |
| `src/windows-mcp-stdio.ts` | 同实例的 stdio/HTTP 透明转接，规避客户端系统代理路径 |
| `scripts/build-workflow.mjs` | CRLF 规范化 |
| `scripts/test-windows.mjs` | Windows 共享回归与私有 scratch 管理 |
| `tests/windows-security.test.ts` | ACL、祖先、继承 ACE、路径、链接、迁移和备份 |
| `tests/helpers/windows-smoke.mjs` | 实际 SDK/浏览器/重启端到端验证 |
| `tests/helpers/windows-codex-smoke.mjs` | stdio 初始化/目录一致性、代理隔离、读写等待、退出与重连 |
| `tests/sqlite-storage.test.ts` | 共享存储测试识别平台权限策略 |
| `tests/viewer-desk.test.ts` | 补充 POSIX 已有 owner-read-only 钥匙的替换兼容性回归 |
| `tests/mcp-tools.test.ts`, `tests/workflow-build.test.ts` | 验证规范化工作流内容 |
| `package.json`, `package-lock.json` | windows/test:windows 命令及 client 运行时依赖；包版本仍 5.0.0，依赖版本未升级 |
| `README.md`, `docs/windows.md`, `docs/implementation/local-mcp-service.md` | 使用入口、说明与迁移勘误 |
| `CHANGELOG.md` | 新增 Unreleased，未发布/打 tag |
| 本报告 | 实现、环境、证据及范围记录 |

## 追加：POSIX 兼容性与内置浏览器验收

用户在首次交付后要求确认 macOS 能力未被破坏，并授权内置浏览器验收。本次复查发现原共享钥匙辅助会把 POSIX 的 owner-only 判断收紧成精确 0700/0600，还额外要求规范绝对路径；这超出“只增加 Windows 适配”的意图。已把 `viewer-key.ts` 的非 Windows 分支恢复为原有判断，临时钥匙的额外 ACL 检查仅在 Windows 执行；SQLite 的非 Windows 私有权限判断也恢复为原逻辑。macOS 的 APFS/HFS 检查、临时路径拒绝、初始化/备份目录模式和 `scripts/wayfinder-agent/` 文件保持原有行为/内容。

新增回归用例验证已有 0400 私有钥匙仍可被当前进程原子替换成 0600 钥匙。在本机 Ubuntu 24.04 / WSL 的真实 Linux 文件系统中，以独立、经官方 SHA-256 校验的 Node 26.3.0 运行当前工作区副本：**4 个文件、121 项全部通过**，包括 `sqlite-storage`、`viewer-desk`、`call-metadata`、`mcp-service`。覆盖真实 POSIX chmod/uid/symlink、SQLite/WAL、MCP 两种协议、进程终止/重启，以及原 Python 启动器的钥匙交接测试；没有接入日常服务。初次隔离副本缺少脚本/Git HEAD，且继承的 077 umask 使刻意创建的 0644 不安全文件变成 0600；补齐副本、使用测试正常的 022 umask 后全部通过，没有修改产品规则或跳过失败用例。Linux 实测不等于 macOS 原生验收。

随后在独立合成 Windows 实例中，使用 Codex 内置浏览器实际操作：

1. 从地图列表进入 Revision 2，打开 Ticket 详情，确认 Claim；无钥匙时答题按钮禁用。
2. 验收助手在本地读取该合成实例的私有进程钥匙，通过浏览器的片段导航加载新文档；片段消费后才采集界面，钥匙没有进入聊天输出、截图、DOM、剪贴板或持久 Web Storage。未改变产品的 Chrome 专用安全交接入口。
3. 实际点击选项 A，页面显示“已提交”和“已答 1”；独立 MCP SDK 确认选项 1 已保存且仍为 Revision 2。此链路没有用测试端 HTTP 提交代替浏览器点击。
4. 真正停止并重启同一合成服务，SDK 确认 Claim/答复保留；内置浏览器重新载入后仍显示该答复，并按无钥匙规则禁用修改。
5. SDK 经 `map_wait` 取答并引用该答案结算；没有手动刷新，内置浏览器自动显示 Revision 3、“已结算 1”和“采用范围 A”。

结果与截图位于被忽略的 `.scratch/windows-evidence/`：`posix-result.json`、`windows-security-followup.json`、`iab-events.json`、`iab-readonly.jpg`、`iab-answered.jpg`、`iab-settled.jpg`。Windows 的九项安全测试在修正后独立重跑也全部通过。合成实例和其 Map 在验收结束后清理，默认实例保持空白。

## 追加：Codex 本机接入故障

用户实际在新聊天试用时，Agent 未收到五工具并按 Skill 停止；没有创建 `Game.DesignWorkflow`，也没有真实决策写入。这是本地接入缺陷，不能算已经通过 Codex 验收。此前检查只用了 npm Codex CLI 的 `mcp get` 读取配置，再单独运行 header helper 和 SDK；该检查没有验证桌面客户端的真实 MCP 启动路径，验收覆盖不足。

诊断发现：

- 失败聊天的客户端日志确认已经读到 `wayfinder_windows`，随后先报 `omitting pending optional MCP server`，再报 `without an exact ready client`。不是单凭 Agent 的文字判断工具缺失。
- 检查时默认实例的 `status` 为 stopped、TCP 连接被拒绝，先前的前台执行会话也已不存在。没有足够证据确定进程何时、因何退出，不能据此断言 SQLite 或服务崩溃。改为隐藏的独立 `Start-Process` 启动，跨多个独立诊断命令仍保持 running。
- 以桌面实际内置的 `codex.exe`（0.166.0-alpha.5.1）启动独立诊断实例，通过正式 app-server 协议调用 `config/read` 和 `mcpServerStatus/list`：原 HTTP 配置复现初始化 HTTP 502。只为该诊断进程增加本机地址 `NO_PROXY` 后，同一二进制成功发现五工具、两份 Resource，耗时约 7 秒。系统代理路径是可重复的故障；另有超过可选 MCP 默认 1 秒等待期的问题。没有改 Windows 代理或全局环境变量。

修复新增 `mcp-stdio`：凭据由 Windows CLI 从自己的私有配置读取，原始消息转发到原回环 MCP；初始化说明、五工具及其 schemas、Resource、Prompt、Release Version 和地图状态继续来自 HTTP 服务。失败只输出固定提示并关闭连接，不打印错误正文或自动重放。转接退出不停止服务。官方 client 2.4.0 从开发依赖移到运行时依赖，锁定版本没有变化；运行时 audit 仍为 0。

本机项目 `.codex/config.toml` 已改为这条 stdio 接入，限定转接进程的 Node 代理环境，设置 `required = true`、等待实际连接、启动超时 60 秒及工具超时 1800 秒。该配置通过本地 `.git/info/exclude` 忽略，没有改 Codex 全局配置。旧的私有 header helper 已不再被活动配置引用。

独立合成测试 `windows-codex-smoke.mjs` 已通过：2025-11-25 与 2026-07-28 两种协议；原服务与转接的完整五工具目录、初始化说明、Resource/Prompt 一致；带不可用代理环境的连接；实际创建/读取/等待；关闭 Agent 后服务继续运行；重启后同一 Revision 保留；服务不可用时连接失败；日志不含凭据、私有路径或决定正文。第一次测试把已有的 `map_wait` 无答案结果错误断言为 `timeout`；按现有契约修正为 `none_yet` 后通过，没有改产品语义。证据为 `.scratch/windows-evidence/stdio-result.json`。

桌面同版本 app-server 引擎使用新的 stdio 配置也成功发现五工具及两份 Resource（约 10 秒），脱敏结果记录于 `.scratch/windows-evidence/codex-engine-stdio.json`。这证明该版本的实际 MCP 引擎能启动适配器；它是独立诊断进程，不代表已经运行中的聊天已重新加载工具。当前聊天在本轮开始时的工具目录仍无 Wayfinder，需用户重启项目 MCP 连接后，在原试用聊天继续完成真实模型验收。没有擅自发送消息、绕过 MCP 创建真实 Map，或自动替人确认 Destination。

补充定向回归：`release`、`release-build`、`workflow-build`、`mcp-tools` 共 **4 个文件、59 项通过**（73.82 秒）。首次直接跑仍使用系统 Temp，26 个 SQLite fixture 被既有 ACL 策略拒绝；随后按 Windows 测试入口约定使用新建私有 TEMP/TMP，全部通过，没有放宽权限判断。构建、typecheck 和 `git diff --check` 通过。本次没有重新跑完整 1,240 项套件；前述完整结果对应 stdio 接入修复前的实现。

Destination 的引导也已纠正：既有工作流要求先在对话确认 Destination 再建图，答题台问题则依附已认领 Ticket。原试用提示中的“所有确认都在答题台”过于宽泛；Windows 文档明确了建图前后顺序。没有改变已接受的领域规则、服务工作流或配套 Skill。

### Codex 重连后的验收更新

2026-10-30 重启客户端后，用户反馈“可以了，可以提交 PR 了”。随后本项目的真实 Codex 会话工具目录实际提供 `map_create`、`map_list`、`map_read`、`map_apply`、`map_wait` 五工具，确认接入修复已由独立引擎诊断推进到真实会话挂载。此检查没有调用工具读取真实 Map，也没有把用户的反馈扩写为完整游戏规划旅程或全部客户端行为测试通过。用户已授权提交 PR；未授权合并或发布。

## 限制与未覆盖

- 真实浏览器与 SDK 验收是自动化合成操作，没有替真人给真实 Ticket 作答。Codex 已补充真实会话五工具挂载及用户试用反馈；完整游戏规划旅程、Claude/ChatGPT 安装客户端的模型行为及人工验收没有执行，不能把 SDK 协议验证视为这些客户端的完整行为验收。
- 此 Windows 切片没有移植原 Python/macOS 专用 Agent 的登录、模型选择、harness 隔离或行为测试运行器。配套 Skill 未自动安装到用户日常配置。
- 本机 Edge 进程对匿名管道探测直接退出而没有响应；首版安全答题只承诺 Chrome。其他浏览器仍可打开不带钥匙的只读入口。
- 已补跑上述 Linux/WSL 回归，但没有可用的 macOS 原生环境，没有实际挂载 FAT/ReFS/网络卷或切换到另一 Windows 用户测试；这些拒绝由平台策略及可在本机执行的路径/ACL 用例覆盖。没有声称 macOS 原生验收、硬件断电恢复、管理员隔离或全盘加密。
- Windows ACL 检查调用固定 Windows PowerShell 子进程，启动、备份和每次调用元数据追加有可观察的额外耗时；没有放宽检查来换速度。私有浏览器 profile 和普通运行日志不会自动轮转。
- `npm ci` 报告依赖树有 3 moderate、2 high；`npm audit --omit=dev` 实际报告运行时依赖漏洞为 **0**。本次没有升级现有开发依赖。
- 实现验收阶段未推送或创建 PR；用户验收后另行授权提交 PR。没有合并、发布或通知外部，全部定时安排保持原状，没有新增自动化。

## Closeout

`npm.cmd run --silent typecheck` 和构建通过。最终 `npm.cmd run --silent test:windows`：**17 files passed，1,240 tests passed，9 skipped（POSIX 专属），共 1,249 项，284.68 秒**。独立重跑九项中文路径安全测试也全部通过。`git diff --check` 通过。

额外使用原有 Node 24.19.0 实际调用 `initializeSQLite`：在文件创建前拒绝，确认目标不存在。默认 Node 设置未改动。

默认空白 Windows 实例已初始化，连接文件为 `%USERPROFILE%\.wayfinder-windows\mcp-client.json`，地图页为 `http://127.0.0.1:18876/`。交付检查以最终构建重启该独立实例，确认 `status` 为 running、HTTP 200，保留运行供用户接入。使用 Node 26.3.0 执行 `node dist/windows-local.js stop` 可以优雅停止；它不依赖后台进程的 PID。实例中没有放入验收 Map，合成数据始终使用其他私有目录。

最终 smoke 的不含凭据结果与截图保存在被忽略的 `.scratch/windows-evidence/`：`result-headless.json` / `windows-desk-headless.png` 与 `result-visible.json` / `windows-desk-visible.png` 分别保留两种模式；`result.json` / `windows-desk.png` 为最近一次。截图展示合成问题，不含钥匙或真实 Map。本报告不含实际凭据、答题钥匙、个人 Map 或聊天正文。
