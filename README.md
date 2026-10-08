# 网易云音乐 · DSH 右侧栏插件

在 DSH 右侧栏里播放网易云音乐：手机号/Cookie 登录、**多账号保存与切换**、
浏览并播放自己的歌单、切换播放方式（顺序 / 列表循环 / 单曲循环 / 随机 / 心动）。
播放音质固定为极高音质（`exhigh`）——原先的音质切换器已移除，见下方说明。
扫码登录也已移除：网易云服务端以「安全环境风险」拒绝该授权，无法在协议层绕过，见下方说明。

- 插件包名：`@local/dsh-netease-music`
- 安装位置：本目录（`dsh-netease-music/`），已通过 `plugin_manager install_bundle` 安装进 `web` profile
- 入口：左侧边栏底部 **♪** 按钮（在「设置」上方，折叠成 56px 竖条时同样可见）；
  右侧栏 **+** → *网易云音乐*；首次加载会自动打开一次
  （原先注册的 `Ctrl+Alt+M` 快捷键已移除：DSH Web 只放行极少数组合，该键会被宿主拒绝，
  按了没有反应，见下方说明）

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch`、`dsh.client`（web 半区）、图标与显示名 |
| `cordis.patch.yml` | 插入 Host 行 `netease-music` |
| `index.js` | Host 半区：注册 `/api/dsh-netease-music` 前缀路由（API 代理、登录、音频转发） |
| `lib/netease.js` | 网易云 API 客户端：`weapi` 加密、Cookie 持久化、歌单/歌曲/搜索/心动模式 |
| `client.js` | 浏览器半区：右侧栏标签页类型 + 播放器 UI、左侧边栏底部的 ♪ 快捷按钮、对话框上方的歌词展示框 |
| `locale/zh.json`、`locale/en.json` | 插件列表里的显示名与描述 |

## 扩展点

| 位置 | 注册方式 |
|---|---|
| 右侧栏标签页类型 | `ctx.sidebarRightTabs.register({ id, kind: 'netease-music', keepMounted: true, guide })` |
| 右侧栏面板内容 | `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: '@local/dsh-netease-music' }, Root)` |
| 左侧边栏快捷按钮 | `ctx.slots.inject('sidebar.footer.action')` → `ctx.slots.register({ name: 'sidebar.footer.action', id: 'netease-music', order: 20 }, FooterEntry)` |
| 对话框上方的歌词展示框 | `ctx.slots.inject('conversation.input.dock')` → `ctx.slots.register({ name: 'conversation.input.dock', id: 'netease-music', order: 200 }, NowPlayingDock)` |

快捷按钮注册在左侧边栏底部、紧邻「设置」的动作位，折叠成 56px 竖条时仍是图标按钮；
它只读取 `openTabs` 快照来高亮当前是否已打开，不持有任何状态。
播放器实例挂在插件闭包（`playerRef`）而不是组件里，因此收起面板、切换会话都不会中断播放。
样式表由 `apply()` 注入 `document.head`（全部 `.nenm-` 前缀），因为快捷按钮和歌词框都不在面板 DOM 里。

## 歌词展示框

对话框上方的常驻信息条，从左到右依次是**歌曲名/作者、当前与下一句歌词、律动（频谱面积图）**。

- **不可交互**：整棵树里没有任何 `button` / `a` / `input`、没有事件处理器、没有可聚焦元素，
  容器还带 `pointer-events:none`，所以它既不抢焦点也不挡对话框的点击。歌词只读，切歌只能在播放器里做。
- **紧贴对话框**：它注册在 `conversation.input.dock` 的**最后**（`order: 200`，在 todo/goal/queue 与
  git-graph 的 chip 之后）。该 slot 的外层包裹是 `display:contents`，所以它既是 composer 栈的直接
  flex 子元素、又靠 `margin-bottom: calc(0px - var(--dsh-composer-stack-gap) - 3px)` 抵消栈间距，
  从而与下方输入卡片严丝合缝；宽度用 composer 自己的 `--dsh-composer-card-max-width` 等令牌算出，
  和输入框左右对齐。这也是它必须排最后的原因——后面若还有条目插进来，缝隙就会出现。
- **律动**：展示框**最右端**的镜像频谱面积图（`步骤采样 → 填充区域 + 顶边描边`）。
  采样自真实的 `<audio>` 输出（`AnalyserNode.getByteFrequencyData`，每帧重绘）；
  只取能量集中的前 60% bin 摊在**左半边**、再从中心向两边镜像，所以峰值落在中轴、
  两侧对称下落，整条带宽都被用上——旧行为把 32 个 bin 直接铺满 16 列，低频能量
  堆在左端、右半边永远是 8% 的平地，整块看起来「缩在左边」。暂停时冻结在最后一帧、
  面积透明度降低；`prefers-reduced-motion` 下不跑动画循环。
- **开关**：播放器底部**同一行**、与「序号 / 总数 · 歌单名」齐平（`.nenm-playerFoot`）。
  原先它在歌单名下方单独一行，看起来是悬空的，现合并为一行、靠 `margin-left:auto` 推到右侧。
  是一个真正的 `<input type="checkbox">` + 视觉轨道，所以键盘可聚焦、有 focus ring、有可访问名。
  状态存在 `dsh.netease-music.prefs` 的 `dock` 字段里（与音量、播放方式同一个 key）；
  默认**开启**，关掉后展示框不渲染任何节点。
- **歌词对齐**：靠播放器已有的定时器做 500ms 轮询（store 的 position 一秒才提交一次，
  单靠它最多会晚 1 秒）。播放且**有歌词**时定时器才存在，暂停、纯音乐、未播放时都不跑。
- **base 层不可读**：逐字扫色的文字是「底色 + 填充」两层叠加，底色层带 `aria-hidden=true`，
  否则无障碍树里每个字出现两遍、屏幕阅读器把歌词念两次（实测已修复）。
- **歌词切换有过渡**：当前句的节点 `key` 用的是**行号**，所以换行时 React 换的是节点而不是
  原地改文本，`nenm-dockLineIn`（0.34s 上移淡入）每次都会重放，读起来是过渡而不是硬切。
- **制作人员行会被剔除**：网易云把`作词 : 张三`、`钢琴 : 何秉舜`这类 credits 也当作带时间戳的
  歌词行，且在曲末只有 **0.1 秒**的间隔——留在时间轴里会一瞬间连跳十几行，看起来就像
  「上一句还没唱完就跳走了」。`creditLabel()` 取冒号**之前**的标签，对照一份乐器/职能词汇表
  （中英繁）判断，命中就整行丢弃。实测 57 首真实歌词：全部 credits 被拦下，没有误删歌词。


## 为什么需要 Host 半区

网易云的网关不返回 CORS 头、音频 CDN 需要匹配的 Referer，登录 Cookie 也不该落在页面存储里。
因此浏览器半区只跟同源的 `/api/dsh-netease-music` 说话，由 Host 半区去访问 `music.163.com`：

- 明文 `/api/*` 网关：账号查询（网易云接受未加密请求）
- `weapi` 网关：其余接口（密码/验证码登录、歌单、歌曲地址、搜索）——它们是 AES-128-CBC 两次 + RSA，见 `lib/netease.js`
- `/audio?src=…` 转发 CDN 音频，透传 `Range`，域名白名单（默认只允许 `*.music.126.net` 等）

### 为什么没有扫码登录

曾经实现过，且二维码内容已与官方 `ctWebLogin` 组件对齐（`/st/platform/scanlogin?codekey=…&chainId=…`，
轮询带 `x-login-chain-id` 与 `X-loginMethod: QrCode`）。手机端确实能识别、显示授权页并点「确认登录」，
但**轮询随后必定返回**：

```json
{"code":8821,"message":"请切换其他登录方式或升级新版本再试",
 "redirectUrl":"…/anquanhuanjingfengxian"}
```

`anquanhuanjingfengxian` = 「安全环境风险」。已做的对照：**完全照抄官方客户端的请求（weapi +
`ydDeviceToken` + 两个头）、乃至直接使用官方登录页自己的 `chainId`，结果同样是 8821**；
「公共环境」与「安全环境」两种选择也都试过。这是服务端风控判定，协议层无法绕过，
故整个功能（界面、路由、二维码生成库 `lib/qr.js` 与 `lib/qrcodegen.js`）已一并移除。

请使用**手机号登录**或 **Cookie 登录**。

登录态保存在 `$DSH_HOME/netease-music/session.json`（0600），浏览器侧不持有 Cookie。

### 多账号

同一份文件里保存**多个账号**（`{ version: 2, activeUserId, accounts: [...] }`），
右上角头像点开即可看到账号列表、切换、`添加用户`（手机号 / Cookie 两种登录）
或退出当前账号。切换账号只改变后续请求使用哪一份 Cookie，歌单与播放状态会随之重置。

- 旧版单账号文件（顶层直接是 `cookie` + `profile`）会在首次 `save()` 时**自动迁移**成一个账号，昵称、头像与 `MUSIC_U` 均保留。
- 新登录的 Cookie 永远不会覆盖已保存的账号，靠两道保证：
  1. 账号列表里存的是工作会话 Cookie 的**拷贝**（`syncActive()` / `useAccount()` 都做展开复制）。只把 `stateUserId` 置 `null` 是**不够**的——若共享同一个对象，原地写入仍会改到已保存的账号；
  2. 每次登录都从干净状态开始（不用旧账号的 Cookie 去合并），拿到的 Cookie 归属新账号。
- 登录失败、或身份无法确认（401 / 无 profile）时会回退到原账号，不会留下半残状态。
- Cookie 登录要求能取回 `profile` 才算成功：失效的 Cookie 同样含 `MUSIC_U` 字符串，只看它会把死号当成登录成功。
- Cookie 失效（401）时只移除那一个账号，并自动切换到下一个可用账号。
- 面板在 Host 尚未提供 `/accounts` 时会退化为「只显示当前账号」，不会报错。

### 大歌单为什么能显示全（曾经不能）

`/v6/playlist/detail` 一次能给的曲目详情**取决于歌单是不是自己的**，且完全忽略 `s`/`offset`：

| 歌单类型 | 详情条数 |
|---|---|
| 自己的歌单 | 最多 **1000** 首 |
| **关注的（订阅）歌单** | 只有 **20** 首 |

所以「关注的歌单只显示 20 首」并不是插件设的限，而是这个接口的真实返回；无论 `n` 传多大、
怎么翻页都一样。

但同一个响应里的 **`trackIds` 对两种歌单都是完整且有序的**。于是 `playlist()` 的做法是：

1. 取一次 `/v6/playlist/detail`，拿 `trackIds` 全量 id 与已带详情的那部分；
2. 把缺的 id 按 **1000 一批**（这是 `/v3/song/detail` 的上限，超过会返回 400）
   通过 `/v3/song/detail` 补齐；
3. 按 `trackIds` 的顺序重排、去重，得到完整曲目表。

补齐出来的曲目字段与原始详情一致（封面、时长、歌手、专辑齐全），VIP/付费标记也照常。
实测自有 3460 首约 3.4 秒、订阅 884 首约 2 秒。批次失败只记警告、不炸整份歌单，
此时 `truncated` 才为 `true`。客户端**不再分批渲染**——原先只画 150 行、要点「显示更多」
的按钮已移除，3460 行渲染约 0.8 秒。

## 与 dsh-web-all / 皮肤插件的关系

面板里除专辑封面外，**所有颜色都取自 `--dsw-alias-*` 主题令牌**
（`bg-layer-1/2`、`border-l1`、`label-primary/secondary`、`brand-primary`、`state-*`），
根容器不设背景。因此：

- DSH 明暗主题切换时面板自动跟随，无需重绘逻辑；
- dsh-web-all 的皮肤中心（`ctx.theme.overrideTokens`、自定义主题、壁纸）覆盖令牌后，面板即时生效，壁纸可直接透出；
- 插件不 `import` 任何 Harness Client 包，令牌是它与宿主之间唯一的样式契约，令牌改名只会降级外观、不会让面板崩掉。

### 交互态不要用 `bg-layer-*`（易踩坑）

浅色主题下 **`--dsw-alias-bg-layer-1` 与 `-2` 都是 `#fff`**，与面板背景同色，用它做悬停/选中
等于白对白、完全看不见。交互态请用带透明度的专用令牌：

| 用途 | 令牌 | 浅色 | 深色 |
|---|---|---|---|
| 悬停 | `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` |
| 选中（分段控件等） | `--dsw-alias-interactive-bg-active` | `#2631481a` | `#ffffff24` |
| 正在播放/多选行 | `--dsw-alias-bg-multi-select` | `#f5f6f7` | `#212123` |

`bg-layer-*` 仍适合做**图片占位底色、容器与标签**这类非交互用途。

## 宿主路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 登录态、当前账号与账号列表 |
| GET | `/accounts` | 已保存的账号列表（含活动标记） |
| POST | `/accounts/switch` | 切换活动账号（`{userId}`） |
| POST | `/accounts/remove` | 忘记某个账号（`{userId}`） |
| POST | `/login/phone` | 手机号 + 密码 |
| POST | `/login/captcha/sent` | 发送短信验证码 |
| POST | `/login/captcha` | 手机号 + 验证码 |
| POST | `/login/cookie` | 粘贴浏览器 Cookie（需含 `MUSIC_U`） |
| POST | `/logout` | 退出并移除**当前**账号（还有别的账号时自动切过去） |
| GET | `/playlists` | 我的歌单（含“我喜欢的音乐”） |
| GET | `/playlist?id=` | 歌单详情与**全部**曲目（无 limit） |
| POST | `/song/url` | 按音质解析播放地址（`{ids, level}`） |
| GET | `/lyric?id=` | 歌词 |
| GET | `/search?keywords=&type=&limit=` | 搜索单曲 / 歌单 / 歌手 |
| GET | `/intelligence?pid=&sid=` | 心动模式推荐队列 |
| GET | `/audio?src=` | 音频转发（Range 透传、域名白名单） |

音质取值：`standard` `higher` `exhigh` `lossless` `hires` `jyeffect` `sky` `jymaster`，
其中后五项为会员专属；账号无权时接口返回无地址，面板会提示并回退，不会静默失败。

> 面板**已移除音质切换器**：实测切换档位对本账号没有可感知差别（非会员账号下后五档只会
> 回退），所以播放请求固定使用 `exhigh`，并忽略本地持久化里遗留的 `quality` 值。
> Host 路由的 `level` 参数仍然保留，接口层面依旧可用。

## 卸载

在 设置 → 插件 中停用或卸载 `@local/dsh-netease-music`；本目录可随时删除。
登录态文件位于 `$DSH_HOME/netease-music/session.json`。
