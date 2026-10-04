# 开发与验证记录

面向维护者：构建方式、测试与端到端验证方法、设计取舍，以及开发过程中修复过的缺陷清单。
使用者只需要看 [README.md](README.md) 与 [INSTALL.md](INSTALL.md)。

## 环境

| 项 | 要求 |
|---|---|
| Node.js | `^22.19.0 || >=24.0.0`（`package.json` 的 `engines.node`） |
| 目标 DSH | `>=0.2.0-rc.1 <0.3.0-0` |
| 额外依赖 | **无**。构建与测试只用 Node 内置模块，不需要安装任何 npm 包 |

### DSH 便携版的运行时

DSH 自带 Node 与 pnpm，但**两者都不在 PATH 上**，而且其 Node 发行版**不含 npm**：

```
<DSH>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
<DSH>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs
```

在这类机器上要么用绝对路径调用，要么临时把 node 目录加入 PATH（仅当前会话）。

脚本不会把机器专属路径写死：`scripts/dsh-paths.mjs` 按下面的顺序解析外部程序，
**通常无需任何配置**：

1. 环境变量覆盖（见下表）；
2. **从当前运行时的 `process.execPath` 反推**——这些脚本通常正是被 DSH 自带的 Node 执行的，
   它位于安装目录内的固定偏移处，因此 `dsh.cmd` 与 `pnpm.cjs` 都能推出来；
3. PATH 上的同名命令。

另外，`pack.mjs` 与 `publish.mjs` 检测到 `node` 不在 PATH 时，会自动把当前运行时的目录
前置进子进程的 PATH，这样 `prepack` 钩子才不会失败。

环境变量仅用于覆盖（例如把工具装在非默认位置）：

| 变量 | 覆盖对象 | 使用脚本 |
|---|---|---|
| `DSH_E2E_PNPM` | pnpm 入口（`pnpm.cjs`） | `pack.mjs`、`publish.mjs` |
| `DSH_E2E_DSH` | `dsh` 启动器（`dsh.cmd`） | `e2e-instance.mjs`、`verify-pack.mjs` |
| `DSH_E2E_CHROME` | 浏览器可执行文件（CDP 用） | `verify-overlay.mjs` |

## 构建与校验

```sh
node scripts/build-client.mjs   # src/client.js → lib/client.js
node scripts/check.mjs          # 清单契约、产物 id/包装、无顶层 ESM
node tests/engine.test.mjs      # 引擎行为测试（Node + 自建 DOM 桩）
```

`lib/client.js` 是构建产物，**不要手改**。

### 客户端产物的形态

`src/client.js` 以 lazy-CJS 形态编写（`require('react')`、行首 `export const`），
`build-client.mjs` 负责三件事：

1. 把行首的 `export const X` 改写为 `exports.X`（函数声明形式会被拒绝，构建期直接报错）；
2. 套上 `window.__ModuleLoader__.load({ id, body })` 包装，`id` 取包名；
3. 用 `node:vm` 编译一次，语法错误在构建期暴露，而不是留到浏览器里。

浏览器内核（`@deepseek-ai/dsh-client-modules`）按 `package.json` 的 `dsh.client`
声明把 `./client` 产物组合进 Web boot graph，并在 `/plugins` 下托管。

## 测试

### 1. Node 引擎测试（`tests/engine.test.mjs`）

自建 DOM 桩 + 桩服务，不启动浏览器。覆盖：

- 索引范围：全宽信封与输入区**必须**排除，系统提示 / 进程组行不参与；
- 跨文本节点匹配、大小写开关；
- 循环定位（`Next` 在末尾回到第一个，`Previous` 在开头回到最后一个）；
- 居中数学：按可用区居中、滚动被末端 clamp 的边界、超高目标按顶部锚定、
  **重复选中同一匹配不产生漂移**；
- 浮层几何：Range 只覆盖匹配本身、容器尺寸矩形被丢弃、`close()` / `dispose()` 释放；
- 翻页：`loadOlder()` 后重建索引能看到新行。

桩里刻意复刻线上层级，因为"信封 / 输入区被当成搜索块"正是踩过的坑：

```
[data-conversation-content] → [data-conversation-scroll] → [views, composerSeat]
```

