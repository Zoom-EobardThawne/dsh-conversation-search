# 安装

本插件是标准 DSH bundle（`dsh.bundle.patch` + `dsh.client`），支持三种安装方式：

| 方式 | 适合 | 命令 |
|---|---|---|
| npm registry | 联网环境、多台机器 | `dsh plugin --profile desktop add dsh-conversation-search` |
| 本地目录 | 想改代码，或直接从源码使用 | `dsh plugin --profile desktop add <仓库目录>` |
| tarball | 离线 / 内网分发 | `dsh plugin --profile desktop add <file.tgz>` |

## 前置条件

1. 目标机已安装 DSH（桌面版或 `dsh` CLI），并能启动 Web 界面。
2. DSH 版本：**0.2.0-rc.1 ≤ 版本 < 0.3.0**（见 `package.json` 的 `engines.dsh`）。
   查看版本：`dsh --version`。
3. 包管理器：`dsh plugin` 会使用 DSH 自带的 pnpm，**无需单独安装**。

## 方式一：从 npm 安装

```sh
dsh plugin --profile desktop add dsh-conversation-search

# 锁定版本
dsh plugin --profile desktop add dsh-conversation-search@0.1.0
```

## 方式二：从本地目录安装

```sh
dsh plugin --profile desktop add /path/to/dsh-conversation-search
```

这会在 profile 里建立 link 依赖：该目录不能删除或移动，否则依赖会断。
好处是修改 `src/client.js` 后重新构建即可生效。

## 方式三：从 tarball 安装（离线）

在本仓库先打包：

```sh
node scripts/pack.mjs          # 产出 dist/dsh-conversation-search-0.1.0.tgz
```

把 `.tgz` 传到目标机后：

```sh
dsh plugin --profile desktop add /path/to/dsh-conversation-search-0.1.0.tgz
```

## 让插件生效

**重启 DSH。** 仅刷新页面不一定足够：新 bundle 需要重新组装 profile。

- 桌面版：从托盘 / 菜单退出后重新打开。
- CLI 起的 web：停掉进程后重新执行 `dsh web`。

重启后刷新页面，任意会话的输入框上方应出现 **查找** 按钮。

## 验收清单

| # | 操作 | 期望 |
|---|---|---|
| 1 | `dsh plugin --profile desktop list dsh-conversation-search --depth 0` | 列出该 bundle，版本 0.1.0 |
| 2 | 重启 DSH，打开 Web 界面，F12 → Console | 无 `dsh-conversation-search` / `ModuleLoader` 相关报错 |
| 3 | Console 输入 `dshConversationSearch.diagnose()` | 返回对象，含 `scroller` / `rows` / `entries` |
| 4 | 打开一个**有消息的**会话，按 `Ctrl+F` 搜一个词 | 出现 `n/m` 计数；命中黄色高亮、当前匹配蓝色、整条消息一圈定位框 |
| 5 | 连点 `Enter` 到底再点一次 | 从最后一个循环回第 1 个 |
| 6 | 停在某个匹配上再点一次 | 画面不移动（保持居中） |

第 4 步看不到高亮时：先确认所搜的词确实在**当前会话已加载的消息**里，
再看 `dshConversationSearch.diagnose()` 的 `entries` 是否大于 0。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-conversation-search
```

或从 Settings → Plugins 里禁用 / 卸载。卸载只移除本 bundle 层，
不删除会话数据，也不改动其它插件。

## 版本兼容

插件依赖的浏览器侧契约（`[data-conversation-scroll]`、`[data-conversation-session]`、
行上的 `data-chat-flow-kind`、`conversation.input.dock` 槽位）在 **DSH 0.2.0-rc.x** 上验证通过。

在更早的 0.1.x 上：

1. 先按验收清单第 1–3 步确认安装与加载；
2. `diagnose()` 返回 `scroller: false` 或 `rows: 0` → 会话 DOM 契约不同，需要适配选择器；
3. `entries > 0` 但无高亮 → 浮层绘制环节需要适配。

未适配时插件只是"装了但不工作"，**不会**破坏 DSH：它只注册一个 UI 槽位条目，
不替换官方界面，也不改会话数据。
