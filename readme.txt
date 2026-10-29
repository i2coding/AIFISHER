================================================================
AIFISHER 源码环境备忘 —— 给下一个接手的人 / Agent
================================================================
项目：D:\source\AIFISHER   （AIFISHER 画布 v2.0.7）
最后更新：2026-10-23

先看这四句，能省你半天：
  1. scripts/runtime/ 是作者故意不公开的，不是丢文件，别去找、别报 bug。
  2. 构建必须用 Node 24.20.0，其它版本会在 vite.stable.config.ts 里直接抛错。
  3. 桌面壳只读 dist/，没有 dev server、没有热更新，改前端必须重新构建。
  4. 在 WorkBuddy 沙箱终端里直接构建会清空 dist，把能跑的产物搞坏（见 §4）。


----------------------------------------------------------------
1. scripts/runtime 的真实情况
----------------------------------------------------------------
package.json 里 typecheck / unit / build:stable / build:launcher /
desktop:dev / check 全都走 `node scripts/runtime/run.mjs`，
但这个目录在公开源码里是作者刻意剔除的（发行策略，见 SOURCE-SCOPE.md）。

它的唯一不可替代职责：把命令交给 engines.node 指定的 Node（24.20.0）执行。
因为 npm 自带的 Node 不一定是 24，而 vite.stable.config.ts 第一段就硬校验版本。

现状（2026-10-23 已补，属本地实现，非作者原版）：
  scripts/runtime/run.mjs    按 engines.node 自动挑选 Node，支持 --check / --npm
  scripts/runtime/setup.mjs  runtime:setup 的实现：校验 Node + 下载 Electron 运行时
  scripts/desktop/startSource.mjs
                             之前由 AI 补的启动脚本：装 electron → 生成图标 →
                             构建模型目录 → 构建 stable + launcher → 拉起 electron.exe

注意：run.mjs 是本地补的，不是原版。以后若拿到作者原版，直接覆盖即可，
package.json 不需要改。若删除它，npm run 那套命令会重新失效。


----------------------------------------------------------------
2. Node 版本
----------------------------------------------------------------
必须 24.20.0，精确匹配（不是 >=）。
本机可用位置：D:\environment\node-v24.20.0\node.exe
当前 shell 默认是 22.x，直接 `node scripts/desktop/startSource.mjs` 会抛
「需要 Windows x64 和 Node 24.20.0」。

启动方式二选一：
  A. npm run desktop:dev            ← 推荐，run.mjs 会自动切到 24.20.0
  B. "D:\environment\node-v24.20.0\node.exe" scripts\desktop\startSource.mjs

若 Node 装在别处，用环境变量 AIFISHER_NODE 指向 node.exe，
或用 AIFISHER_NODE_DIRS 给出多个安装根目录（分号分隔）。


----------------------------------------------------------------
3. 为什么没有热更新（别试图加 dev server）
----------------------------------------------------------------
apps/desktop/src/windowManager.mjs 里 CANVAS_URL 是常量 `app://aifisher/`；
appProtocol.mjs 的 createAppProtocolHandler 直接 serveStatic(distDirectory)，
只有 /api、/library 等路径才转发到后端的命名管道。

也就是说渲染层永远加载 dist/ 里的静态产物，不存在 vite dev server 这条路径。
改完前端 → 重新构建 → 重启 Electron，这是唯一流程，不是脚本偷懒。
（原版 run.mjs 也不是 dev server，它只负责切 Node 版本。）


----------------------------------------------------------------
4. 【重要】在这里构建会破坏 dist
----------------------------------------------------------------
现象：跑 npm run build:stable 或 desktop:dev 时，vite 的 emptyOutDir 要清空
dist/（含 creative-presets 共 300+ 文件），被环境的安全删除保护拦下：

  [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] count:350 threshold:50
  targets: ["...\\dist\\creative-presets"]

而这个清空是「先删一部分再失败」，结果是 dist/assets 已被清空，
index.html 还在但引用的 js/css 没了 → 应用直接白屏。

