# 共享会话

0.3.1：修复 0.3.0 中插件已启用但 Hooks 列表为空的问题。在 Codex 中编辑发送交接内容，Mac/Windows 聊天内提醒，打开接收端对应聊天继续工作，也可开启自动处理。保留原聊天历史导出、网页草稿预览、文件收发、成员管理及 Windows 桌面提醒。支持局域网独立部署和公网 HTTPS 部署。不共享 OpenAI 账号。

## 局域网独立部署

一台电脑运行服务，同一局域网的成员安装插件并连接这台电脑的 IP，账号、共享记录和文件都保存在这台电脑，不需要公网服务器或域名。不同部署实例的数据各自独立，不会自动同步；团队成员应连接同一个实例。

服务端需要 Node.js 24。首次初始化账号，然后启动服务；将示例 IP 换为服务端电脑的实际局域网 IPv4 地址：

```sh
node scripts/init-local.mjs
node src/cli.mjs serve --host 0.0.0.0 --port 8787 --lan-url http://192.168.1.10:8787
```

初始化只在空数据库创建账号，随机密码保存在 `.local/local-accounts.json`，已有账号不会重置。数据保存在 `data/shared.sqlite`，需保持服务进程运行。`127.0.0.1:8787` 仍可在服务端本机使用，`--lan-url` 只允许明确配置的局域网入口；多个地址可重复传入该参数。

在服务端防火墙放行所属局域网到 `8787/TCP` 的访问，范围限制为实际网段。成员按下节从 GitHub 安装插件后，在新聊天说：“连接共享空间，服务器地址是 http://192.168.1.10:8787”，然后在返回的网页输入管理员提供的账号密码并授权。成员电脑也需要 Node.js 24，无需启动服务端。

局域网 HTTP 模式接受明确填写的私有 IPv4 地址（`10.*`、`172.16.*` 至 `172.31.*`、`192.168.*`），用于可信内网；公网及域名地址使用 HTTPS。局域网浏览器可能不支持 HTTP 页面的系统通知，插件 Windows 桌面提醒与网页收件箱仍可使用。服务端 IP 改变后需更新启动参数、防火墙范围和成员连接地址。

## 从 GitHub 安装插件

仓库为 `GladGoing/remote-shared-session`。另一台电脑需要 Node.js 24，可以从 GitHub 安装客户端插件，再连接由团队自行提供的服务地址。

在另一台电脑的终端执行：

```sh
codex plugin marketplace add GladGoing/remote-shared-session
```

然后重启 Codex，进入插件目录，在“共享会话 · 本地开发”来源中安装“共享会话”，并新建聊天。插件运行文件已随仓库提供，无需在接收电脑构建插件或启动共享服务。若尚未安装 Codex CLI，也可下载仓库或通过 Git 克隆，在 Codex 中将仓库目录添加为项目，再按上述方式安装。

安装后，在新聊天说“连接共享空间，服务器域名是你的域名”。插件会补全 HTTPS、保存服务地址并返回网页登录授权链接，无需手动改配置或再次重启。用户在网页输入共享服务账号和密码并允许连接，再回 Codex 确认状态。账号密码不作为工具参数，也不保存在地址配置里。

对外使用标准 HTTPS `443` 端口时，只提供域名即可；使用其他端口时需明确写出端口。本机可指定 `http://127.0.0.1:8787`，局域网使用上一节的完整 IP 地址。也可在用户主目录 `.remote-shared-session/settings.json` 中手动配置，格式见下一节。显式设置的 `SHARED_SESSION_SERVER` 环境变量在插件重启时仍优先于该文件；需更改这类固定配置时，一并修改环境变量。

更新已注册的仓库来源可执行 `codex plugin marketplace upgrade shared-session-local`，再重启 Codex。实际连接仍取决于共享服务的网络入口是否可用。

## 网页与插件（推荐）

需要 Node.js 24。无需安装 npm 依赖。首次在项目目录执行：

```sh
node scripts/init-local.mjs
node scripts/build-plugin.mjs
node src/cli.mjs serve
```

