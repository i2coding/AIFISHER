# AIFISHER 开发笔记

> **这个文件放什么**：踩过的坑、做过的改动、以及"以后改这块必须保住什么"。
> **项目怎么跑、怎么构建、许可条款** → 看 [readme.txt](readme.txt)。
>
> 覆盖范围：2026-10-23 ~ 2026-10-29 的工作（画布四项交互、组框重构、终端日志面板）。
> 每条都标了**为什么**，因为很多约束看起来"多余"，删掉就会复现当初的 bug。

---

## 0. 先记住这四条

| # | 结论 | 违反了会怎样 |
|---|---|---|
| 1 | `scripts/runtime/` 是作者**故意剔除**的，不是丢文件 | 白花时间找它、或者把它当 bug 上报 |
| 2 | 构建必须 Node **24.20.0**（精确匹配） | `vite.stable.config.ts` 第一段直接抛错 |
| 3 | 桌面壳只读 `dist/`，**没有 dev server、没有热更新** | 改完前端以为能热更，实际看不到变化 |
| 4 | 在受限沙箱里构建会**先清空 dist 再失败** | 应用白屏，而且是"被自己搞坏的" |

---

## 1. 环境与构建

### 1.1 `scripts/runtime` 的真实情况

`package.json` 里 `typecheck` / `unit` / `build:stable` / `build:launcher` / `desktop:dev` / `check`
全部走 `node scripts/runtime/run.mjs`，但这个目录在公开源码里被作者刻意剔除了（发行策略，
见 `SOURCE-SCOPE.md`）。**不是缺陷，不要报 bug。**

它不可替代的职责只有一个：把命令交给 `engines.node` 指定的 Node（24.20.0）执行。因为 npm
自带的 Node 不一定是 24，而 `vite.stable.config.ts` 开头就硬校验版本。

现状（2026-10-23 由 AI 补的本地实现，**非作者原版**）：

```
scripts/runtime/run.mjs     按 engines.node 自动挑 Node，支持 --check / --npm
scripts/runtime/setup.mjs   runtime:setup 的实现：校验 Node + 首次下载 Electron
scripts/desktop/startSource.mjs
                            更早由 AI 补的启动脚本：装 electron → 生成图标 →
                            构建模型目录 → 构建 stable + launcher → 拉起 electron.exe
```

若以后拿到作者原版，直接覆盖 `run.mjs` 即可，`package.json` 不用改。删掉它，npm 那一套命令会重新失效。

### 1.2 Node 版本

必须 **24.20.0**，精确匹配，不是 `>=`。本机位置：`D:\environment\node-v24.20.0\node.exe`。

当前 shell 默认 22.x，所以直接 `node scripts/desktop/startSource.mjs` 会抛
「需要 Windows x64 和 Node 24.20.0」。

启动方式二选一：

```
A. npm run desktop:dev                                  ← 推荐，run.mjs 自动切版本
B. "D:\environment\node-v24.20.0\node.exe" scripts\desktop\startSource.mjs
```

Node 装在别处时：`AIFISHER_NODE` 指向 node.exe，或 `AIFISHER_NODE_DIRS` 给多个安装根目录（分号分隔）。

### 1.3 为什么没有热更新

`apps/desktop/src/windowManager.mjs` 里 `CANVAS_URL` 是常量 `app://aifisher/`；
`appProtocol.mjs` 的 `createAppProtocolHandler` 直接 `serveStatic(distDirectory)`，
只有 `/api`、`/library` 等路径转发到后端命名管道。

渲染层永远加载 `dist/` 里的静态产物，**不存在 vite dev server 这条路径**。
改完前端 → 重新构建 → 重启 Electron，这是唯一流程，不是脚本偷懒。
（原版 `run.mjs` 也不是 dev server，它只负责切 Node 版本。）

### 1.4 【重要】在受限环境里构建会破坏 dist

现象：跑 `npm run build:stable` 时，vite 的 `emptyOutDir` 要清空 `dist/`（含 creative-presets
共 300+ 文件），被环境的安全删除保护拦下：

```
[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] count:350 threshold:50
targets: ["...\\dist\\creative-presets"]
```

而这个清空是「先删一部分再失败」—— `dist/assets` 已被清空，`index.html` 还在但引用的 js/css 没了，
应用直接白屏。

