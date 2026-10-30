# Windows 本地使用

此分支为 Windows 增加独立的本地入口。服务把 Map、完整 Revision、Claim 和 Answer Desk 状态保存到私有 SQLite；兼容 Streamable HTTP MCP 的 Agent 使用原有五工具。浏览器查看地图和回答问题，Agent 通过 MCP 取回答复并结算。模型由客户端自己的设置决定。

## 准备

需要 Windows、可写的本地 NTFS 用户目录、Node.js **26.3.0**、Git，以及 Chrome。当前实测浏览器见[验证记录](implementation/windows-support-2026-10-30.md)。Windows PowerShell 5.1 用于读取/创建 ACL，不要求管理员、PowerShell profile、全局安装或放宽执行策略。FAT/exFAT、网络盘、UNC、设备路径、目录联接、符号链接、硬链接、仓库和临时目录不适合作为数据库位置。

可从 [Node 官方分发](https://nodejs.org/dist/v26.3.0/)下载 `node-v26.3.0-win-x64.zip`，用同目录 `SHASUMS256.txt` 验证 SHA-256 后解压。保留独立目录，不必改变 nvm 或系统默认 Node。本机已准备的运行时为 `C:\Users\ttx\.cache\wayfinder-windows\node-v26.3.0-win-x64`。

在新的 PowerShell 窗口进入检出，以下 PATH 只作用于当前窗口。显式使用 `npm.cmd` 避免 npm.ps1 的执行策略问题；本次环境原 PATH 过长会使 npm 的 cmd 子进程找不到命令，因此示例限定为构建所需路径：

```powershell
Set-Location D:\wayfinder_map_service
$wfRuntime = 'C:\Users\ttx\.cache\wayfinder-windows\node-v26.3.0-win-x64'
$env:Path = "$wfRuntime;C:\Program Files\Git\cmd;$env:SystemRoot\System32;$env:SystemRoot"
node --version                       # 必须是 v26.3.0
npm.cmd ci --ignore-scripts
npm.cmd run --silent build
```

其他机器请替换运行时、Git 和检出路径。`.gitattributes` 固定 LF；若是在本改动前以 CRLF 检出的旧工作区，Skill 字节哈希检查需要恢复原有 LF 字节。不要重算已安装 Skill 的登记哈希来掩盖行尾差异。

## 初始化与运行

默认实例目录是 `%USERPROFILE%\.wayfinder-windows`，默认端口 **18876**。它与原 macOS 启动器的 `.wayfinder-service`、18766、仓库 `.env.local` 和日常 Agent 配置独立。可在每个操作窗口设置同一个 `WAYFINDER_WINDOWS_HOME` 指向另一个全新绝对路径。

```powershell
# 可选：所有相关窗口使用同一覆盖值
# $env:WAYFINDER_WINDOWS_HOME = Join-Path $env:USERPROFILE '.wayfinder-windows-other'

npm.cmd run --silent windows -- init       # 只在首次运行；可加端口参数
npm.cmd run --silent windows -- serve      # 前台运行；保留此窗口
```

`init` 创建私有目录、新库和随机 MCP 令牌；已有配置或数据库会被拒绝，绝不覆写。`serve` 只打开已有库，识别到 format 1 时先一致备份再迁移到 format 2。重新构建后须显式停止再启动，才使用新代码。

由 Agent 代为启动供其他聊天使用时，须使用独立进程，不能把 Agent 命令会话中的前台进程当作持续服务。本机可用以下方式启动；日志保存在已初始化的私有实例目录，重复启动仍会被实例管道拒绝：

```powershell
$wfInstance = Join-Path $env:USERPROFILE '.wayfinder-windows'
Start-Process -FilePath "$wfRuntime\node.exe" `
  -ArgumentList 'D:\wayfinder_map_service\dist\windows-local.js','serve' `
  -WorkingDirectory 'D:\wayfinder_map_service' -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $wfInstance 'runtime.out.log') `
  -RedirectStandardError (Join-Path $wfInstance 'runtime.err.log')
# 随后用 status 验证已经就绪；保持原有 stop 命令。
```

另一个已配置相同运行时和实例目录的窗口中：

```powershell
npm.cmd run --silent windows -- status
npm.cmd run --silent windows -- stop
```

也可在前台窗口按 Ctrl-C。`stop` 通过带独立随机令牌的本机管道请求优雅关闭，等待服务完成清理，不按 PID 杀进程。崩溃后的 `service.json` 不代表服务仍运行；再次 `serve` 会取得同一实例的管道和端口，再替换运行记录。端口占用直接失败，不自动改端口。关闭 Agent 会话不停止服务，也不释放 Claim。没有开机自启、计划任务或隧道。

## Agent 接入

服务启动后生成独立连接文件：

```powershell
npm.cmd run --silent windows -- client-config
```

它写入实例目录中的私有 `mcp-client.json`，结构为 `mcpServers.wayfinder.url` 和 `headers.Authorization`。URL 为 `http://127.0.0.1:18876/mcp`，令牌只存在本地私有文件中；不要打印、提交、贴进聊天或 Map。把该文件交给客户端的独立 MCP 配置加载器。不同 Agent 的配置键可能不同，需要映射到其 HTTP URL 和 Bearer header 配置；这个 JSON 不是所有 MCP 宿主通用的配置标准。此命令不改任何 Agent 全局配置。

自研 Agent 可直接用 MCP SDK：

```javascript
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const config = JSON.parse(readFileSync(privateClientConfigPath, 'utf8')).mcpServers.wayfinder;
const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(config.url), {
  requestInit: { headers: config.headers },
}));
const tools = await client.listTools(); // map_create/map_list/map_read/map_apply/map_wait
// 把服务器 instructions 和工具描述传给模型；工具调用交回 client.callTool。
// 结束时 await client.close()；不要记录配置或原始认证请求。
```

示例沿用仓库安装的 SDK；其他实现按其 MCP 版本和接口接入。客户端必须把初始化说明和工具描述交给模型。创建、写入、取答复须携带说明中的精确 Release Version；未发布构建有 `+dev...` 后缀，不要写死 `5.0.0`。版本不符时按拒绝结果读取当前工作流 Resource 并遵守恢复规则。`map_wait` 支持普通阻塞调用和已协商的 MCP Tasks；阻塞调用需让工具超时大于 `maxWaitSeconds`，建议客户端工具超时 1800 秒。协议协商不改变 Map 语义。

主配置的所有调用记为 `local-operator` / `Windows-MCP`。不同工作会话仍要使用各自的 Claimant ID。需要区分多个客户端的写入来源时，使用现有操作者[额外凭据接口](implementation/local-mcp-service.md#further-credentials)，不能让模型自报作者。

### 当前 Codex 的项目接入

Windows 系统代理可能使 Codex 的 HTTP MCP 连接访问 `127.0.0.1` 时返回 502。SDK 直连成功不能证明 Codex 的连接也成功。可使用本机 stdio 转接：`mcp-stdio` 从同一私有实例读取凭据，转发到原 HTTP 服务；五工具、初始化说明、Resource、Prompt 和全部状态仍由服务提供。转接不启动或停止服务，不维护第二份地图，也不自动重放失败请求。

在受信任项目的 `.codex/config.toml` 配置如下，替换为本机的绝对路径。这是机器本地配置，应本地忽略，不能提交或覆盖已有配置；不需要修改 Codex 全局配置或 Windows 代理。

```toml
[mcp_servers.wayfinder_windows]
command = 'C:\Users\ttx\.cache\wayfinder-windows\node-v26.3.0-win-x64\node.exe'
args = ['D:\wayfinder_map_service\dist\windows-local.js', 'mcp-stdio']
env = { WAYFINDER_WINDOWS_HOME = 'C:\Users\ttx\.wayfinder-windows', NODE_USE_ENV_PROXY = '0', NO_PROXY = '127.0.0.1,localhost,::1' }
startup_timeout_sec = 60
tool_timeout_sec = 1800
enabled = true
required = true
startup_readiness = 'connection'
```

这些环境变量只作用于此转接进程。`required` 和 `startup_readiness` 要求先完成实际连接，避免可选 MCP 默认 1 秒等待期后工具被略过；本机私有路径检查和握手可能超过 1 秒。连接失败应修复后重启 MCP，不能让 Agent 绕过工具读令牌或直接写服务。保存配置后，在 Codex 的 MCP 设置中重启连接，再重新发起原聊天；配置字段与重启步骤见 [OpenAI MCP 文档](https://developers.openai.com/codex/mcp)。在模型可调用工具前，不把接入标记为完成验收。

## Skill 与规划方法

仓库的 `.agents/skills/wayfinder/SKILL.md` 是配套方法。支持 Skill 的宿主可在独立配置中加载这个目录，或由用户明确选择将其复制到宿主文档规定的位置；本入口不自动安装 Skill，也不修改日常配置。自研 Agent 不会仅因文件名为 `SKILL.md` 就认识它：需要开发者显式读取并接入自己的 Skill 加载机制。

首次规划的顺序是：在对话中确认 Destination → `map_create` 建图 → 认领 Ticket 并发布 Desk Question → 打开答题台。Destination 确认发生在 Map 创建前；“所有决策都在答题台”应指建图后的 Ticket 决策，不能据此跳过 Destination 确认或创建未确认的 Map。

服务同时携带版本化工作流；兼容客户端无需读取仓库 Skill 就可正确使用工具。Skill 提供规划方法，SQLite 服务拥有 Map 权威状态。首次创建前完整分页 `map_list`，选稳定 Map ID；恢复时 `map_read` 当前状态，按 Frontier 认领。冲突后重读、向人报告新 Revision 并停止，直到人看到后发出新请求。连接丢失不会清掉 Claim，也不授权接管或重放旧写入。

## 看图与答题

在浏览器打开 [本机地图列表](http://127.0.0.1:18876/)，或 Agent 返回的 `viewerUrl`。只读入口不需要令牌；能访问本机回环端口的其他本机进程/用户也能读取地图，这沿用现有本地查看页边界。MCP 写入仍需令牌，答题写入另需浏览器钥匙。

Agent 在已认领的 Ticket 上发布 Desk Question 后，由操作者运行：

```powershell
npm.cmd run --silent windows -- desk Your.Stable.MapId
```

它在独立 Chrome 窗口打开带钥匙答题台，查找 Program Files 和当前用户 LocalAppData 下的标准安装路径；不使用默认浏览器配置、`BROWSER`、剪贴板或 HTML 中转。钥匙由服务每次启动独立生成，助手进程从私有文件读取，再通过继承的匿名调试管道传给浏览器；不开调试端口，钥匙不进入命令参数、环境、输出或 MCP。页面读取后立即清除 URL 片段，不写入 DOM、localStorage 或 sessionStorage。浏览器自己的资料目录位于实例的 `browsers/`，需要像数据库一样保持私有；关闭窗口会结束对应助手进程，目录保留供操作者管理。

专用窗口关闭 Chrome 的原生遮挡后台优化，避免打开时被其他应用覆盖就暂停首次轮询和钥匙清理；查看页仍使用原有可见性判断。

刷新页面或重启服务后，请再次执行 `desk`。没有钥匙的地图页仍能看，不能答题。浏览器只提交答复/重开请求；停手 15 秒后 Agent 通过 `map_wait` 或带 Claimant 的当前 `map_read` 取答复，再引用当前 Desk Answer 结算。人类答复本身不创建 Map Revision。

## 一致备份与接续

```powershell
$wfBackup = Join-Path $env:USERPROFILE '.wayfinder-windows-backups\manual-001\maps.sqlite'
npm.cmd run --silent windows -- backup $wfBackup
```

目标必须是全新文件，父目录须满足同样私有 NTFS 策略；可新建私有父目录。命令使用 SQLite `VACUUM INTO`，可在服务运行时得到一致备份，不用资源管理器复制活动数据库。失败产生的文件不算已确认备份，不自动删除或覆盖。备份包含 Map/Revision/Claim/答题记录，不包含 MCP 配置令牌或进程钥匙，也不是自动恢复或导入功能。保留配置与备份时都应使用私有存储。

重启原实例后，Agent 重新连接，按原 Map ID 读取即可接续。相同逻辑会话保留自己的 Claimant；新会话不要自动清除其他会话的 Claim。未知写入结果先读当前状态和相关历史，不自动重试。

## 验证与排查

```powershell
npm.cmd run --silent typecheck
npm.cmd run --silent test:windows
node tests/helpers/windows-smoke.mjs
node tests/helpers/windows-codex-smoke.mjs  # stdio 转接、代理隔离与进程重连
# 可选：让合成验收使用可见的真实浏览器窗口
$env:WAYFINDER_WINDOWS_VISIBLE_BROWSER = '1'
node tests/helpers/windows-smoke.mjs
Remove-Item Env:WAYFINDER_WINDOWS_VISIBLE_BROWSER
```

`test:windows` 为共享领域与适配器测试建立新的私有 scratch 根目录；POSIX 启动器、行为测试 harness 和 POSIX 权限测试不属于该命令，Windows 对应 ACL/junction/hardlink 测试单独覆盖。smoke 使用独立合成 Map、空闲端口和真实 SDK/浏览器，结束后关闭进程、删除自己的私有测试目录，只把不含钥匙的结果和截图留在被忽略的 `.scratch/windows-evidence/`。

| 现象 | 检查 |
| --- | --- |
| 命令失败 | Node 必须为 26.3.0；先构建，先 init；各窗口指向同一实例目录 |
| 私有路径被拒绝 | 选用户目录下的新 NTFS 目录，检查未知可写祖先或额外 ACL；不自动修改已有目录权限 |
| 启动失败 | 18876 是否占用；错误数据库/格式被拒绝；不删除库来消除错误 |
| 新聊天没有五工具 | 先查服务 status；再查 Codex MCP 状态。HTTP 502 检查本机地址是否走代理；优先使用上述项目 stdio 配置并重启连接 |
| 浏览器打不开 | 安装标准目录中的 Chrome，确认本机桌面可用；钥匙只由服务发布 |
| 刷新后不能答题 | 再运行 desk；重启后旧钥匙已经失效 |

原 Python/macOS `scripts/wayfinder-agent/wayfinder` 的模型选择、专用登录与 harness 隔离未移植。本 Windows 入口用于普通 MCP Agent 和本机浏览器，不承担那套专用 Agent 管理。