正确做法：临时换一份配置，关掉 emptyOutDir，原地覆盖产物。
新建 vite.rebuild.config.ts：

  import base from './vite.stable.config';
  export default {
    ...base,
    build: { ...(base as any).build, emptyOutDir: false },
  };

然后执行（用 run.mjs 保证 Node 版本对）：

  node scripts/runtime/run.mjs node_modules/vite/bin/vite.js build --config vite.rebuild.config.ts

跑完把 vite.rebuild.config.ts 删掉，不要留在仓库里。
代价是旧 hash 的 chunk 会残留（只有几 MB，不影响运行），
要清就手动只删 dist/assets 里没被 index.html 引用的文件。

绝不要做的事：
  - rm -rf dist / del /s /q dist
  - 在 dist 被部分清空后继续启动应用，然后以为是代码问题
验证 dist 是否健康：
  grep aifisher-build dist/index.html   # 应看到 content="v2.0.7"
  ls dist/assets                        # 应有 4 个文件，且与 index.html 引用一致


----------------------------------------------------------------
5. 模型目录不是双数据源（我一开始判断错了）
----------------------------------------------------------------
src/config/modelConfig.ts 是唯一真源（4400+ 行手写大表）。
server/config/modelCatalog.generated.json 是由 scripts/build-model-catalog.mjs
用 esbuild 求值 modelConfig.ts 后生成的产物，共 122 个模型。
重新生成后 git 应该零差异。要改模型/价格，改 ts，不要手改 json。


----------------------------------------------------------------
6. 已验证通过的检查（2026-10-23）
----------------------------------------------------------------
  npm run typecheck      ✅ 0 错误
  npm run unit           ✅ 4/4（tests/community.test.js）
  npm run build:stable   ✅ 2938 modules（需按 §4 绕开 emptyOutDir）
  npm run build:launcher ✅

注意：全仓只有 tests/community.test.js 一个测试文件，而且它主要验证
「公开范围边界」（闭源 SKILL 没泄漏、公钥不含私钥），不是业务测试。
所以「测试通过」不能当作功能正确的证据，12 万行代码基本没有测试覆盖。


----------------------------------------------------------------
7. 已经修掉的一个问题（避免重复排查）
----------------------------------------------------------------
src/stable/generation/modelPicker.ts 里曾有未使用的 setSourceVisible，
触发 TS6133 导致 typecheck 失败。它和 sourceSettings.ts 的
setSourceVisibleInPicker 逻辑完全重复、共用同一个 localStorage key
`fisherai.model-picker.source-toggles`，且无人调用，已删除（-10 行）。
modelPicker 里的 isSourceVisible 仍被模型列表过滤使用，不要一起删。


----------------------------------------------------------------
7.5 画布交互：节点锚点 / 拖线剪断 / Shift 改接 / 组连线
----------------------------------------------------------------
这一组是照 D:\source\Infinite-Canvas01 的手感在 AIFISHER 里重写的，
没有搬运它的代码（它是 Python 单体 + 1.6 万行纯 JS，不能直接复用）。

节点锚点  src/stable/nodes/canvasNodeFrame.tsx
  常驻显示的 28px 圆点，圆心压在节点左右边缘上，热区 50px（不是跟着鼠标
  飘的按钮）。空心=未连接，实心=已连接。左端读自己的 parentIds，右端靠
  registerNodeConnections() 登记的反向索引（谁把我当父亲）判断。
  ⚠ 这个反向索引是模块级变量，由 CanvasScene 每次渲染前登记一次。如果以后
  把节点渲染挪出 CanvasScene，必须自己再调一次，否则输出圆点永远是空心。