正确做法：临时配置关掉 `emptyOutDir`，原地覆盖产物。新建 `vite.rebuild.config.ts`：

```ts
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.stable.config';

export default mergeConfig(base, defineConfig({ build: { emptyOutDir: false } }));
```

执行（用 `run.mjs` 保证 Node 版本对）：

```
node scripts/runtime/run.mjs node_modules/vite/bin/vite.js build --config vite.rebuild.config.ts
```

跑完**把临时配置删掉**，不要留在仓库里。代价是旧 hash 的 chunk 会残留（几 MB，不影响运行），
要清就只删 `dist/assets` 里没被 `index.html` 引用的文件。

**绝不要做**：

- `rm -rf dist` / `del /s /q dist`
- 在 dist 被部分清空后继续启动应用，然后以为是代码问题

验证 dist 是否健康：

```
grep -o '/assets/[^"]*' dist/index.html   # 取出引用
ls dist/assets                            # 引用的文件必须都在
```

---

## 2. 数据与配置的真相

### 2.1 模型目录不是双数据源

`src/config/modelConfig.ts` 是**唯一真源**（4400+ 行手写大表）。
`server/config/modelCatalog.generated.json` 是 `scripts/build-model-catalog.mjs` 用 esbuild
求值 `modelConfig.ts` 后生成的**产物**（122 个模型）。

重新生成后 git 应该零差异。要改模型/价格，改 ts，**不要手改 json**。
（我一开始误判成"双数据源"，已撤回。）

### 2.2 各种数据放在哪（开发态）

开发态的根是 `D:\source\AIFISHER\.desktop-dev\data`（由 `installation.mjs` 决定），
下面按用户分目录：`.desktop-dev/data/users/<userId>/`。

| 数据 | 位置 |
|---|---|
| 画布项目 / 文件夹 | `library/workflows.db`（SQLite） |
| 素材库 | `library/media/`、`library/assets/` |
| 后端日志 | `data/logs/backend.{stdout,stderr,lifecycle}.log` |
| **工作流运行台账** | `private/execution-workflows/`（**不在** workflows.db 里） |
| Provider 配置 | `config/providers.env` |

`private/execution-workflows/` 下的子目录：

```
definitions/ deployments/ binding-sets/ attestations/   工作流定义与部署快照
test-run-receipts/<runId>.json                          正式回执（约 1.8KB）
pending-receipts/<uuid>.json                            待发布回执
idempotency/test-runs/                                  幂等记录
input-stage-ledgers/ input-snapshots/ output-staging/   输入暂存与产物落地
```

排查"某个任务到底跑没跑成"时，**直接看 `test-run-receipts/<runId>.json` 最快** —— 里面有
`succeededAt`、`outputs`（路径、字节数、sha256）。不要只看界面状态。

---

## 3. 画布交互（节点锚点 / 剪线 / Shift 换线 / 组）

这一组是照 `D:\source\Infinite-Canvas01` 的**手感**在 AIFISHER 里重写的，没有搬运它的代码
（那边是 Python 单体 + 1.6 万行纯 JS，物理上不能复用；它的许可也要求二次开发开源署名）。
照抄它的**配色/风格**同样不可取 —— 它的画布偏白，用淡色卡片透气；AIFISHER 的场景是深色，
用浅色填充会糊掉内容。

### 3.1 节点锚点（`src/stable/nodes/canvasNodeFrame.tsx`）

常驻显示的 **28px 圆点**，圆心压在节点左右边缘上，热区 **50px**（不是跟着鼠标飘的按钮）。
空心 = 未连接，实心 = 已连接。

- 左端（输入）读自己的 `parentIds`
- 右端（输出）靠 `registerNodeConnections()` 登记的**反向索引**（谁把我当父亲）判断

> ⚠ 这个反向索引是**模块级变量**，由 `CanvasScene` 每次渲染前登记一次。如果以后把节点渲染
> 挪出 `CanvasScene`，必须自己再调一次，否则输出圆点永远是空心。

**踩过的坑**：第一版为了"贴边"把热区缩到很小、又改成 hover 才显示，结果"更难点了"。
用户的原始诉求是"常驻、好点、空心/实心表达状态"，不是"贴着边"。改样式前先确认这三点。

