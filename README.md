# @dev_zf/dsh-conversation-search

DSH 插件：**在当前会话的对话内容里搜索关键词，并把匹配位置定位（滚动）到眼前。**

- `Ctrl+F` 打开查找栏，实时显示 `当前序号/总数`
- 命中文字高亮，当前匹配为蓝色，整条消息加一圈定位框
- `Enter` / `Shift+Enter` 逐条跳转，**循环**：到末尾自动回到开头
- 跳转把匹配**居中**在输入区以上的可视区域，停在同一个匹配上重复点击也不漂移
- 已加载窗口内没有命中时，可一键**翻页加载更早历史**后继续搜索
- 只注册一个输入区扩展槽位，不替换任何官方界面

## 安装

```sh
# 从 npm 安装（推荐）
dsh plugin --profile desktop add @dev_zf/dsh-conversation-search

# 从本地目录或 tarball 安装
dsh plugin --profile desktop add /path/to/dsh-conversation-search
dsh plugin --profile desktop add /path/to/dev_zf-dsh-conversation-search-0.1.0.tgz
```

安装后**重启 DSH**（新 bundle 需要重新组装 profile），再刷新页面。
离线分发、版本兼容与验收步骤见 [INSTALL.md](https://github.com/Zoom-EobardThawne/dsh-conversation-search/blob/main/INSTALL.md)。

## 使用方式

1. 打开任意会话（Chat 视图）。
2. 按 `Ctrl+F`（macOS 为 `Cmd+F`），或点击输入框上方的 **查找** 按钮。
3. 输入关键词，命中数量实时显示。
4. `Enter` 下一个匹配，`Shift+Enter` 上一个匹配；也可点 ↑ / ↓。
5. `Escape` 关闭；`Aa` 切换区分大小写。
6. 若已加载的消息里没有命中，点 **搜索更早消息** 翻页加载后继续搜索。

搜索范围是**已经渲染在当前会话里的消息文本**：用户消息、助手回复、工具/命令/流程行。
系统提示、上下文注入、压缩摘要等"幕后"行不参与搜索；输入区（composer）及其所在的
全宽包裹层也完全排除，避免命中落在一个跨满整屏的容器上。

## 行为细节

| 场景 | 行为 |
|---|---|
| 关键词跨多个行内元素（粗体、行内代码、链接） | 逐文本节点拼接后再匹配，可命中跨元素短语 |
| 会话正在流式输出 | 新渲染的内容会在下一次检索时进入索引；已有高亮位置保持 |
| 历史未载入 | 显示「搜索更早消息」，调用 `ISession.loadOlder()` 翻页后重搜 |
| 多条匹配落在同一条消息 | 每条匹配是独立结果，↑/↓ 会在同一条消息内逐处移动 |
| 切换会话 / 切到 Trajectory 等其他视图 | 自动重绑到当前会话的滚动容器；找不到容器时保持空状态，不报错 |
| 关闭查找栏（`Esc` 或 ✕） | 清空匹配列表，并移除所有高亮、定位框与临时预留的滚动留白 |

## 已知边界

- 搜索范围是**已加载的会话窗口**，不是整个历史；未加载部分需经「搜索更早消息」翻页
  （与 Chat 自身回合导航同样的限制）。
- 未做正则 / 整词匹配，只有大小写开关。
- 高亮依赖 `Range.getClientRects()`，与 Chat 的 Markdown 渲染方式一致；
  若将来 Chat 改用虚拟滚动只挂载可见行，需要改为基于会话事件建立索引。

## 排障

页面控制台提供诊断句柄，可直接读取插件内部状态：

```js
dshConversationSearch.diagnose()
// { sessionId, scroller, usableViewport, rows, blocks, entries, active, marks, ... }
```

`scroller: false` 或 `rows: 0` 通常表示当前 DSH 的会话 DOM 契约与插件预期不符。

## 仓库结构

```
dsh-conversation-search/
├── .gitignore
├── LICENSE
├── README.md
├── INSTALL.md
├── DEVELOPMENT.md
├── package.json
├── cordis.patch.yml
├── lib/
│   ├── index.js          手写：Host 半
│   └── client.js         产物：浏览器半
├── src/
│   └── client.js         源码：引擎 + 查找栏
├── scripts/
│   ├── dsh-paths.mjs
│   ├── build-client.mjs
│   ├── check.mjs
│   ├── pack.mjs
│   ├── publish.mjs
│   ├── verify-pack.mjs
│   ├── e2e-instance.mjs
│   ├── verify-overlay.mjs
│   ├── clean-e2e.mjs
│   └── read-asar.mjs
└── tests/
    └── engine.test.mjs
```

`dist/`（打包产物）与 `node_modules/` 已被 `.gitignore` 排除，不参与版本管理。

### 必需文件

缺任何一个都无法构建或运行：

| 文件 | 大小 | 作用 |
|---|---|---|
| `package.json` | 1.9 KB | 插件清单：`dsh.bundle.patch`、`dsh.client`、`exports`、`engines` |
| `cordis.patch.yml` | 309 B | bundle 层：把本包插入 Web 插件名册 |
| `src/client.js` | 48 KB | **唯一浏览器侧源文件**（引擎 + 查找栏），构建的输入 |
| `lib/index.js` | 418 B | Host 半入口，**手写、不可由构建生成** |
| `lib/client.js` | 50 KB | 构建产物；仓库内保留它，`dsh plugin add <目录>` 可免构建直接使用 |
| `scripts/build-client.mjs` | 3.3 KB | 构建脚本（`src` → `lib`，零依赖） |
| `.gitignore` | 233 B | 阻止 `dist/`、`node_modules/` 被提交 |

### 工具链文件

用于验证构建结果，以及打包与发布：

| 文件 | 大小 | 作用 |
|---|---|---|
| `scripts/check.mjs` | 2.5 KB | 清单契约与产物静态校验 |
| `tests/engine.test.mjs` | 24 KB | 引擎行为测试（Node + 自建 DOM 桩，零依赖） |
| `scripts/dsh-paths.mjs` | 2.6 KB | 路径解析（被下面几个脚本引用） |
| `scripts/pack.mjs` | 3.1 KB | 打出离线 tarball |
| `scripts/publish.mjs` | 3.7 KB | 构建 + 校验 + 测试 + 发布 |
| `scripts/verify-pack.mjs` | 3.2 KB | 验证 tarball 能装进全新 profile |
| `scripts/e2e-instance.mjs` | 3.0 KB | 起隔离 DSH 实例 |
| `scripts/verify-overlay.mjs` | 30 KB | 无头 Chrome 端到端，27 项断言 |
| `scripts/clean-e2e.mjs` | 3.0 KB | 清理隔离实例 |
| `scripts/read-asar.mjs` | 1.6 KB | 读取官方包源码以核对 DOM 契约 |

### 验收判据：克隆后能构建出完整插件

```sh
node scripts/build-client.mjs    # built lib/client.js (50065 bytes, id=@dev_zf/dsh-conversation-search)
node scripts/check.mjs           # ok: @dev_zf/dsh-conversation-search@0.1.0 — lib/client.js 50065 bytes
node tests/engine.test.mjs       # ok: engine behaviour checks passed
```

三条全部通过，即表示构建链完备。整个过程**不需要任何第三方依赖**，只用一个 Node。

## 开发

```sh
node scripts/build-client.mjs   # 重新生成 lib/client.js
node scripts/check.mjs          # 清单与产物静态校验
node tests/engine.test.mjs      # 引擎行为测试（自建 DOM 桩）
```

改动 `src/client.js` 后重新构建即可；DSH 的 Client HMR 会按产物 revision 推送新 bundle，
页面没自动热更时刷新一次即可。

构建细节、端到端验证方法、设计取舍与历史缺陷记录见
[DEVELOPMENT.md](https://github.com/Zoom-EobardThawne/dsh-conversation-search/blob/main/DEVELOPMENT.md)。

## 卸载

```sh
dsh plugin --profile desktop remove @dev_zf/dsh-conversation-search
```

或从 Settings → Plugins 里禁用 / 卸载。卸载只移除本 bundle 层，不改动会话数据。

## 许可

[MIT](LICENSE)
