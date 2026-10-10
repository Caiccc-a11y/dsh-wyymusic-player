# 网易云音乐 · DSH 右侧栏插件

在 DSH 右侧栏里播放网易云音乐。

- 插件包名:`@local/dsh-wyymusic-player`
- 适用环境:DSH Web / DSH 桌面版(需要 Host 半区代理,浏览器无法直连网易云接口)
- 下载:**[一键安装包 v1.0.0](https://github.com/Caiccc-a11y/dsh-wyymusic-player/releases/latest)**(Windows / Linux 双击即装)

## 功能

### 登录与多账号

- **手机号登录**:手机号 + 短信验证码(可先发送验证码)
- **Cookie 登录**:粘贴浏览器里的网易云 Cookie(需含 `MUSIC_U`)
- **多账号保存与切换**:右上角头像点开账号列表,可切换、添加用户或退出当前账号;
  各账号的 Cookie 独立保存,一个账号失效不影响其他账号
- 登录态保存在 `$DSH_HOME/wyymusic-player/session.json`(权限 0600),浏览器侧不持有 Cookie

> **密码登录已移除。** 网易云对 `/weapi/login/cellphone` 的风控极严:密码登录会先被
> `400 登录失败,请进行安全验证`、`10004 当前登录存在安全风险` 等拦下(此时服务器
> 根本不会校验密码,对错都一样),且反复尝试可能连累账号被临时限制。验证码与
> Cookie 两种方式不受影响。

### 播放

- **浏览并播放自己的歌单**:大歌单也能完整显示(自动分批补齐曲目详情,实测 3000+ 首约 3 秒)
- **播放方式切换**:顺序 / 列表循环 / 单曲循环 / 随机 / 心动模式
- **音质**:固定使用极高音质(`exhigh`)
- 收起面板、切换会话**不会中断播放**(播放器实例不随面板卸载)

### 界面

- **右侧栏播放器**:歌单列表、进度条、音量、播放控制;列表窗口化渲染,大歌单滚动不掉帧
- **左侧边栏 ♪ 快捷按钮**:位于「设置」上方,侧栏折叠成竖条时同样可见,一键打开/关闭播放器
- **歌词展示框**:对话框上方的常驻信息条——歌曲名/作者、当前与下一句歌词、随音乐律动的频谱图;
  逐字扫色、切句有过渡动画;纯展示不挡点击,可在播放器底部开关
- **主题跟随**:颜色全部取自 DSH 主题令牌,明暗主题与皮肤插件(壁纸、自定义主题)即时生效

### 已知限制

- **没有扫码登录**:网易云服务端对该授权方式返回「安全环境风险」(code 8821),协议层无法绕过,请用手机号或 Cookie 登录
- **订阅(收藏)歌单的曲目详情接口只给 20 首**:插件会自动用 song/detail 补齐,但若补齐批次失败,列表可能不全
- 部分音质档位为网易云会员专属,无权限时面板会提示并回退

## 安装

### 方法一:一键安装包(推荐,Windows / Linux)

1. 到 **[Releases](https://github.com/Caiccc-a11y/dsh-wyymusic-player/releases/latest)** 下载
   `dsh-wyymusic-player-installer-v1.0.0.zip`
2. **解压**到任意目录(不要在压缩包里直接双击)
3. 运行安装器:

   | 系统 | 操作 |
   |---|---|
   | Windows | 双击 `安装.cmd`,弹窗点「是」 |
   | Linux / macOS | 双击 `install.sh`(选「运行」/「Run in Terminal」),或终端里 `./install.sh` |

4. 装完按提示重启 DSH,左侧边栏底部就会出现 ♪ 按钮

> 不需要 `sudo`:插件装在 `$DSH_HOME` 里。
> Windows 若提示「已保护你的电脑」,点「更多信息」→「仍要运行」。
> 需要 Node.js 18 或更高版本。

安装器做的事:校验 `payload/manifest.json` 的 SHA-256 → 复制插件到
`$DSH_HOME/plugins/dsh-wyymusic-player/` → 登记进 profile(优先走官方 `dsh plugin add`)
→ 校验依赖与路由 → 询问是否重启 DSH。解压目录之后可以随意删除,不影响已装好的插件。

### 方法二:从 GitHub 克隆后用插件管理器安装

```bash
git clone https://github.com/Caiccc-a11y/dsh-wyymusic-player.git
```

然后在 DSH 对话里让 AI 调用 `plugin_manager` 工具,动作选 `install_bundle`,
`target` 填克隆出来的目录的**绝对路径**,例如:

```
action: install_bundle
target: /home/你的用户名/dsh-wyymusic-player
```

安装会自动完成 profile 清单写入、补丁应用与重启加载,对当前 profile 的所有会话生效。

### 方法三:在 DSH 插件页安装

打开 **设置 → 插件**,选择安装本地 bundle,指向本目录(`dsh-wyymusic-player/`)即可。

### 安装后

1. 左侧边栏底部点 **♪** 按钮(或右侧栏 **+** → *网易云音乐*)
2. 首次打开会自动弹出登录页,用手机号验证码或 Cookie 登录
3. 选择歌单开始播放

## 卸载

### 用安装包装的

```bash
./install.sh --uninstall            # Linux / macOS
node install.mjs -u                 # 通用(在解压出来的目录里执行)
node install.mjs -u --purge         # 连同登录态一起删除
```

Windows:`powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall`

卸载会从 profile 里移除登记(原配置备份为 `package.json.bak-<时间戳>`),
并询问是否删除插件目录。**登录态默认保留**,加 `--purge` 才一并清除。

### 手动装的

1. 在 **设置 → 插件** 中找到 `@local/dsh-wyymusic-player`,停用或卸载
2. 如需彻底清理,删除插件目录和登录态文件:

```bash
rm -rf /path/to/dsh-wyymusic-player          # 插件目录
rm -rf "$DSH_HOME/wyymusic-player"          # 登录态(session.json,含所有已保存账号的 Cookie)
```

> 不删除 `$DSH_HOME/wyymusic-player` 的话,下次重新安装可以沿用之前登录的账号。

## 许可证

[MIT](./LICENSE)