### 3.2 按住 C 划线剪断（`src/stable/canvas/canvasCutMode.ts`）

在 window **捕获阶段**接管 `pointerdown/move/up`，剪线期间 `stopPropagation`，把画布自己的
拖拽/框选挡在外面；松手后按 marked 集合一次性断开。

命中判定**不是**算贝塞尔距离，而是逐点 `elementFromPoint` 命中连线上的透明 32px 热区，
靠 `canvasEdges.tsx` 里的三个属性定位这条线：

```
data-fisherai-edge-parent / data-fisherai-edge-child / data-fisherai-edge-port
```

> ⚠ 改 `canvasEdges` 的 `<g>` 时这三个属性不能删；改属性名要同步改 `canvasCutMode.ts`
> 的 `CUT_EDGE_ATTR` 和 `readEdges()`。

**"有时候剪不断"的三个确定性原因**（已修，别退回去）：

1. 命中要用 `document.elementsFromPoint`（**复数**）扫所有叠层。单数版只取最上层，
   组框/遮罩会把下面的线挡住 → 那一段永远剪不断。
2. 指针移动是离散采样，手快时两点间隔几百像素 → 必须按 `SAMPLE_STEP`(6px) 沿轨迹插值逐点判定。
3. 松手顺序：**先松 C 再松鼠标是常态**。任何 `keyup` 都 cleanup 的旧实现会把这一笔静默丢弃。
   现在只认 C/Esc，且用 `flush()` 结算而不是丢弃。
   更关键：**结算与退出必须在同一个监听器里按顺序执行**。拆成两个 keyup 监听器时，
   先跑的那个 `setActive(false)` 会触发 effect 清理把标记清空，第二个监听器就什么也拿不到。
   现在 keyup 里先 `flushRef` 再 `setActive`，并且 `cleanup` 自身也会把"进行中的这一笔"
   结算掉（Esc 取消除外）。

### 3.3 Shift 换线（对标 ComfyUI 的换线手感）

两种粒度，都保留：

**a) Shift + 拖节点圆点 = 整束搬移（主用法）**

```
抓右/输出口 → 这一束线的「来源」换人，落点成为新的上游
抓左/输入口 → 这一束线的「去向」换人，落点接管这些上游
```

> ⚠ 两种都当"换上游"处理的话，抓输入口会变成 B→A，用户看到的就是"绕回原点"。
> 这个语义错误真实发生过，`canvasBundleReattach.reattachBundle` 里必须分开处理。

实现要点：

- `canvasApplication.startBundleDrag` 把这个端口上的**全部**连线一起摘下来，画面立刻只剩
  "收成一个点、跟着鼠标"的一束；松手落在另一个节点上就把这一束全部接过去。
- 松在空白/原节点上 = 取消，用 `snapshots` 逐个还原（`parentIds` 顺序、端口槽位不变）。
- ⚠ **起手必须"当场断开"**，不能"先接后断"，否则中途会同时出现两束线（用户说的"又拉了一条"）。
- ⚠ 落位**不要**走 `connectCanvasNodes`：它在类型/容量/槽位被占时会**静默返回原数组**，
  表现就是"明明松手了却没接上"。用 `canvasBundleReattach.ts` 的 `reattachBundle` 直接写
  `parentIds`（ComfyUI 写回原槽位、普通节点插回原下标、还原 Image 的 `imageMode`）。
  这个函数可以单独 esbuild 出来跑用例验证，改它之后请务必跑一遍。
- ⚠ 手势**不要**复用 `useCanvasConnections` 的拖拽状态机（它只服务"从端口拉新线"，
  整束搬移复用它时 hover 判定根本不更新 → 目标节点不亮、落点算不出来）。
  自己用 window 的 `pointermove/pointerup` 驱动预览、高亮与落点。

**b) Shift + 按住某一条连线 = 单条改接（`startEdgeRewire`）**

按指针横坐标判断抓上游端还是下游端；同样起手即断开 + 失败还原快照。松在空白处是取消，
不能走 `openMenu`（会弹添加节点菜单）。

### 3.4 组框与成员（改动最多的一块）

**组框是独立存的一份数据**（`CanvasGroup.frame`），这是我改过架构的地方：