### 2. 真实浏览器端到端（`scripts/verify-overlay.mjs`）

无头 Chrome + Chrome DevTools Protocol，**不依赖任何 npm 包**（用 Node 内置 WebSocket
与 fetch 手写 CDP 客户端）。流程：起一个隔离 DSH 实例 → 在**真实会话滚动容器**里注入
符合 `ui-chat` 契约的消息行 → 用插件自身 UI（`Ctrl+F`、输入、`Enter`）驱动 → 读回真实几何。

```powershell
node scripts/e2e-instance.mjs 19488              # 隔离实例，打印带 token 的 URL
node scripts/verify-overlay.mjs "<该 URL>"        # 27 项断言
node scripts/clean-e2e.mjs                        # 停进程 + 删隔离 DSH_HOME
```

覆盖点（27 项，全部通过）：

- `Ctrl+F` 打开查找栏、输入后计数为 `1/3`；
- 高亮为 `position: absolute` 且有底色；每个高亮都落在滚动容器可视区内；
- **高亮紧贴匹配词**（实测 `56×21`，诊断 `tallestMark=21`、`fallbacks=0`），
  而不是铺满整块；
- 当前匹配带独立高亮，且整行有定位框；
- `Next` 从 `3/3` 循环回 `1/3`；`Shift+Enter` 从 `1/3` 循环回 `3/3`；
- 跳转落点不会停在输入区背后；跳转把匹配瞄准可用区中心；居中所需的滚动留白确实预留；
- 页面与应用框架**零位移**；`Esc` 关闭并释放浮层；全流程无控制台报错；
- 索引断言：输入区文字不入索引、全宽信封与输入区都不会成为搜索块。

> 合成夹具无法忠实复刻真实 shell 的 sticky 输入区几何，因此**滚动定位的精确数学**
> 由 Node 测试断言，实时脚本只断言可测的等价性质（落点在可用区内、瞄准中心、
> 留白已预留）。

### 3. 安装链路验证（`scripts/verify-pack.mjs`）

把打好的 tarball 装进一个全新的一次性 profile，检查三件事：
`package.json` 里出现该依赖、`dsh.profile.bundles` 已选中该 bundle、
`node_modules` 下的产物就位。

实测记录：`dependency: file:…/dev_zf-dsh-conversation-search-0.1.0.tgz`、
`bundleSelected: true`、`installedArtifact: true`；用该安装启动实例后
浏览器验收 27/27 通过。也就是说"打包 → 全新环境安装 → 加载 → 运行"整条链路验证过。

## 发布

```sh
# 1) 登录（任选其一）
npm login                                   # 经典交互登录
# 或把 npmjs.com 生成的 Automation token 写入 ~/.npmrc：
#   //registry.npmjs.org/:_authToken=<token>

# 2) 预演（不需要登录，只打包不发布）
node scripts/publish.mjs --dry-run

# 3) 发布
node scripts/publish.mjs
```

`publish.mjs` 依次执行：构建 → 清单校验 → 引擎测试 → 用可用的包管理器发布
（优先 `npm`，其次 `pnpm`，或由 `DSH_E2E_PNPM` 指定）。透传参数给发布命令，
例如 `--otp <code>`、`--tag next`。

`prepack` 钩子（`npm publish` / `pnpm publish` 会自动触发）保证发布前重新构建并校验产物。

`package.json` 的 `files` 白名单只包含运行必需的 7 项：
`lib/index.js`、`lib/client.js`、`cordis.patch.yml`、`src/client.js`、
`README.md`、`INSTALL.md`、`LICENSE`。
开发工具（`scripts/`、`tests/`）与 `DEVELOPMENT.md` 只进 Git 仓库，不进 npm 包。

### 作用域包（scoped）注意事项

本包是 **`@dev_zf/dsh-conversation-search`**，发布时有三点与无作用域包不同：

1. **必须声明 public**。作用域包默认按 `restricted`（私有）发布，免费账号会直接失败。
   `package.json` 已带 `"publishConfig": { "access": "public" }`，请勿删除；
   也可在命令行显式加 `--access public`。
2. **scope 必须归发布者所有**。`@dev_zf` 是发布账号 `dev_zf` 的**个人作用域**，
   `npm whoami` 返回 `dev_zf` 时即可直接发布；若换成别的 scope，需要先建同名组织。
