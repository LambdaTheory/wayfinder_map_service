# 专用 Wayfinder Agent

一个命令开只做 Wayfinder 的 agent：选 harness（Codex 或 Claude Code）、模型、推理强度和方法版本（MCP 版或 Matt 原版），也管本机的 Wayfinder 服务、ChatGPT 测试连接，列出地图和会话。本文件是设计；它是行为测试里被测的「专用 Agent」入口（[规格](../../docs/spec/behaviour-testing.md)），随服务一起版本化。

默认组合是 Codex · gpt-6-astra · xhigh · MCP 版，和 2026-10-23 方法实验的纯净组一致（见 `docs/implementation/wayfinder-method-experiment.md`）。审批和沙箱和日常 Codex 一样：不问、不设沙箱。2026-10-25 前用的是 `on-request` 加 `workspace-write`，沙箱拦住了无界面浏览器截图和联网下载，三次会话里问了 Kun 12 次。

## 用法

```
wayfinder [地图 ID] [--harness codex|claude] [--model 模型] [--effort 档位] [--method mcp|matt] [-- harness 参数]
wayfinder desk <地图 ID>           # 打开带钥匙的答题台（当前版本默认关闭）
wayfinder maps                     # 列出所有地图：MCP 版取自服务，Matt 原版取自产出目录
wayfinder sessions [地图 ID]       # 列出专用 Agent 的会话，可按地图筛，每行给出接着它的命令
wayfinder resume <会话 ID>          # 接着某个会话；harness、方法版本、模型和推理强度按原会话，flag 可改
wayfinder serve | status | stop | restart
wayfinder chatgpt                  # 打开 ChatGPT 测试连接，Ctrl-C 关掉
wayfinder help
```

- flag 只管这一次，不记；不带就回到默认。要长期换默认，改脚本里的 `HARNESSES` 和 `DEFAULT_EFFORT`。
- 模型用各 harness 自己的名字（Codex：`gpt-6-astra`；Claude Code：`opus`、`sonnet`、`haiku` 或全名）。推理强度：Codex 有 minimal、low、medium、high、xhigh；Claude Code 有 low、medium、high、xhigh、max。档位不对，启动前就停下并列出可用的。
- 写了地图 ID，开场就发「继续 Wayfinder 地图 <ID>」。Matt 原版的「地图 ID」是产出目录下的 effort 名字。Agent 建议换会话时，会给出带同样 harness 和方法版本的这行命令。
- 要原样交给 harness 的参数放在 `--` 后面，例如 `wayfinder --effort low -- exec "…"`（Codex 非交互），`wayfinder --harness claude -- -p "…"`（Claude Code 非交互）。
- `wayfinder-matt …` 等于 `wayfinder --method matt …`，先留作别名。
- `login`、`logout`、`update` 被拒绝：登录和更新只在日常的 codex、claude 里做。2026-10-24 在专用会话里更新，npm 用 Agent 的 HOME 运行，弄坏过一次全局 Codex。启动前先跑 `<harness> --version`，全局安装坏了就停下。

地图只在这里推进。别的 Agent 碰到 Wayfinder 工具不可用，应停下并把 `wayfinder <地图 ID>` 交给 Kun；2026-10-25 日常 Codex 读了服务令牌直连服务，第 22–28 版记在了专用 Agent 名下。

## 答题台（默认关闭）

服务以 `WAYFINDER_ANSWER_DESK_ENABLED=true` 启动后，`wayfinder desk <地图 ID>` 在默认浏览器打开该地图的答题模式。命令不会自行打开开关；已有服务的配置以启动时为准。没有钥匙的查看页仍可读地图和答题状态，不能作答。

启动器把 `WAYFINDER_ANSWER_DESK_KEY_FILE` 指到服务目录的 `answer-desk-key`。服务每次启动独立生成 256-bit 随机钥匙，写入当前用户独占的 0700 目录、0600 普通文件；它与 MCP 令牌无关，不交给 harness。停止时清理，重启时替换。启动器只将带 `#key=…` 的地址交给浏览器，不打印地址、不写调用记录。页面读取后立即清掉片段，只在闭包内存中保留；刷新、另开窗口或服务重启后请再次运行命令。直接启动服务的操作者可以用同一环境变量指定已有私有目录中的钥匙文件。