- 创建组时按成员包围盒外扩 `GROUP_FRAME_PADDING` 算一次
- 之后只由右下角的缩放柄（`data-fisherai-group-resize-handle`）改它
- **缩放只动框，成员图片尺寸完全不变**（早期复用多选缩放会把图一起放大，用户明确否掉了）
- 整组拖动时 `translateGroupFrames` 把框一起平移；拖单个成员时框不动
- 旧数据没有 `frame` 的，会在下次同步时补一份并写回

**成员进出组的判定：只剩一条** —— 节点中心在框内就留、出框就走、进框就加入。

> **两条历史实现都已废弃，别再照着写**：
> 1) 早期用"按成员算的包围盒"判离组 —— 框跟着被拖的节点一起变大，永远拖不出去；
> 2) 后来改用"到其他成员的矩形距离"判退组 —— 相距较远的正常组员被判离组，
>    刚打好的组在下一次**任意**拖动后自动散开（用户报的是"打组打不上"）。
>
> `frozenGroupFrame` / `freezeGroupFrameFor` 那套冻结机制已经**整个删掉**了。

其他必须保住的行为：

- **顺序坑**：整组拖动时必须**先平移组框、再判成员去留**。反过来框还在原地，所有成员都被
  判成"出框" → 组被解散（真实发生过：拖动后组直接消失）。
- **缩框**松手时立刻结算一次成员：框外的出组并断开组下游的线；只剩 1 个成员按既有规则解散。
- **渲染坑**：选中整个组时走的是"多选"分支，它以前没带 `frameOverride`，会退回按成员包围盒
  算框 → 一选中框就缩小、组连线看着连在框外。现在两条分支（选中组 / 未选中组）都从
  `group.frame` 取框。
- **拖动体验**：拖组框时，框的位置在渲染期由"锚点节点位移"实时推导
  （`groupDragRef` → `groupFrameOffset` → `Selection`/`Edges`），松手用同一个位移写回 frame。
  ⚠ 这个偏移**不能缓存**（别用 `useMemo`）：清空 ref 的那一次渲染必须立刻变成 `null`，
  否则旧偏移会让框在松手瞬间再推一次。
- **出组断线**（`dropDepartedGroupLinks`）：组传给下游是每个成员各连一条，成员被移出后
  线还留着就会"明明出组了还连着"。判定条件是"组里还有**别的**成员连着同一个下游"，
  这样用户单独连过的线不会被误删；整组解散时一条都不删。
- **入组接线**（`connectJoinedGroupLinks`）：对称，拖进组时自动接到"这一组已连着的下游"，
  否则它视觉上进组了却不参与下游生成。
- **组连线合并**：`canvasEdges.tsx` 把"同一组里 ≥2 个成员指向同一个下游"的线**合并成一条**
  从组框右边缘中点出发的线（`portIndex` 记为 -1，带 `data-fisherai-edge-parents`）。
  ⚠ 这条视觉线背后是**多条**数据连接：剪断（`canvasCutMode.readEdges`）和双击删除都要按
  parents 逐个断开，别只断第一个。
- ⚠ 少于 2 个成员的组会自动解散（沿用 `canvasGroups.ts` 的既有语义，三处判定都依赖它）。

---

## 4. 终端日志面板

入口：画布顶部栏右侧的终端图标（`data-fisherai-terminal-toggle`），有未读时带角标，
有 error 时角标变红。面板固定在底部，可拖顶边调整高度，ESC 关闭。

**职责分在三个文件里，别合并**：

```
src/stable/diagnostics/logBus.ts       前端日志总线（模块级单例 + 订阅，项目里没有 zustand）
src/stable/diagnostics/logCapture.ts   自动采集：fetch 失败 / 未捕获异常 / console.error|warn
src/stable/dialogs/canvasTerminal.tsx  面板 UI（前端 / 后端两个 tab、级别筛选、搜索、复制、下载）
```

后端配套：

```
server/diagnostics/logRing.js     内存环形缓冲（400 条），由 createSecureLogger 的 onLog 回调填充
GET /api/diagnostics/logs?tail=N  优先返回内存环（带级别和时间戳），空了回退读日志文件
```

**为什么后端要单独做内存环**：日志文件是纯文本、没有级别；stdout 和 stderr 是两个文件，
行与行之间排不出先后。内存环按写入顺序、带级别，点开面板就能看到"刚才那条报错"。

