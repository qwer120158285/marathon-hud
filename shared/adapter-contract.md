# 共享绘制模块与两端薄适配层接口约定

依据 ADR 0001「共享绘制逻辑，不共享运行环境」。本文件是接口契约，不是实现说明；
真正的画布创建与绘制实现分别落在 `editor/preview.js`（浏览器）与 `cli/adapter.mjs`（Node，后续 ticket）。

## 边界

- `shared/` 下的代码只依赖标准 JavaScript 与 Canvas 2D 上下文（`ctx`）；
  不引用 `window`、`document`、DOM API、`node:` 内置模块、`process`、`require`。
  该约束由 `tests/shared-boundary.test.mjs` 扫描源码强制。
- 共享模块不创建画布、不注册字体、不读文件、不拼路径；它只接收调用方传入的 `ctx` 与纯数据。
- 画布尺寸、设备像素比（DPR = 1）、颜色空间与透明背景由适配层固定，
  保证浏览器与 Node 的输入一致（ADR 0001 测试矩阵）。

## 适配层必须提供的两个能力

画布创建与字体注册只由适配层提供，签名两端一致：

| 能力 | 签名 | Node 侧（`@napi-rs/canvas`） | 浏览器侧 |
| --- | --- | --- | --- |
| 创建画布 | `createCanvas({ width, height }) → { canvas, ctx }` | `createCanvas(width, height)` | `document.createElement('canvas')`，显式设置 `width` / `height`，DPR = 1 |
| 注册字体 | `registerFonts(fonts) → Promise<void>` | `GlobalFonts.registerFromPath(path, family)` | `FontFace` 加载后 `document.fonts.add`，并等待 `document.fonts.ready` |

约束：

1. `createCanvas` 返回的 `ctx` 必须支持共享模块用到的 Canvas 2D 标准接口（`fillRect`、`fillText`、`stroke` 等）。
2. `registerFonts` 必须在第一帧绘制前 resolve；字体未就绪不得开始绘制（ADR 0001 技术边界 2）。
3. 字体文件、版本与 SHA-256 由 `project.json` 的 `fonts[]` 声明，两端使用同一份文件。

## 共享模块对外的接口

| 导出 | 位置 | 说明 |
| --- | --- | --- |
| `resolvePreset(id)` / `resolveCanvasPreset(canvas)` | `shared/presets.js` | 画布预设解析：画布尺寸、安全边距、格边长、网格规模、可放置格位范围 |
| `validateSchema(instance, schema)` | `shared/validate.js` | JSON Schema 子集校验，错误文本点名具体字段 |
| `drawFrame(ctx, layout, sample, staticLayer)` | `shared/hud.js`（后续 ticket） | 只用 `ctx` 与数据，不接触运行环境 |