打开 <http://127.0.0.1:8787>。初始化命令仅在数据库没有账号时创建管理员 `owner` 和普通成员 `member`，随机密码保存于 `.local/local-accounts.json`，不会打印密码或重置已有账号。也可用下文 `user-add` 自行设置初始账号。首个账号默认是管理员，后续账号默认是成员；管理员可在网页创建成员、调整角色、停用和重置密码。

插件源码在 `plugins/shared-session/`，构建命令生成其 `runtime/`。仓库已提供 `.agents/plugins/marketplace.json`。在 Codex 的“共享会话”项目中重启应用，打开插件目录，选择“共享会话 · 本地开发”并安装“共享会话”。也可在仓库根目录运行 `codex plugin marketplace add .` 注册本地来源，然后在桌面插件目录安装。安装后用新聊天加载插件；已打开聊天是否刷新工具取决于宿主版本。

成员安装同一份插件和 Node.js 24。插件默认连接本机 `http://127.0.0.1:8787`，在用户主目录下 `.remote-shared-session/` 保存授权资料，附件默认写入 `Downloads/SharedSessions`。需要连接其他服务时，在 `.remote-shared-session/settings.json` 设置：

```json
{
  "server": "https://YOUR_DOMAIN",
  "notifications": true,
  "chatNotifications": true,
  "receiveMode": "create"
}
```

可选 `profile`、`downloadDirectory` 和 `workspace` 必须是本机绝对路径；不要把口令或令牌写入插件清单。`SHARED_SESSION_SERVER`、`SHARED_SESSION_PROFILE`、`SHARED_SESSION_DOWNLOAD_DIR`、`SHARED_NOTIFICATIONS`、`SHARED_CHAT_NOTIFICATIONS` 环境变量优先于该设置文件；提醒默认值可再由工具保存的个人开关覆盖。公网地址需要有效 HTTPS，局域网可明确指定私有 IP 的 HTTP 地址。

### 在 Codex 中直接交接（推荐）

两台电脑安装插件，使用各自的共享成员账号连接同一个服务。更新插件后，在 Codex 的“设置 > Hooks”或输入框的“Review hooks”中信任本插件的 Hooks，再新建或恢复聊天。

插件使用 `.codex-plugin/plugin.json` 和 `.mcp.json` 的 Codex 兼容打包格式。当前宿主会跳过通用 Agent Plugins 格式的插件 Hooks，因此不要在包根目录加入 `plugin.json`；即使兼容清单也存在，根清单仍会优先匹配，导致工具可用而 Hooks 无法发现。验收时需确认宿主 `hooks/list` 能列出本插件的 `SessionStart` 和 `UserPromptSubmit` 两项，不能只核对版本号。

发送端可以说：“把登录接口的修改要求整理成交接，发给 bob。”在聊天内继续修改内容，确认发送后 Codex 使用 `shared_session_send` 直接发布，不用再去网页确认，也不导出整段聊天。仅发送明确选择的内容和附件。后续补充同一交接时保留 `shareId`，使用新的 `requestId`；失败重试使用原编号和原内容。

接收端在发送消息或恢复聊天时看到聊天内提醒和“打开共享聊天”链接。默认 `receiveMode=create` 会通过本机正在运行的 Codex App Server 创建接收聊天、导入内容，并启动一次模型阅读以呈现摘要；后续更新补入同一聊天。点击链接打开这个本机聊天即可继续工作，不会接管发送端原聊天。导入不会把收件箱记录标成已读，附件仍按需下载。

接收端可说：“开启共享交接的自动处理，工作目录是 /Users/你的用户名/project。”这会设置 `receiveMode=work` 和本机 `workspace`，检查到新内容时自动新建或复用聊天并开始处理。路径由接收端选择；继续使用本机的权限和批准规则。已有聊天忙碌时保留更新，后续检查空闲后再处理，不打断正在进行的工作。

只需要提醒时设置 `receiveMode=notify`，这不会创建聊天或调用模型。`shared_notifications` 的 `chatEnabled` 控制聊天内提醒，`enabled` 单独控制 Windows 桌面提醒。未启用自动处理时，首次阅读只要求呈现交接摘要，不执行交接任务。`create` 和 `work` 都使用接收端自己的模型与账号。