**改这块的五条硬约束**：

1. 包装 fetch **不能改变原行为**：必须原样返回原 Response、原样抛出原异常。读错误体只能用
   `clone()`，而且要有超时；`content-type` 是 `text/event-stream` 时直接跳过 —— 流式响应的
   body 读一次就没了，克隆去读会一直等不到结尾。
2. AbortError 记 **debug** 不记 error：切页面、取消请求很频繁，否则满屏红。
3. console 包装必须有 `logging` 标记**防递归**，否则面板自身出错会无限套娃。
4. 通知合并到 `requestAnimationFrame`、持久化合并到 1 秒（`logBus.emit` / `schedulePersist`）。
   去掉这两个节流，console 刷屏时每条日志都触发一次 500 行重渲染，主线程直接卡住。
5. 持久化必须脱敏：前端用 `redactForStorage`（先抹 Key 再抹 URL 查询串）；
   后端内存环用 `redactSecretsOnly`（去 Key、**保留路径**，排错要看路径）；
   而 stdout 与 `/api/diagnostics/export` 走 `redactSensitive`（连路径一起抹）。
   **两套策略别混用**，也别把 `redactSensitive` 的结果喂给面板（路径已经变成 `[PATH]`，恢复不回来）。

来源标签约定：`net`（fetch）、`runtime`（未捕获异常）、`console`、`生成`、`app`。
新增业务日志沿用这套标签，面板的搜索和筛选都是按 `source + message` 匹配的。

测试：`tests/logBus.test.ts`（11 条：脱敏、环上限、级别映射、订阅）、
`tests/canvasTerminal.test.tsx`（6 条：显隐、筛选、搜索、清空）。
`vite.config.ts` 的 `test.include` 已经扩成 `tests/*.test.{js,ts,tsx}`。

---

## 5. 排查手册

### 5.1 终端里那条 `PENDING_RECEIPT_NOT_FOUND` 红色 ERROR

**它不是故障，可以放心忽略。** 完整含义：

> 一个工作流已经跑完了，但"把结果正式登记进台账（写回执）"这一步还没做完，系统正在等重试。

来源：`server/workflowRuntime/workflowTestRunService.js` 的 `getRun`。任务已 `success`，
但发布回执没完成时走 `recoverPendingReceipt`，读不到 pending 文件 → 抛
`PENDING_RECEIPT_NOT_FOUND` → **记 error**（其实开的是重试提示），然后返回
`status: loading, phase: publishing-receipt` 让前端继续轮询。

回执机制的完整链条：

```
stagePendingReceipt   写 pending-receipts/<uuid>.json
completeIfActive      提交调度终态（任务变 success）
publishReceipt        写 test-run-receipts/<runId>.json + 删 pending
localized.commit()    产物正式落地
```

回执只有约 **1.8KB**，内容是配置哈希、产物路径/大小/sha256、`schedulerCommitProof`
（防重复扣费）、两次 sha256（防篡改）。**毫秒级，不慢** —— 别把"任务跑了 4 分钟"误判成
"记账慢"，那 4 分钟通常是云端出图或上游重试。

2026-10-29 的真实案例：服务启动 **28 毫秒**后界面就来查上次留下的任务，那一刻回执还没生成、
pending 也不在（上次关软件卡在中间），于是报一次；同一时段还有 3 次
`POST /api/workflow-library/<id>/canvas-runs` 返回 **502**（RunningHub 上游拒绝）；
4 分钟后重跑成功，回执正常落地、产物 1.4MB。

**判断标准**：

| 现象 | 结论 |
|---|---|
| 启动时出现一两次，之后节点正常出结果 | 忽略，启动时序的正常抖动 |
| 同一个 runId 反复刷、节点一直转圈不结束 | 真卡住了，需要清理该任务的 pending/回执 |

排查时**直接看磁盘**最快（路径见 §2.2）：`test-run-receipts/<runId>.json` 有就说明成了，
看 `succeededAt` 和 `outputs`。

### 5.2 工作流提交返回 502

`502` 在这套代码里只有一个来源：**本地 ComfyUI 或 RunningHub 那边调不通**
（`LocalComfyClientError` / `RunningHubWorkflowClientError`，连接失败、协议错误、素材上传失败）。