这个入口只允许提交/修改答复、申请重开和撤销尚未取走的重开请求。查看、打开弹窗和取消不提交答案；重开前显示受影响的已结算决定。页面两秒更新一次；15 秒停手窗口由服务计算，计时结束不自动结算。该版本不改变 agent 工作流或交付协议，真实客户端的联合验收留到 #114。

## 四种组合

每种组合一个状态目录，会话记录、配置和说明互不相干：

| | MCP 版 | Matt 原版 |
|---|---|---|
| Codex | `~/.codex-wayfinder/` | `~/.codex-wayfinder-matt/` |
| Claude Code | `~/.claude-wayfinder/` | `~/.claude-wayfinder-matt/` |

- **MCP 版**：技能链到启动器所在仓库检出的 `.agents/skills/wayfinder`（用 `WAYFINDER_AGENT_CHECKOUT` 可换成别的检出），只连本机 Wayfinder 服务。说明来自本目录的 `agent-instructions.md`；本目录里的说明文件不叫 `AGENTS.md`，免得在本仓库里工作的 Agent 把它当目录说明读。启动时按 harness 的约定装进状态目录：Codex 写成 `<状态目录>/AGENTS.md`，Claude Code 写成 `<状态目录>/wayfinder-instructions.md`。
- **Matt 原版**：每次启动从 `~/workspace/runtime/repos/mattpocock-skills/skills` 复制（用 `WAYFINDER_AGENT_MATT_SKILLS` 可改） wayfinder 和它会转交的 grilling、prototype、research、domain-modeling，和方法实验的 M 组一致；原版的 `agents/openai.yaml` 不复制，它关掉了自动调用，留着的话两版的触发方式就不一样了。不连任何 MCP。说明来自 `agent-instructions.matt.md`，安装方式同上。
- **对比两版时**从同一个目录启动。在 wayfinder_map_service 仓库里启动，仓库自己的说明会把地图指向 Wayfinder 服务和 GitHub，Matt 原版会被带偏；只比方法时从 `~` 启动。

## 纯净环境

日常的 hooks、技能、记忆和别的 MCP 都进不来；项目目录里的 AGENTS.md、CLAUDE.md 照常读，这是有意的。