拖线剪断  src/stable/canvas/canvasCutMode.ts（按住 C 划一道线）
  实现在 window 捕获阶段接管 pointerdown/move/up，剪线期间 stopPropagation，
  把画布自己的拖拽/框选挡在外面；松手后按 marked 集合一次性断开。
  命中判定不是算贝塞尔距离，而是逐点 elementFromPoint 命中连线上的透明
  32px 热区，靠 canvasEdges.tsx 里的三个属性定位这条线：
    data-fisherai-edge-parent / -child / -port
  ⚠ 改 canvasEdges 的 <g> 时这三个属性不能删；改属性名要同步改
  canvasCutMode.ts 的 CUT_EDGE_ATTR 和 readEdges()。

  "有时候剪不断"的三个确定性原因（已修，别退回去）：
   1. 命中要用 document.elementsFromPoint（复数）扫所有叠层。单数版只取最上层，
      组框/遮罩会把下面的线挡住 → 那段就是剪不断。
   2. 指针移动是离散采样，手快时两点间隔几百像素 → 必须按 SAMPLE_STEP(6px)
      沿轨迹插值逐点判定。
   3. 松手顺序：先松 C 再松鼠标是常态。任何 keyup 都 cleanup 掉的旧实现会
      把这一笔静默丢弃 → 现在只认 C/Esc，且用 flush() 结算而不是丢弃。
      更关键的是**结算与退出必须在同一个监听器里按顺序执行**：拆成两个 keyup
      监听器时，先跑的那个 setActive(false) 会触发 effect 清理把标记清空，
      第二个监听器就什么也拿不到。现在 keyup 里先 flushRef 再 setActive，
      并且 cleanup 自身也会把"进行中的这一笔"结算掉（Esc 取消除外）。

Shift 换线（对标 ComfyUI 的换线手感，两种粒度）
  a) Shift + 拖节点上的圆点 = 整束搬移（主用法）
     两个方向语义不同，必须分开（canvasBundleReattach.reattachBundle）：
       抓**右/输出口** → 这一束线的来源换人，落点成为新的上游；
       抓**左/输入口** → 这一束线的去向换人，落点接管这些上游。
     两种都当"换上游"的话，抓输入口会变成 B→A，用户看到的就是"绕回原点"。
     canvasApplication.startBundleDrag：把这个端口上的**全部**连线一起摘下来，
     画面立刻只剩"收成一个点、跟着鼠标"的一束线；松手落在另一个节点上就把这一束
     全部接到那个节点（ComfyUI 的 output → output 拖动）。右圆点搬出边、左圆点搬入边。
     松在空白/原节点上 = 取消，用 snapshots 逐个还原（parentIds 顺序、端口槽位不变）。
     ⚠ 起手必须"当场断开"，不能"先接后断"，否则中途会同时出现两束线。
     ⚠ 落位**不要**走 connectCanvasNodes：它在类型/容量/槽位被占时会静默返回原数组，
       表现就是"明明松手了却没接上"。改用 canvas/canvasBundleReattach.ts 的
       reattachBundle 直接写 parentIds（ComfyUI 写回原槽位、普通节点插回原下标，
       并还原 Image 的 imageMode）。这个函数可以单独 esbuild 出来跑用例验证。
     ⚠ 手势本身也不要复用 useCanvasConnections 的拖拽状态机（它只服务"从端口拉新线"），
       自行用 window 的 pointermove/pointerup 驱动预览、高亮与落点。
     ⚠ ComfyUI 子节点的 portIndex 是槽位，必须原样带回；普通节点是追加，所以要
       用 reorderParentAt 把上游挪回原下标，否则参考图编号（图片1/图片2）会错位。
  b) Shift + 按住某一条连线 = 单条改接（startEdgeRewire）
     按指针横坐标判断抓上游端还是下游端；同样是起手即断开 + 失败还原快照。
     松在空白处是取消，不能走 openMenu（会弹添加节点菜单）。

