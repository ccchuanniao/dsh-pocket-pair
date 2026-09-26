# dsh-pocket-pair

让一台手机（DSH Pocket）配对到这台 DeepSeek Harness 主机的插件。

网页端「设置 → 手机配对」里生成一个一次性配对码，手机扫码或手输地址 + 码完成配对。
插件同时充当**闸门**：已配对的设备靠自己的设备令牌进来，可以按设备单独吊销。

## 让自己的 Agent 帮你配置

在「设置 → 手机配对」复制提示词，交给能操作这台电脑的 Agent。
它会按 [AGENTS.md](AGENTS.md) 检查并填写配置；缺 Firebase、域名或远程入口时，
给你申请步骤和可选方案。你只需要处理自己的账号登录、使用范围选择和手机操作。

从 [使用说明](使用说明.md) 开始：局域网可以先用；出门也要连接可以选择私有网络或 HTTPS 入口；
通知单独配置和验证。没有公网 IP 并不等于必须购买服务器。

## 它不做什么

写给关心隐私的人，这一节比上面重要：

- **不发送任何遥测、统计、崩溃上报。** 除了下面列的两种情况，所有出站请求都指向
  `127.0.0.1`，也就是同一台机器上的 harness 自己。
- **不访问任何作者控制的服务器。** 没有账号、没有云端、没有回连。
- **不读取与它无关的文件。** 只读它自己目录下的安装包和状态文件。
- **不会把你的部署信息公开。** 域名、端口、路径全部来自安装者的配置，
  仓库里没有任何作者相关的默认值。

### 它确实会往外连的两种情况

都只在你显式配置之后才发生，而且都可以关掉：

1. **推送通知** —— 经 Google FCM（`fcm.googleapis.com`）把通知送到手机。
   不配 `fcmServiceAccountFile` 就完全不连。
2. **AI 生成推送正文** —— 由 harness 自己调你为它配置的模型服务。这是 harness
   本来就在用的那条通道，插件没有自己新增任何模型供应商。关掉 `pushAiSummary`
   就不再发生。

两者都不经过作者的任何基础设施。

## 兼容性

| | 要求 |
| --- | --- |
| DeepSeek Harness | `0.1.x`（`peerDependencies` 声明 `^0.1.1-rc.2`）。**实测过的只有 `0.1.5-rc.2`** |
| Node | 与 harness 自身的要求一致 |
| 手机端 | DSH Pocket 这个 App，Android 8.0（API 26）及以上 |

**关于"0.1.x 都行"这句话的分量：** 插件依赖的是 harness 内部接口
（`ctx.llm.stream`、`agent/status`、`session/event`、`connection.fetch.register`），
不是承诺稳定的公开 API。所以上面那个范围是"声明"，不是"保证" —— harness 升一个小版本
就可能改变这些接口的形状，而插件不会在安装时报错，只会在运行时表现异常。

harness 升级后如果插件行为不对，先看 `GET /api/pocket-pair/state` 能不能正常返回，
再看 `pushTrace` 里的 `sessionEvents` 计数是不是 0（是 0 就说明事件名或载荷形状变了）。

## 安装

**这个包还没发到 npm**，所以别用 `add dsh-pocket-pair` —— 那样装不上。从仓库装：

```bash
dsh plugin --profile web add github.com/ccchuanniao/dsh-pocket-pair
```

也可以给完整地址（`https://github.com/ccchuanniao/dsh-pocket-pair`）或者本地目录。
`web` 换成你自己的 profile 名。

**懒人做法**：把下面这句连同仓库地址一起丢给你的 AI：

> 帮我装一下这个插件，装完读它目录里的 `AGENTS.md`，然后按上面说的把我的手机配上：
> https://github.com/ccchuanniao/dsh-pocket-pair

`AGENTS.md` 就是为这个写的 —— 里面写清了怎么查你机器的情况、怎么把配置填进去、
缺 Firebase 或没有公网 IP 时该怎么给你选择。

装完重启一次 harness（bundle 层是启动时读的）。

## 配置

全部可选，但大多数部署至少要填 `pairBase`：

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `pairBase` | 空 | 二维码里告诉手机该连的地址，含协议。**留空就无法生成配对码** |
| `lanPort` | `8081` | 闸门自己监听的端口。和 harness 的端口不能相同 |
| `lanEnabled` | `true` | 关掉就只保留公网/直连那条路 |
| `lanAdvertise` | 空 | 二维码里报的局域网地址；留空自动挑一个非 loopback 地址 |
| `apkUrl` | 空 | 安装包地址。留空表示由本插件自己发（派生为 `<pairBase>/apk/<apkName>`） |
| `apkName` | `dsh-pocket.apk` | 默认安装包文件名 |
| `apkDir` | `<DSH_HOME>/dsh-pocket-pair/apk` | 安装包所在目录 |
| `codeTtlSeconds` | `3600` | 配对码有效期 |
| `redeemPerMinute` | `10` | 公开兑现路由每分钟允许的尝试次数，按来源地址计 |
| `buildEnabled` | **`false`** | 是否允许从网页端触发 Gradle 构建。见下方「安全面」 |
| `buildProjectDir` | 空 | 安卓工程目录。留空则构建功能不启用 |
| `buildOutputApk` | `app/build/outputs/apk/release/app-release.apk` | 构建产物相对工程目录的路径 |
| `pushEnabled` | `true` | 推送总开关。关掉只影响发送，不影响手机登记令牌 |
| `pushTitle` | `DSH 任务完成` | 通知标题 |
| `pushAiSummary` | **`false`** | 推送正文是否交给模型生成。见下方「推送通知」 |
| `pushAiTimeoutMs` | `15000` | 生成摘要的超时。超时即退回原文，不影响送达 |
| `fcmServiceAccountFile` | 空 | Firebase 服务账号 JSON 的路径。**这是真正的密钥**，只在服务端。留空则不发送推送 |
| `fcmProxy` | 空 | 访问 Google 用的 HTTP 代理，形如 `http://host:port`。网络能直连就不用填 |
| `firebaseProjectId` / `firebaseAppId` / `firebaseApiKey` / `firebaseSenderId` | 空 | Firebase 客户端配置。都是公开值，会被编译进 App |