- **Codex**：HOME 换成 `<状态目录>/home`，CODEX_HOME 换成状态目录；清掉 `OPENAI_API_KEY`、`CODEX_API_KEY`、`OPENAI_BASE_URL`。说明写成 `<状态目录>/AGENTS.md`，技能在 `home/.agents/skills/`。`config.toml` 第一次由本目录的模板生成，之后 Codex 可以自己改（比如记下信任过的目录）；模型、推理强度和服务地址每次用命令行参数覆盖。带 `--no-daemon`：不用共享的后台进程，MCP 连接才在这个进程里、拿到这次的令牌。
- **Claude Code**：`CLAUDE_CONFIG_DIR` 换成状态目录，HOME 不换（钥匙串跟着 HOME 走）。技能在 `<状态目录>/skills/`，说明用 `--append-system-prompt-file`，MCP 用 `--mcp-config` 加 `--strict-mcp-config`（不加的话 claude.ai 的连接器会进来）。`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 关掉自动记忆，`DISABLE_AUTOUPDATER=1` 关掉自更新，清掉 `ANTHROPIC_API_KEY` 等变量。日常设置里的代理变量（`HTTP_PROXY` 等六个）不会被读到，启动器从 `~/.claude/settings.json` 只取这六个带过去。第一次启动会弹的引导、信任目录、跳过权限的确认，启动器预先写进状态目录的 `.claude.json` 和 `settings.json`。
- 两边都是 `--dangerously-skip-permissions` 或 `approval_policy = "never"` 加 `danger-full-access`。

## 登录

- **Codex**：`auth.json` 链到 `~/.codex/auth.json`，和日常共用一份。令牌刷新把链接换成普通文件时，下次启动把较新的那份放回 `~/.codex`（旧文件备份成 `auth.json.bak-<时间>`），再重新链上。
- **Claude Code**：配置目录换了，登录还是日常那一份。Claude Code 把登录存在 macOS 钥匙串，条目名是 `Claude Code-credentials` 加配置目录的哈希；把 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 设成空，它就读不带哈希的日常条目，刷新登录用的锁也落在日常那边，等于多开一个日常会话。这个变量没写进文档，2026-10-25 在 Claude Code 2.1.310 上实测可用。启动前跑一次 `claude auth status`，读不到登录就停下。失效时的备选是官方的 `claude setup-token`：Kun 在浏览器批准一次，得到一年期、只能调模型的令牌，用 `CLAUDE_CODE_OAUTH_TOKEN` 传入。不要复制钥匙串条目：刷新令牌只能用一次，两份会互相顶掉。在专用 Agent 里登出会连日常一起登出，所以 `logout` 被拒绝。
- **安装 ID**：请求里带着标识这份安装的 ID，Codex 是 `installation_id`（请求头 `x-codex-installation-id`），Claude Code 是 `.claude.json` 的 `userID`（请求和遥测里的 device_id，也决定功能灰度分到哪一组）和 `machineID`（错误报告里取前 12 位）。两边都只在缺失时随机生成，所以启动器每次启动前把日常的值拷进状态目录，专用 Agent 在服务端看来和日常是同一份安装。

## 服务

- 端口 18766，代码取自启动器所在仓库检出的 `dist/`，真实库路径取自同一个检出的 `.env.local`；检出默认是脚本所在的仓库（跟着符号链接找到真实位置），`WAYFINDER_AGENT_CHECKOUT` 可覆盖。服务独占数据库，同一时间只跑一个；端口被别的服务（多半是单独跑的 `npm run serv`）占着，就停下提示。
- 服务的状态在 `~/.wayfinder-service/`（0700）：主令牌 `wayfinder-token`、`service.pid`、`service.log`、Node 路径 `node-path`、写入来源的令牌 `credentials.json` 和 `credential-owners.json`。2026-10-25 前在 `~/.codex-wayfinder/`；第一次运行时沿用那里的主令牌，`stop` 也认那里的 pid 文件，所以旧启动器拉起的服务照样能查、能停。
- 退出 agent 后服务继续跑，查看页仍可用；`stop` 才停，连同 ChatGPT 测试一起停。服务一直用它启动时那份代码，检出更新后用 `restart` 换上。停或重启前先退出开着的 MCP 版会话，否则它们的连接会断。
- `status` 显示的数据库是服务进程实际开着的那个 SQLite 文件（用 `lsof` 看）；和 `.env.local` 现在配的不一样时一并提示。服务没在跑时显示下次启动会用的那个。

## 写入来源

每个版本记下是哪个 harness、模型和推理强度写的，例如 `Codex:gpt-6-astra:xhigh`、`Claude-Code:opus:high`，ChatGPT 测试记成 `ChatGPT`。

- 服务读一份由启动器写的凭据文件（产品仓库 `docs/implementation/local-mcp-service.md`「Further credentials」）：每份令牌对应一个 Client ID。每次启动 MCP 版，启动器生成一份新令牌，以「harness:模型:推理强度」登记，经环境变量 `WAYFINDER_TOKEN` 交给这次的 harness。来源由运营方登记，客户端不能自报，符合产品规格「不接受客户端伪造作者」。
- 登记时记下启动它的进程；进程退出后，下次登记或拉起服务时就吊销它的令牌。
- 主令牌只给启动器自己探活用，记成 `Wayfinder-Launcher`；谁借了主令牌写图，看得出来。
- 服务还是旧代码、不认凭据文件时，这次启动退回主令牌并提示，写入记成 `Wayfinder-Launcher`；`restart` 换到新代码后就分开。

## 调用关联

启动器在服务目录的 `launches.jsonl` 里追加私有的 `wayfinder-launch/1` 记录，覆盖普通、测试、续接、Matt 原版和 ChatGPT 中继入口。Client ID 仍是原来的 `harness:model:effort` 或 `ChatGPT`；启动器和服务用同一份凭据派生的指纹关联，不创建第二套身份。同一组合的两次启动使用不同凭据，MCP 连接也各有会话 ID。指纹经过用途隔离，不等于凭据文件中的认证校验值。启动器不向 harness 注入服务作者配置变量 `WAYFINDER_CLIENT_ID`。

记录只含入口、harness、方法、模型、推理强度、UTC 启动时间（以 `Z` 结尾）和进程 ID，不含提示词、参数、工作目录、令牌或私有路径。续接时写入已知的 `nativeSessionId`；新会话尚未产生原生 ID，会在 `missing` 中明确列出。后续分析必须从客户端记录补齐或保留缺口，不能靠元数据推断人的授权。吊销凭据不会删除启动记录。

`WAYFINDER_AGENT_USAGE=normal|test|research` 是操作者声明的用途；未声明或无效值记为 `unknown`，dry run 明确记为 `test`。路径覆盖项本身不能证明用途，隔离测试应显式设置 `test`。写记录失败会输出固定的缺失提示，启动继续。服务不依赖这个标签或启动器，始终独立记录 MCP 调用；格式见[操作者说明](../../docs/implementation/local-mcp-service.md#default-call-metadata)。

启动记录和服务记录都不自动轮转，会持续增长。操作者可在停止自己管理的服务后手动归档日志；不要把日志当作 Map 备份。经 ChatGPT 隧道到达中继的公网请求会被中继加上令牌，因此服务将它们记为该凭据的已认证调用；这个标签不证明请求来自本人。

## ChatGPT 测试

`wayfinder chatgpt` 在前台运行产品仓库的 `scripts/local-chatgpt-test.mjs`，带 `WAYFINDER_ATTACH_TOKEN`：它不另起服务，转发到已在跑的这个服务上，照常每 30 分钟备份，Ctrl-C 关掉转发和 Cloudflare 隧道，服务继续跑。ChatGPT 和专用 Agent 能同时用同一批地图。公开地址没有用户认证，不测就关。需要产品仓库的 client-credentials 改动；没有时命令会停下说明。单独跑 `npm run serv` 仍可用，但它自己起服务，要先 `wayfinder stop`。

## 产出

所有专用 Agent 写的文件默认集中在 `~/workspace/outputs/wayfinder/`（本机保存，不进 Git；`WAYFINDER_AGENT_OUTPUTS` 可改），后续流程从这里读：

- `mcp/<地图 ID>/`：MCP 版的笔记、原型、调研。地图本身在服务里。
- `matt/<effort>/`：Matt 原版的地图（`map.md` 等，按 Matt 的本地约定）和它的笔记。

两个 harness 写同一个目录，所以换 harness 也能接着同一张 Matt 原版地图。在 HOME、`/` 或状态目录里启动时，工作目录退回 `outputs/wayfinder/<方法版本>/`。

## 地图和会话

- `maps` 读服务查看页的只读接口（不用令牌），每张地图带当前版本、时间和写入来源；Matt 原版扫 `outputs/wayfinder/matt/*/map.md`。
- `sessions` 扫四个状态目录里的会话记录（Codex 的 `sessions/`、Claude Code 的 `projects/`），只留有人说过话的（Matt 原版的子 agent 线程没有），按开始时间倒序。给了地图 ID 就只留提到它的。
- `resume` 在原会话的目录里接着它：Codex 是 `codex resume <ID>`，Claude Code 是 `claude --resume <ID>`。Claude Code 的会话不记推理强度，没给 `--effort` 时用默认。直接用日常的 `codex resume`、`claude --resume` 找不到这些会话。

## 测试

改启动器后，在隔离环境里跑（脚本改动算已发布代码，要按产品规格 §14.3 升版本），别碰真实服务、状态和产出：

```
export WAYFINDER_AGENT_CHECKOUT=<装了新代码的产品检出>  WAYFINDER_AGENT_DATABASE=<一次性库>
export WAYFINDER_AGENT_STATE_ROOT=<临时目录>/state  WAYFINDER_AGENT_SERVICE_DIR=<临时目录>/svc
export WAYFINDER_AGENT_OUTPUTS=<临时目录>/outputs  WAYFINDER_AGENT_PORT=18866
WAYFINDER_AGENT_DRY_RUN=1 wayfinder …      # 只打印要执行的命令和目录
```

一次性库用产品检出的 `initializeSQLite(path)` 建，放在 `~/Library/Application Support/Wayfinder/` 下的新目录。非交互的冒烟测试：`wayfinder --effort low -- exec --skip-git-repo-check "…" < /dev/null`（Codex，`< /dev/null` 免得它等 stdin）、`wayfinder --harness claude --model haiku --effort low -- -p "…"`，再用 `maps` 看写入来源。

`~/.local/bin/wayfinder` 和 `wayfinder-matt` 链到本仓库的 `scripts/wayfinder-agent/wayfinder`（2026-10-25 起；此前在工作区的 `runtime/tools/wayfinder_agent/`）。脚本只用 Python 标准库，兼容系统自带的 Python 3.9。
