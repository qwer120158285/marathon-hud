# 归档：marathon-hud-demo

这里放的是**迁移前的参考实现**（原始路径 `marathon-hud-demo/`），只作历史参考，不参与构建、测试或出片。

## 它是什么

一个最小可运行的离线 HUD 合成 Demo：Node.js + `@napi-rs/canvas` + FFmpeg，
输入 CSV 运动数据 + `input.mp4`，输出带（透明的）HUD 的成片。原始用法见同目录 `README.md`。

## 为什么保留

它是首版实现的事实依据，不是废弃代码：

- `src/render.js` 真机验证了**管道拓扑**（透明 RGBA → FFmpeg `overlay`）与**背压**（`write()` 返回 false
  等 `drain`，并用 `close` / `error` 同时监听避免提前退出时挂死）。这两点是 Q4 / Q5 的验证历史，
  也是 `cli/ffmpeg.mjs` 与 `cli/frame-loop.mjs` 的直系来源。
- `src/csv.js` 验证了「二分查找 + 线性插值」的取数方式，迁移到 `data/interpolate.mjs`（输入换成 TCX
  规范化采样点）。
- `src/hud.js` 是 4 类组件的绘制原型，其中的视觉基调（深色半透明圆角底板 + 浅色描边 + 白色主数值）
  被 `shared/theme.js` 沿用。

## 为什么已被取代

| 旧实现 | 新实现 | 差异 |
| --- | --- | --- |
| `src/render.js` | `cli/ffmpeg.mjs` + `cli/frame-loop.mjs` | 参数拼装、背压、提前退出处理拆开并有独立测试 |
| `src/csv.js` + `activity.csv` | `data/tcx.mjs` + `data/interpolate.mjs` | 输入换成真实 TCX，含去重、7 s 间隔插值、10 s 平滑、缺值可用性 |
| `src/hud.js` | `shared/hud.js` + `shared/layout.js` + `shared/presets.js` | 坐标不再硬编码，由格位布局与画布预设驱动；浏览器与 Node 共用同一份绘制 |

旧实现的 `activity.csv` 是演示假数据（不是真实 Garmin 记录），坐标与布局不可配置，
也没有联合预设校验、基准图、Schema 契约与编辑器。这些能力都在新实现里，并且有对应测试。

## 注意

- 这里没有 `node_modules`（未入库）。要跑旧 Demo 需自己 `npm install`，并且它不受仓库根
  `package.json` 管理。
- 不要在这里继续开发：任何行为变更都应落在 `cli/` / `shared/` / `data/`，并补对应测试。
