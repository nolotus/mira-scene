# Mira · 72 小时作业验收与优化事项（持续更新）

基准：`docs/0912-candidate.pdf`；检查默认分支 `main` 中的实现。
本 PR **仅提交审查记录，不修改业务代码**。标注「代码通过」不等于真机/E2E 已通过。

## 检查进度

| 条目 | 必做要求 | 当前结论 |
|---|---|---|
| 01 | 场景与角色为视觉主体，非消息列表 | 代码结构通过；视觉待验证 |
| 02 | 背景、角色、字幕、文字和语音入口 | 代码结构通过；真机待验证 |
| 03 | 移动优先、桌面可用 | 代码基本通过；真机和可访问性待验证 |
| 04 | 待机、倾听、思考、说话四种状态 | 代码具备四态及仲裁；视觉转场待验证 |

## 优化事项

### 01 场景与角色
- **OPT-001 · P2 · 待验证**：做手机真实截图及横竖屏检查，确认角色始终为视觉主体、字幕/Dock 不遮挡主体。位置：`src/web/App.tsx`、`src/web/stage/Stage.tsx`、`src/web/styles/stage.css`。

### 02 基本页面元素
- **OPT-002 · P2 · 待验证**：320×568、375×667、长字幕（超过 5 行）、软键盘场景，验证 `stage-subtitle` （`max-height:30cqh`，5 行截断）与 Dock 的遮挡/裁切；必要时提供完整字幕查看方式。位置：`src/web/styles/stage.css`。
- **OPT-003 · P3 · 待验证**：语音识别不可用、权限拒绝时验证 Dock 降级提示与文字入口；目前已有降级代码，不认定为 Bug。位置：`src/web/ui/Dock.tsx`。

### 03 移动端适配
- **OPT-004 · P1 · 已确认的设计问题**：`index.html` 的 `maximum-scale=1.0, user-scalable=no` 限制用户放大。建议允许缩放，并测试缩放后可读性和可点击性。
- **OPT-005 · P2 · 待验证**：`100dvh` + 外层 `overflow:hidden`，尚未找到明确软键盘避让逻辑。iOS Safari / Android Chrome 测输入框焦点、中文输入法、地址栏折叠，必要时做 `visualViewport` 或布局策略适配。位置：`src/web/styles/app.css`、`src/web/styles/stage.css`。
- **OPT-006 · P2 · 待验证**：320×568、320×480、横屏、系统字体放大下，≤380px 次行换行可能挤压字幕与角色；以实际截图判断是否需要按可用高度收纳操作。位置：`src/web/styles/app.css`。
- **OPT-007 · P3 · 待验证**：桌面 700px 宽/600px 高断点上下以及横屏平板，检查布局切换是否突变。位置：`src/web/styles/stage.css`。

### 04 四种角色状态
- **实现依据**：`src/web/stage/visuals.ts` 的 `STATUS_SPEC` 明确定义 idle/listening/thinking/speaking 的位置、头部朝向、视线、呼吸；`src/web/state/presence.ts` 用 request/TTS/mic 仲裁可见状态；`src/web/App.tsx` 将仲裁后的状态传入 Stage；`src/web/stage/Stage.tsx` 将状态反映为 data-status 和 HUD。
- **OPT-008 · P2 · 待验证**：浏览器真机或 E2E 逐态截图与录屏，确认四态不仅存在，而且用户一眼可辨认；特别检查 thinking→speaking、说话句间、打断→listening 的转换。比较口型和真实音频时间线，避免只按状态枚举判定通过。位置：`src/web/state/presence.ts`、`src/web/stage/visuals.ts`、`src/web/stage/Character.tsx`、`src/web/stage/Stage.tsx`。
- **OPT-009 · P3 · 待验证**：默认 SVG 与 `?char=photo` 两种角色模式分别检查四态视觉可辨性，避免照片模式与默认模式不一致。位置：`src/web/stage/Stage.tsx`、`src/web/stage/characters/PhotoCharacter.tsx`。

## 验证原则
1. 分开标注：已确认缺陷、静态代码风险、真机待验证；未跑过的不写成「已测通过」。
2. 优先保证 PDF 核心必做条款；不提前扩建可选功能。
3. 继续审查 05–29 时往本文件追加，不在审查 PR 中直接改生产代码。