## 推送通知

一轮任务跑完，插件往每台已登记令牌的设备推一条通知。正文有两种来源：

- `pushAiSummary` **关**（默认）：取这一轮最后一条回复的开头 140 字。不用模型、瞬时、不会失败。
- `pushAiSummary` **开**：把这一轮的助手输出交给**当前对话使用的那个模型**压成一句话。
  用的是 harness 自己的 `ctx.llm`，provider/model 取 `agentDefaultModel.currentSelection()`，
  所以不需要额外配置，你换模型它跟着换。输出语言按正文判定（中文／日文／其他）。

开着的时候，**摘要失败一律退回原文**：没配模型、超时、限流、返回空、内容为空，
任何一条都不该让手机收不到通知。页面上有「试一句」按钮，可以当场看一段示例文本会被
压成什么，不必等下一轮任务跑完。

一次推送只调用一次模型（多台设备共用同一句），失败时不会重试。

App 那边的通知用的是 BigTextStyle，正文长了会展开显示。

## 它写什么到磁盘

全部在 `<DSH_HOME>/dsh-pocket-pair/` 下，权限 `0600`：

| 文件 | 内容 |
| --- | --- |
| `settings.json` | 安装者在页面上填的域名、安装包地址、以及界面开关 |
| `pairing.json` | 未使用的配对码、已配对设备的令牌与最近活动时间 |
| `push.log` | 最近几次推送的记录：时间、会话、正文来源、正文。上限 64 KB，超出后只留最近 100 行 |
| `apk/` | 由插件分发的安装包 |

## 它的网络面

插件会额外开一个监听端口（`lanPort`），这是它和 harness 本体最大的区别。

| 路径 | 鉴权 | 用途 |
| --- | --- | --- |
| `POST /dsh-pocket-pair/redeem` | **无** | 手机用配对码换设备令牌。按来源限流，码一次性、限时 |
| `GET /apk/<名字>.apk` | **无** | 分发安装包。只发 `apkDir` 下的 `.apk`，文件名不允许含路径分隔符 |
| 其余所有路径 | 设备令牌 cookie | 转发到本机 harness |

无鉴权的那两条是绕不开的：**会用到它们的正是还没有任何凭证的手机**。

## 安全面

- `buildEnabled` **默认关闭**。打开它等于让一个 HTTP 请求去跑 `buildProjectDir` 里的
  Gradle 构建脚本 —— 也就是在那个目录里执行代码。只有自己搭这套东西、并且信任
  harness 的登录用户时才该打开。触发接口挂在受鉴权的 `/api` 通道上，不公开。
- 闸门绑 `::`（IPv4 + IPv6 双栈）。如果这台机器在不可信网络里，请确保
  `lanPort` 前面有防火墙，或者把 `lanEnabled` 关掉、只走你自己配的那条入口。
- 配对码是 8 位、字符集 32（约 40 bit），一次性 + 1 小时有效 + 限流。
- **`/dsh-pocket-pair/redeem` 只认配对码。** 配对窗口开着不等于放行 —— 窗口开着不是秘密，
  入口在公网上时那样等于谁先请求谁拿到设备令牌。构建时烘进包里的那把码同样是一次性随机码，
  所以"装完打开就连上"依然成立，只是那把码和别的码一样一小时过期，过期后改用二维码配对。
- 设备令牌是 32 字节随机，只存在设备 cookie 和自己的 `pairing.json` 里。
- **吊销会同时断开该设备已建立的长连接。** 设备校验只在 WebSocket 握手时做一次，之后闸门只是
  双向转发；只删设备记录而不主动断连，还开着的控制台页面会一直连着，直到客户端自己重连。
  吊销的响应里因此多一个 `connectionsClosed`，告诉你断掉了几条。
- 构建日志里的 `-PpairKey` 会脱敏成 `***`。完整命令行本来要记进日志、显示在页面上，
  而日志很容易被截图或粘贴出去 —— 钥匙虽然一次性，但"一次性"只有没被用掉时才有意义。

## 已知边界

- 闸门不做 TLS。需要 HTTPS 就在前面放一个反代（本部署用的是 nginx + SSH 反向隧道）。
- 插件不会自己编译安卓包，除非打开 `buildEnabled` 并配好工程目录。
- 手机端需要 DSH Pocket 这个 App，它负责扫码、拿设备令牌、带着 cookie 访问闸门。