3. **`cordis.patch.yml` 里的包名必须加引号**。YAML 的裸标量不能以 `@` 开头，
   所以写 `name: "@dev_zf/dsh-conversation-search"`；
   `scripts/check.mjs` 会比较"去引号后的值"，因此带引号不会导致校验失败。

打包文件名也会随作用域变化：`@dev_zf/dsh-conversation-search` 打出的 tarball 是
`dev_zf-dsh-conversation-search-0.1.0.tgz`（`@` 去掉、`/` 换成 `-`），
安装后在 profile 里落在 `node_modules/@dev_zf/dsh-conversation-search/`。
`scripts/verify-pack.mjs` 与 `scripts/e2e-instance.mjs` 都直接从 `package.json`
读包名，改名后无需再改脚本。

## 诊断句柄

插件在页面上挂 `window.dshConversationSearch`：

```js
dshConversationSearch.diagnose()
// sessionId, scroller, scrollerTag, usableViewport, lastReveal, scrollTop,
// rows, kinds, blocks, entries, active, marks, fallbacks, widestMark,
// tallestMark, visibleEntries, layerConnected, styleTag

dshConversationSearch.engine.blocks()
// 每个索引块：kind / envelope / composer / length / text
```

`lastReveal` 是上一次居中的完整计算过程
（`targetTop`、`targetHeight`、`anchor`、`scrollTop`、`maxTop`、`top`、`spacer`），
排查"定位偏了"时最有用：`anchor` 应落在 `usableViewport.top + height/2` 附近。

## 设计取舍

- **引擎与视图分离**：引擎（索引、匹配、滚动、翻页、浮层）不依赖 React；
  React 组件只渲染查找栏并镜像引擎状态。Cordis 服务上下文在 `apply` 里捕获
  （slot 组件的 props 不含 `ctx`），按 occurrence 生成闭包组件。
- **不替换任何官方 UI**：只注册一个 `conversation.input.dock` 条目（`order: 40`，
  排在 todo/goal/queue 之后），不占用 `conversation.composer` 这类 chain 槽位，
  也不碰官方 Chat 视图。
- **依赖最小化**：只用平台模块表里的 `react`；`ui-primitives` 为可选
  （缺图标时回退为文本字形）；不声明任何 `@deepseek-ai/dsh*` peer 依赖，
  避免被版本准入拒绝。
- **DOM 契约**：`[data-conversation-scroll]`（滚动容器）、`[data-conversation-session]`、
  `[data-conversation-region]`、行上的 `data-chat-flow-kind` / `data-chat-anchor-key` /
  `data-chat-turn`。这些与 Chat 自身的阅读位置、翻页、回合轨所用一致，因此相对稳定。
- **浮层的两条硬约束**：必须显式撑满视口且不参与普通流（否则整个界面被顶上去）；
  定位必须 `fixed` 且不落在会建立包含块的祖先下。
- **滚动定位**：只改对话自己的滚动容器 `scrollTop`，不用 `scrollIntoView`
  （后者会连带滚动所有可滚动祖先，窗口跟着抬升）。
- **居中的基准是"输入区以上的可用区"**：输入区是滚动容器的子节点，
  按整个滚动容器居中的话目标会落到输入区背后。
- **匹配文本节点每次重新解析**：消息重渲染后旧节点失效，其 `getClientRects()`
  返回旧坐标，会造成"幽灵高亮"与错误定位；索引只保存块内字符偏移。
- **浮层裁剪用滚动容器的可视区**，不用 `window.innerHeight`：文档本身可滚动时，
  后者会给滚动区外的匹配画高亮。

## 已修复的回归（勿回退）

这些都是实际出现过的缺陷，回归测试已覆盖：