但当前 `requestContext` 的中间件只记录状态码，**不记录上游的具体错误消息**，所以日志里看不到
原因。要定位只能：复现一次，然后看终端「后端」tab 或 `logs/backend.stderr.log` 的上下文。

（已向 master 建议把上游错误码与消息一并记进日志，2026-10-29 明确回复"算了，就这样吧"，
**不要再提议改**。以后再遇到，直接按上面解释。）

---

## 6. 测试现状（别被"测试通过"骗了）

```
npm run typecheck      ✅ 0 错误
npm run unit           ✅ 21/21
npm run build:stable   ✅（需按 §1.4 绕开 emptyOutDir）
```

`tests/` 下只有三个文件：

- `community.test.js` —— 主要验证「公开范围边界」（闭源 SKILL 没泄漏、公钥不含私钥），**不是业务测试**
- `logBus.test.ts` / `canvasTerminal.test.tsx` —— 2026-10-29 新增，覆盖日志总线与终端面板

也就是说 12 万行代码里，**画布、生成、工作流这些核心逻辑基本没有测试覆盖**。
所以「测试通过」只能说明没碰坏这几块，**不能当作功能正确的证据**。
画布交互这类改动，必须真的在界面上点一遍。

好用的验证手法（比写测试快）：

- 纯逻辑（`canvasGroupMembership` / `canvasBundleReattach` / `logRing`）：
  单独 `esbuild` 成 cjs，写几十行脚本跑用例，验证完删脚本。
- 后端接口：临时 `express` 挂上目标 router，起一个随机端口 `fetch` 一遍，验证完删脚本。
  （注意：脚本必须放在项目目录里跑，`/tmp` 找不到 `node_modules`。）

---

## 7. 已修问题清单（避免重复排查）

| 问题 | 结论 |
|---|---|
| `modelPicker.ts` 的 TS6133（`setSourceVisible` 未使用） | 与 `sourceSettings.ts` 的 `setSourceVisibleInPicker` 逻辑重复、共用同一个 localStorage key，已删（-10 行）。⚠ `isSourceVisible` 仍被模型列表过滤使用，**不要一起删** |
| `node scripts/desktop/startSource.mjs` 直接跑报版本错 | shell 默认 Node 22，必须用 24.20.0 或走 `npm run desktop:dev` |
| 构建把 `dist/assets` 清空导致白屏 | 见 §1.4，用 `emptyOutDir: false` 的临时配置重建 |
| 剪线"有时候剪不断" | 见 §3.2，三个原因都已修 |
| Shift 换线"看起来又拉了一条" | 起手必须先断开；落位不能走 `connectCanvasNodes` |
| 拖组后整个组消失 | 结算顺序错了，必须先平移框再判成员 |
| 选中组时框缩小、连线悬空 | 多选分支没带 `frameOverride` |
| 组内节点拖不出来 | 组框跟着成员变大（已改为独立存储） |

---

## 8. 协作与沟通约定

这些是这轮协作里反复验证过的有效做法，和具体人无关，换谁配合都适用。

- **结论先行，再讲为什么**：读者不一定熟悉这块代码，先给"是什么 / 严重不严重 / 要不要处理"，
  再补机制。解释复杂机制时用生活类比（"记账""取快递"）比堆术语有效。
- **一次只改一件事**：多项交互一起改，出问题时就定位不到源头。做完一项、验一项、再动下一项。
- **不要拿参考项目的风格硬套**：`Infinite-Canvas01` 的淡色卡片风被否过一次（"填充改回深灰"）。
  参考它的**交互逻辑**可以，配色和质感要按 AIFISHER 自己的深色场景来。
- **改完必须验证**：typecheck + unit + build 三件套；纯逻辑（组员判定、整束落位、日志环）
  单独 esbuild 出来跑用例。只跑 typecheck 就交活等于没验。
- **判断错了立刻改口**：这个项目里至少错判过三次 —— `scripts/runtime` 是不是漏的、模型目录
  是不是双数据源、Shift 换线的语义方向。三次都是被截图纠正的。别硬撑，别把错的说成"设计如此"。
- **不要主动加配置项/开关**：诉求通常是"按最合理的方式做掉"，不是"给我一堆选项"。
- **提建议可以，对方说"算了"就停止提议**（日志级别那次就是），别反复劝。

---

*最后更新：2026-10-29*