本地 Hooks 不会在空闲时触发原生铃铛通知，检查时机为发送消息和恢复聊天。本机 App Server 或原生接口不可用时，提示会给出预填读取请求的新聊天链接，需要手动发送该请求；不会把这种回退当成已经启动工作。创建或启动的响应不确定时不自动重复创建、执行，应先检查已有目标聊天。参见 [Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[聊天深链接](https://learn.chatgpt.com/docs/reference/commands#chats) 和 [App Server](https://learn.chatgpt.com/docs/app-server)。

导出原聊天历史时按以下流程操作：

1. 首次说“连接共享空间，服务器域名是你的域名”，后续可直接说“连接共享空间”。打开返回的链接，在网页输入共享账号密码，核对连接编号并允许连接；回 Codex 确认连接状态。密码无需发到聊天。
2. 说“分享当前会话给 member，附上我选择的文件”。插件只读取准确 thread ID 下已完成轮次的用户/助手文本和明确选择的文件，准备仅自己可见的草稿。
3. 在返回的网页预览中核对内容和接收成员，点击“确认发布”。上传完成前不能发布，确认绑定内容版本和成员版本。
4. 接收成员说“查看共享收件箱”，读取指定会话、下载所选文件。内容呈现后标记对应记录已读；`nextCursor` 用于继续读取更新。
5. 发送方说“同步这个共享会话”，向原接收成员发送新完成的文本和所选文件版本。插件不默认持续上传本机后续聊天。

插件有 12 个工具：连接/状态、直接发送/打开本机聊天、准备/同步、会话列表/读取/文件下载、收件箱/已读、提醒设置。需要持续共享原聊天历史时也可使用下文 CLI `sync` 进程。

## 主动提醒的范围

发布、后续同步和新增接收成员会生成持久化收件记录。插件通过本服务的 SSE 长连接接收记录，Windows 插件进程运行期间自动发送系统通知；可说“关闭共享提醒”或“查看共享提醒状态”。通知不显示会话正文、口令或文件内容，点击打开网页登录收件箱。系统可能因通知权限或免打扰而不显示横幅。

断线后按账号和服务保存的游标补收，失败不会推进游标；重连可能重试同一条通知，已读记录仍保留在收件箱。插件退出、电脑关机或账号到期时不发送实时桌面通知，重新连接后补收。没有安装开机任务或后台系统服务。系统桌面通知仍仅支持 Windows；Mac 使用上文的 Codex 聊天内提醒。未支持的平台不会反复重试 Windows 通知。

网页收件箱自动更新，也可点击“开启网页桌面提醒”授权浏览器通知，需保留页面。插件提醒和网页提醒独立开启，同时使用可能各收到一条。

Windows 桌面提醒本身不启动模型轮次；聊天内提醒按接收模式启动阅读或工作。ChatGPT Work 的原生 MCP Events 是另外的 HTTP/webhook 接入，需要公网 HTTPS 和持久订阅，本版尚未实现。参考 [OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins) 与 [MCP Events 支持范围](https://developers.openai.com/plugins/build/mcp-events)。

## 高级 CLI 与兼容接口

需要 Node.js 24，使用内置 SQLite，无需安装 npm 依赖。Linux 和 Windows 使用同一份代码。先在本机验证：

```sh
node --test
node src/cli.mjs user-add --username alice
node src/cli.mjs user-add --username bob
node src/cli.mjs serve
```

用户创建命令隐藏输入密码，至少 12 个字符。不提供公开自助注册；后续成员可由管理员在网页创建。默认数据库为当前目录下的 `data/shared.sqlite`。服务默认只监听 `127.0.0.1:8787`。

## 登录与发布

在发送端进入项目目录，运行：

```sh
node src/cli.mjs login --server http://127.0.0.1:8787 --username alice --profile .local/alice.json
```

密码不进入命令参数和日志。配置文件只保存 12 小时有效的随机令牌，不保存密码。令牌文件属于凭据，必须保存在仅当前系统用户可读的目录；Linux 文件以 `0600` 创建，Windows 部署前另行核实目录 ACL。

通过当前客户端提供的线程信息取得准确的 thread ID，不要用聊天标题猜测。可在 Codex 会话中要求它使用以下命令导出指定聊天。先导出到一个**不存在的绝对路径**，检查要分享的文本：

```sh
node src/cli.mjs export --thread THREAD_ID --out ABSOLUTE_PREVIEW_PATH
node src/cli.mjs publish --profile .local/alice.json --out ABSOLUTE_PREVIEW_PATH --request-id SHARE_REQUEST_ID --to bob --file ABSOLUTE_FILE_PATH
```

`--file` 可重复，只上传明确选定的文件实体，不扫描项目目录、不自动跟随聊天里的文件链接。单文件最多 8 MiB，消息最多 64,000 字符；超限报错，不静默截断。导出仅包含已完成轮次的用户/助手文本，不包含推理、命令输出或附件正文，遗漏数量会返回。文本不会自动脱敏，应检查预览，尤其是会话中输入过的密码和密钥。

发布返回 `shareId`。首次创建时保存并复用同一个 `SHARE_REQUEST_ID`，重试不会创建重复共享；同编号不同参数会拒绝。更新已有共享时用 `--share SHARE_ID`，不能更换源 thread ID。

继续同步已完成轮次和选定文件的新版本：

```sh
node src/cli.mjs sync --profile .local/alice.json --thread THREAD_ID --share SHARE_ID --interval 10 --file ABSOLUTE_FILE_PATH
```

同步进程需要保持运行，按 Ctrl+C 停止。它只读取官方 App Server，不恢复或执行原会话。源文本被修改时相同消息编号会报告冲突，不覆盖旧共享内容。每一批原子提交，跨批不作为一个事务；失败前已确认的批次仍保留，重跑可继续。旧文件版本按独立文件编号保留。

所有者可以用 `grant --profile .local/alice.json --share SHARE_ID --username bob` 增加成员，或用 `revoke` 替换 `grant` 撤销。两者均通过 `node src/cli.mjs` 执行。

## 成员在 Codex 中接收

接收端安装同一份项目，先用自己的共享账号执行 `login`。然后将下面配置加入接收端 Codex 的 MCP 设置，替换为该成员电脑上的**绝对路径**：

```toml
[mcp_servers.shared_session]
command = "node"
args = ["/absolute/path/remote-shared-session/src/mcp.mjs"]

[mcp_servers.shared_session.env]
SHARED_SESSION_PROFILE = "/absolute/path/client.json"
SHARED_SESSION_DOWNLOAD_DIR = "/absolute/path/received"
```

Windows 路径可用 `C:/projects/remote-shared-session/src/mcp.mjs` 这样的示例正斜杠写法，替换为本机实际路径。配置后按当前客户端要求刷新工具或重启。

对 Codex 说：“列出我能读取的共享会话，读取其中的接口设计；把我选定的文件下载到接收目录。”接收桥提供：

| 工具 | 用途 |
| --- | --- |
| `shared_sessions` | 列出当前账号有权访问的共享 |
| `shared_session_read` | 按序读取文本和文件清单；保存 `nextCursor`，下次传 `after` 拉取更新 |
| `shared_file_download` | 下载指定文件，验证 SHA-256，复用校验一致的文件，拒绝覆盖不同内容 |
| `shared_connect` / `shared_connection_status` | 网页授权连接与连接状态 |
| `shared_session_prepare` / `shared_session_sync` | 准备私有草稿与同步已发布会话 |
| `shared_session_send` | 直接发送聊天内编辑确认的内容；带原 shareId 可补充同一交接 |
| `shared_session_open` | 导入/复用接收端本机 Codex 聊天，返回打开链接；明确授权后可启动工作 |
| `shared_inbox` / `shared_inbox_read` | 收件箱与标记已读 |
| `shared_notifications` | 分别设置桌面与聊天内提醒、接收模式及本机工作目录 |

`hasMore` 为 true 时继续翻页。下载只写入配置的接收目录，不执行文件内容。每次读取和下载都会重新校验账号和共享权限；撤权只阻止后续读取，不能收回已下载的副本。读取的资料进入当前会话上下文，不创建源会话的原生副本。

旧 CLI 的 `publish` 保留直接发布语义，执行前务必核对导出预览和接收成员。插件使用私有草稿和网页确认流程。插件授权使用本服务的设备连接流程，不是 OpenAI 账号 OAuth。

## HTTP 接口

除 SSE 流外，所有 `/api/` 接口使用 JSON。CLI/MCP 使用 `Authorization: Bearer <token>`。网页使用独立的 HttpOnly、SameSite=Strict Cookie 和 CSRF 头，公网 HTTPS 下设置 Secure；网页和 API 令牌不可混用。不要将令牌放在 URL。

| 方法与路径 | 功能 |
| --- | --- |
| `POST /api/login` | `{username,password}` 登录 |
| `POST /api/logout` | 撤销当前令牌 |
| `GET /api/shares` | 列出有权访问的共享 |
| `POST /api/shares` | `{requestId,title,sourceThreadId,recipients}` 创建共享 |
| `GET /api/shares/:id/events?after=0&limit=50` | 分页读取事件 |
| `POST /api/shares/:id/events` | 所有者以 `{entries:[...]}` 追加文本或文件 |
| `POST /api/shares/:id/members` | 所有者以 `{username}` 授权成员 |
| `DELETE /api/shares/:id/members/:username` | 所有者撤销成员 |
| `GET /api/shares/:id/files/:fileId` | 读取文件实体与校验值 |
| `POST /api/web/login` / `POST /api/web/logout` | 网页登录/退出 |
| `GET /api/web/session` | 当前网页用户、CSRF 与初始化状态 |
| `GET /api/users` / `POST /api/users` | 管理员列表/创建成员 |
| `PATCH /api/users/:username` | 管理员调整角色/启用状态 |
| `POST /api/users/:username/password` | 管理员重置其他成员密码 |
| `POST /api/device` / `POST /api/device/poll` | 发起/完成插件设备授权 |
| `GET /api/device/:code` / `POST /api/device/:code` | 网页核对/允许或拒绝连接 |
| `POST /api/drafts` | 创建仅所有者可见的草稿 |
| `POST /api/shares/:id/seal` / `POST /api/shares/:id/publish` | 完成上传/按内容和成员版本发布 |
| `GET /api/shares/:id/members` | 所有者读取接收清单 |
| `GET /api/inbox` / `POST /api/inbox/read` | 读取收件箱/标记已读 |
| `GET /api/inbox/stream` | SSE 提醒，支持 `after` 或 `Last-Event-ID` 续传 |

成员只读，不能追加内容或修改共享权限。未知和未授权共享统一返回 404。追加事件的稳定 `eventId` 相同且内容相同时返回已有回执，内容变化则整批回滚并返回 409。

停用或重置密码会撤销原有 API/网页登录及待完成的授权，现有提醒连接也会失效；启用不恢复旧令牌。至少保留一个启用管理员。撤销共享权限会删除该成员对应的收件记录，不影响已下载副本。

0.1 数据库首次打开会事务升级到 schema 2，保留原账号、令牌、共享和幂等编号，首次将最早账号设为管理员。上线前备份数据，后续不要用旧版本写入已升级数据库。现有发布内容为接收成员补建收件记录。

## 服务器运行

提供 `Dockerfile` 和基础 `compose.yaml`，基础配置仅映射服务器回环地址。`deploy/` 提供由现有 Nginx 网关转发的公网 HTTPS 示例：后端不发布宿主端口，网关在标准 `443` 上按自己的域名转发，无需在访问地址中填写端口。客户端拒绝公网明文 HTTP，不关闭 TLS 校验。部署、备份与证书续期方法见 [部署说明](deploy/README.md)。仓库只包含通用示例，实际域名、服务器路径和连接资料保存在部署环境中。

```sh
docker compose build
docker compose run --rm shared-session node src/cli.mjs user-add --username alice --db /app/data/shared.sqlite
docker compose up -d
```

部署应保留已有站点、数据卷和 SSH 配置，网关改动先备份并验证，防火墙只开放所需入口。SQLite 数据、登录令牌、导出预览和下载文件不能提交 Git。

官方接口依据：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)。本地协议可能随客户端升级变化；接口不兼容时停止，不读取私有数据库或日志作为回退。