组连线 + 成员动态变化
  dialogs/canvasSelectionBounds.tsx 里组框和多选框都有左右两个连接点，
  拖出去就是"整组一起连到下游"（走 batchConnecting + groupBatchSourceIds）。
  数据上仍然是每个成员各连一条（下游节点要靠 parentIds 拿到全部参考图），
  但 canvasEdges.tsx 会把"同一组里 ≥2 个成员指向同一个下游"的线合并成一条
  从组框右边缘中点出发的线（portIndex 记为 -1，并带 data-fisherai-edge-parents）。
  ⚠ 这条视觉线背后是多条数据连接：剪断（canvasCutMode.readEdges）和双击删除
  都会按 parents 逐个断开，改这两处时别只断第一个 parentId。
  拖动体验：拖组框时，框的位置在渲染期由"锚点节点位移"实时推导
  （canvasApplication.groupDragRef → groupFrameOffset → Selection/Edges），
  松手时用同一个位移写回 frame —— 所以拖动全程框跟着走，且落账后不会跳。
  ⚠ 这个偏移不能缓存（别用 useMemo）：清空 ref 的那一次渲染必须立刻变成 null，
  否则旧偏移会让框在松手瞬间再推一次。
  渲染坑：选中整个组时走的是"多选"那条分支，它以前没带 frameOverride，会退回
  按成员包围盒算框 → 一选中的瞬间框就缩小、组连线看着连在框外。现在两条分支
  （选中组 / 未选中组）都从 group.frame 取框。
  顺序坑：整组拖动时**必须先平移组框、再判成员去留**。反过来的话框还在原地，
  所有成员都被判成"出框"→ 组被解散（曾真实发生过：拖动后组直接消失）。
  缩框松手时会立刻结算一次成员：落在框外的成员出组并断开组下游的线；
  若只剩 1 个成员，按既有规则（组至少 2 个成员）解散。
  组框是**独立存的一份数据**（CanvasGroup.frame），创建组时按成员包围盒外扩
  GROUP_FRAME_PADDING 算一次，之后只由右下角的缩放柄（data-fisherai-group-resize-handle）
  改它 —— 缩放只动框，成员图片尺寸完全不变（早期复用多选缩放会把图一起放大，
  用户明确否掉了）。整组拖动时 translateGroupFrames 把框一起平移；拖单个成员时
  框不动。旧数据没有 frame 的会在下次同步时补一份并写回。

  成员进出组的一个坑（踩过两次）：组框是由成员包围盒算出来的，所以
   - 拖动中框会跟着被拖的节点一起变大 → 永远拖不出去；
   - 判定"是否还在框内"时若把节点自己算进去 → 自己撑大的框把自己吸回去。
  解决办法是拖动开始时把组框冻结（canvasApplication.freezeGroupFrameFor →
   frozenGroupFrame → Selection.frameOverride），判定用"节点中心是否还在
  这张冻结的旧框里"；加入其它组时算包围盒必须排除节点自己，并且同一次手势
  里不允许刚离开的组把它再收回去。改这块务必保住这三条。
  ⚠ 成员被移出组时，必须同时断掉它与"本组仍然连着的下游"之间的那条线
  （dropDepartedGroupLinks）：组传给下游是每个成员各连一条，线还留着就会
  看起来"明明出组了还连着"。判定条件是"组里还有别的成员连着同一个下游"，
  这样用户单独连过的线不会被误删；整组解散时则一条都不删。
  对称地，成员被拖**进**组时会自动接到"这一组已连着的下游"（connectJoinedGroupLinks），
  否则它视觉上进组了却不参与下游生成。两条规则都只认"组内其他成员也在连"的下游。
  canvas/canvasGroupMembership.ts 在每次拖动结束时结算成员，判定用
  「到组内其他节点的矩形距离」（进出两个阈值做迟滞），不是"中心点是否在
  组框内" —— 组框本身由成员包围盒算出，拿它判进出会自我指涉，永远判不出去。
  ⚠ 少于 2 个成员的组会自动解散（沿用 canvasGroups.ts 的既有语义）。

验收（都在 typecheck + unit 之后手工点过）：
  typecheck ✅ 0 错误   unit ✅ 4/4   build:stable ✅


----------------------------------------------------------------
8. 许可
----------------------------------------------------------------
AIFISHER Noncommercial Source License 1.0：允许非商业学习、研究、修改、
免费再分发；禁止商业使用（含接单、商业二开、倒卖安装包、收费托管）。
这不是 OSI 开源许可，别当开源项目对外分发或用于商业交付。