| 缺陷 | 症状 | 现在的做法 |
|---|---|---|
| `paint()` 从未被 `search()` / `setActive()` 调用 | 计数正确但**没有任何高亮** | 两条路径结束时都调用 `paint()` |
| 高亮元素少了 `-mark` / `-ring` 属性后缀 | CSS 选择器、排除规则、DOM 全对不上 | 属性名统一为 `data-dsh-conversation-search-{layer,bar,mark,ring}` |
| 浮层曾用 `position: absolute` 零尺寸盒参与普通流 | 一打开查找栏**整个界面被顶上去** | `position: fixed` + 显式视口盒（`inset:0`、`margin/padding/border:0`、`transform:none`） |
| 用 `scrollIntoView` 定位匹配 | 连带滚动所有可滚动祖先，窗口跟着抬升 | 只改对话自己的滚动容器 `scrollTop` |
| 关闭查找栏只隐藏视图 | 高亮浮层留在画面上 | `engine.close()` 清空匹配并重绘浮层 |
| 排除自身 DOM 时用了 `[data-dsh-conversation-search]` | 被标记为当前匹配的消息行在下次重建索引时**消失** | 排除列表只列 `-layer/-bar/-mark/-ring` 四个具体属性 |
| 取块范围包含 `[data-conversation-content]` 全宽信封与输入区 | 命中输入区文字时**索引跨满整屏** | 信封按结构识别（`data-conversation-content` 的祖父是 `[data-conversation-scroll]`）并排除，输入区整体排除，只取每行自己的正文容器 |
| `paint()` 的 Range 覆盖**整个块**（首文本节点 → 末文本节点），而不是匹配本身 | 命中一个词，**高亮铺满该块的所有行**（长回复几乎铺满整屏） | `matchRange()` 按 `start/length` 精确框住匹配所在的文本节点区间；并加 `plausibleTextRect()` 丢弃"容器尺寸"的矩形，兜底路径高度也限制为一行 |
| 跳转按**整个滚动容器**的可视高度居中 | 输入区是滚动容器的子节点，目标被居中到**输入区背后**，必须再往下滚一下才看得到 | `usableViewport()` 把可用区域算到 `[data-composer-seat]` 顶部为止（作用域限定在当前 occurrence），按该区域居中 |
| 目标"已在可视范围内"就直接跳过滚动 | 停在同一个匹配上再点一次会**上移**（第一次只做了最小滚动，没有居中） | 每次定位都执行居中，不再有"已可见就跳过"的提前返回；重复选中同一匹配算出同一个位置，因此不漂移 |
| `Next` / `Previous` 在首尾处被夹住 | 到 3/3 再点就不动了 | 循环：最后一个的下一个是第一个，第一个的上一个是最后一个 |
| 会话末端无法把最后一个匹配居中（滚动被 clamp） | 最后几条消息的定位总是偏下 | `ensureRevealRoom()` 在滚动容器末尾预留 `可用区高度/2 - 输入区遮挡高度` 的留白（隐藏节点，`pointer-events:none`），用完即随 `dispose()` 移除 |
| 索引里保存的文本节点在消息重渲染后失效 | 失效节点的 `getClientRects()` 返回**旧坐标**，高亮与定位都基于过期几何（实测出现过 `top: -57` 的"幽灵"高亮） | `matchSpans()` 每次绘制/定位都按块文本偏移重新解析当前文本节点，索引只保存偏移量 |
| 浮层按 `window.innerHeight` 裁剪 | 文档本身被滚动时，会为滚动区外的匹配画高亮 | `viewportBand()` 用滚动容器自身的可视区裁剪 |

## 脚本清单

| 脚本 | 用途 |
|---|---|
| `dsh-paths.mjs` | 解析 `dsh` / `pnpm` / 浏览器路径（覆盖 → 从运行时反推 → PATH） |
| `build-client.mjs` | 构建 `lib/client.js`（包装 + 语法编译校验） |
| `check.mjs` | 清单契约与产物静态校验 |
| `pack.mjs` | 打出可离线分发的 tarball |
| `publish.mjs` | 构建 + 校验 + 测试 + 发布（含 PATH 与 Git 检查提示） |
| `verify-pack.mjs` | 验证 tarball 能装进全新 profile |
| `e2e-instance.mjs` | 起隔离 DSH 实例（供端到端验证使用） |
| `verify-overlay.mjs` | 无头 Chrome 驱动真实界面，27 项断言 |
| `clean-e2e.mjs` | 停隔离实例并删除其 DSH_HOME |
| `read-asar.mjs` | 从 `app.asar` 读取官方包源码，核对 DOM 契约与调用签名 |
