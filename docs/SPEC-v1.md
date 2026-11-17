# 首版冻结规格 v1

> 依据：ADR 0001–0006、`DECISIONS.md`（Q1–Q19 共识）、`GLOSSARY.md`。
> 状态：首版范围已冻结（ADR 0006）。
> **拟定说明**：本文的目录命名、CLI 参数与退出码、JSON Schema 字段细节是依已确认决策推导的实现规格，不改变任何已决原则；如与 ADR 冲突，以 ADR 为准。

## 1. 唯一交付链路

```
editor/（原生 HTML + Canvas 2D，零构建）
   │  布局编辑 · 联合校验 · 预览
   ▼
project.json
   │
   ▼
cli/（Node.js + @napi-rs/canvas，共享 shared/ 绘制模块）
   │  逐帧生成透明 RGBA
   ▼
FFmpeg（源视频 + HUD RGBA → overlay → H.264 MP4）
   │
   ▼
成片
```

## 2. 目录结构（拟定）

```
marathon-hud/
├── project.json                  # 唯一配置入口（ADR 0005）；抖音竖屏实例
├── project.landscape.json        # B 站横屏实例（源视频画幅不同，工具不做 scale/crop）
├── README.md                     # 使用方式 + 「明确不做」清单
├── GLOSSARY.md
├── docs/
│   ├── DECISIONS.md              # 决策总览 + ADR 索引
│   ├── SPEC-v1.md                # 本文件
│   ├── ACCEPTANCE-v1.md          # 首版 8 条验收的逐条命令与实测结果
│   ├── adr/0001…0006
│   ├── schema/project.schema.json
│   └── agents/                   # 既有协作说明，保留
├── editor/                       # 浏览器适配层 + 布局编辑
│   ├── index.html
│   ├── editor.css
│   ├── editor.js                 # 拖拽 / 整数 Resize / 联合校验 / 配置读写
│   ├── preview.js                # 创建 Canvas、注册字体、等待字体就绪
│   └── serve.mjs                 # 本地静态服务，规避 file:// 限制
├── shared/                       # ADR 0001 唯一绘制实现；零 DOM / 零 Node API
│   ├── hud.js                    # 四类组件绘制
│   ├── layout.js                 # 格位↔像素、四角锚点、安全区、联合校验
│   ├── theme.js                  # 颜色 / 字号 / 圆角常量
│   └── fonts/
│       ├── Inter-*.ttf           # 随项目打包
│       └── FONTS.json            # 字体版本 + SHA-256 清单
├── cli/                          # Node 适配层 + 管道驱动
│   ├── render.mjs                # CLI 入口
│   ├── adapter.mjs               # @napi-rs/canvas + 字体注册
│   └── ffmpeg.mjs                # 参数拼装、stdin 背压、提前退出处理
├── data/
│   ├── tcx.mjs                   # TCX → 规范化采样点
│   └── interpolate.mjs           # 去重、线性插值、10 s 平滑、GPS 断笔
├── assets/                       # 源视频等素材（project.json 相对引用；*.mp4 不入库）
├── tests/
│   ├── fixtures/sample.json      # 固定示意数据（四类组件齐全）
│   ├── golden/<preset>.png       # 两个预设各一张基准图
│   ├── golden-compare.mjs        # 全图 + 关键区域 + 文字区差异比对
│   ├── accept-golden.mjs         # 两预设 × 两端基准图全量比对（npm run accept:golden）
│   └── acceptance-video.mjs      # 两段成片规格与 HUD 位置验收（npm run accept:video）
└── archive/marathon-hud-demo/    # 既有验证实现，逻辑迁移后归档保留（见 archive/README.md）
```

与既有 demo 的迁移对应：`src/render.js`（ffmpeg 参数与背压）→ `cli/ffmpeg.mjs`；`src/csv.js`（二分 + 插值）→ `data/interpolate.mjs`，输入换成 TCX 规范化采样点；`src/hud.js`（绘制）→ `shared/hud.js`，去掉硬编码坐标、改由格位布局驱动；`activity.csv` 假数据停用。

## 3. project.json

机器可读校验见 `docs/schema/project.schema.json`（JSON Schema 2020-12）。字段职责见 ADR 0005。

### 3.1 组件开关的合并口径（拟定，解决两处规格的缝隙）

Q11 的 `layout.components[]` 与 Q14 的 `HudConfig.components` 布尔开关不保留两份：

- 顶层四类组件的启用状态由 `visible` 承担，即 `configEnabled`；
- 可选子组件（功率、海拔、Lap 刻度）放在所属父组件的 `subcomponents` 上（`power`/`elevation` 属 `metrics`，`lapMarkers` 属 `progress`）；
- 最终判据仍是 `shouldRender = configEnabled && dataAvailable`（ADR 0004），数据可用性由解析器在运行时给出，不写进配置。

`components[]` 中同一 `id` 只能出现一次；这是联合校验的附加项。

### 3.2 示例（示意值用于说明字段形状）

```json
{
  "version": 1,
  "targetPresets": ["douyin-portrait", "bilibili-landscape"],
  "gridVersion": 1,
  "layout": {
    "sourcePresetId": "douyin-portrait",
    "components": [
      { "id": "progress", "anchor": "top-left", "col": 2, "row": 2, "colSpan": 20, "rowSpan": 2, "zIndex": 2, "visible": true, "subcomponents": { "lapMarkers": false } },
      { "id": "route", "anchor": "top-left", "col": 2, "row": 5, "colSpan": 6, "rowSpan": 6, "zIndex": 1, "visible": true },
      { "id": "metrics", "anchor": "bottom-left", "col": 2, "row": 30, "colSpan": 6, "rowSpan": 8, "zIndex": 3, "visible": true, "subcomponents": { "power": false, "elevation": false } },
      { "id": "weather", "anchor": "bottom-right", "col": 17, "row": 34, "colSpan": 7, "rowSpan": 5, "zIndex": 2, "visible": true }
    ]
  },
  "sourceVideo": {
    "path": "./assets/run.mp4",
    "probed": { "width": 1080, "height": 1920, "sar": "1:1", "dar": "9:16", "rotation": 0, "durationSec": 80.0 },
    "overrides": {}
  },
  "tcx": { "path": "./activity_662602587.tcx", "distanceMeters": 18278, "trackpoints": 4828, "laps": 19 },
  "timezone": "Asia/Shanghai",
  "alignmentOffsetMs": 0,
  "weatherSnapshot": {
    "source": "open-meteo-historical-archive",
    "requestUrl": "https://archive-api.open-meteo.com/v1/archive?latitude=22.99092&longitude=115.32902&start_date=2026-11-15&end_date=2026-11-15&hourly=temperature_2m,relative_humidity_2m,precipitation,weather_code&timezone=Asia%2FShanghai",
    "query": { "latitude": 22.99092, "longitude": 115.32902, "timeLocal": "2026-11-15T19:00" },
    "grid": { "latitude": 22.9525, "longitude": 115.3653 },
    "fetchedAt": "<取数时刻 ISO 8601>",
    "values": { "temperatureC": 22.0, "humidityPct": 89, "precipitationMm": 0.1, "weatherCode": 51 }
  },
  "fonts": [
    { "name": "Inter", "path": "./shared/fonts/Inter-Regular.ttf", "version": "<字体版本>", "sha256": "< vendoring 时填入 >" }
  ],
  "output": { "path": "./out/final.mp4", "fps": 30, "codec": "libx264", "pixFmt": "yuv420p" }
}
```

尖括号字段为实施时填入；`sourceVideo.probed` 与 `output.fps` 为示意值（`fps` 拟定默认 30，按源视频覆盖）。天气数值来自实测快照，媒体信息以 ffprobe 实际结果为准。所有路径相对 `project.json` 所在目录。

实施口径补充（2026-11-17 落地时确定，不改变任何已冻结原则）：

- 仓库里有两个可直接使用的实例：`project.json`（抖音竖屏，源视频 `assets/run-portrait.mp4`）与
  `project.landscape.json`（B 站横屏，源视频 `assets/run-landscape.mp4`）。两者引用同一条 TCX 与同一份
  天气快照；之所以是两个文件，是因为工具不做 scale / crop（ADR 0003），源视频画幅必须与画布一致。
- `sourceVideo.probed` 只是**探测记录**，不参与规格校验；出片依据是 ffprobe 实测时长。
  记录值与实测时长相差超过 1 s 时，导出前校验给一条**不阻断**的提示，并给出重跑探测的命令。
- HUD 上的天气短语用英文（`CLEAR` / `DRIZZLE` / `RAIN` / `THUNDER` …），未知 WMO 码显示 `WX <code>`。
  理由：Inter 没有汉字字形，中文会落到本机系统字体，换机器时字宽变化、基准图不可复现（ADR 0001「字体」）。

## 4. CLI 接口（拟定）

```
node cli/render.mjs --project <path/to/project.json> [options]
```

| 参数 | 说明 |
| --- | --- |
| `--project <path>` | 必填，`project.json` 路径 |
| `--preset <id>` | 本次出片预设，必须在 `targetPresets[]` 内；存在多个目标预设且不指定时报错 |
| `--at-frame <n>` | 打印第 n 帧（0 起）对应的运动时刻与该帧运动指标，用于核对数据源；不需要 `--preset` |
| `--validate-only` | 只做联合预设校验并打印报告（含数据源解析统计），不加载媒体、不启动 FFmpeg |
| `--dry-run` | 执行到导出前全量校验为止（含 ffprobe 尺寸比对），再真实跑完整帧循环、统计写入字节数；不启动 FFmpeg |
| `--out <path>` | 覆盖 `output.path` |

退出码：`0` 成功；`2` 配置或校验失败；`3` FFmpeg 失败；`4` 数据源缺失（`tcx.path` 未配置、文件不存在或不可解析）。

导出前校验顺序（ADR 0003 + Q15）：

1. 按 Schema 校验 `project.json`，检查 `version` 与 `gridVersion`；`components[]` 的 `id` 不重复。
2. **联合校验**：对 `targetPresets[]` 全部预设，用同一份候选布局与同一版本预设配置，检查格位有效、尺寸有效、锚点映射有效、组件完整矩形未越过安全区；重叠只作提示。
3. 资源检查：字体文件存在、SHA-256 匹配、两端注册完成。
4. `ffprobe` 读取 width / height / SAR / DAR / 旋转元数据，与画布预设比对，不一致拒绝并报告实际值 / 期望值。
   SAR / DAR 为「未标注」（ffprobe 的 `0:1`）时按 1:1 / 画面宽高处理，报告里写明这一点。
5. `sourceVideo.probed.durationSec` 与实测时长相差 >1 s 时给一条不阻断的提示（记录值过期），
   并给出重跑探测的命令；出片始终以实测时长为准。
6. 确认 HUD 帧尺寸等于画布预设。
7. 启动 FFmpeg，进入帧循环。

## 5. 帧循环、时间轴与背压

```
total = round(durationSec * fps)
for n in 0..total-1:
    t = n / fps + alignmentOffsetMs / 1000      # 帧号决定运动时刻，与墙钟耗时无关
    sample = interpolate(samples, t)             # 去重后线性插值；暂停保持上一有效值
    drawFrame(ctx, layout, sample, staticLayer)  # 静态层只做一次合成，不重排文字
    buf = ctx.toBuffer('raw')                    # RGBA
    if !ff.stdin.write(buf):
        await Promise.race([once(ff.stdin, 'drain'), ffmpegExitPromise])
ff.stdin.end(); await ffmpegExitPromise
```

- `ffmpegExitPromise` 同时监听 `close` / `error`，避免 FFmpeg 提前退出时 `drain` 永不 resolve 导致渲染循环挂死。
- 帧号 `n` 是唯一时钟；Node 渲染快慢不改变运动数据时间。固定 FPS，输出侧用恒定帧率，保证帧数与时长对齐。
- 进程内只持有 1–2 帧，零丢帧、内存有界（Q5）。

## 6. Golden Image 执行约定

```
node tests/golden-compare.mjs --preset douyin-portrait
node tests/golden-compare.mjs --preset bilibili-landscape
```

一次跑完「两个预设 × 两端」的汇总命令是 `npm run accept:golden`（Node 侧渲染 + Chrome headless 截图，
都与同一张基准图比对；无 Chrome 时用 `--node-only` 只跑 Node 侧）。

固定 `tests/fixtures/sample.json`、同一份布局、同一套字体、DPR = 1、固定 Canvas 尺寸与颜色空间、透明背景；浏览器与 Node 各输出 PNG，与 `tests/golden/<preset>.png` 比较全图与关键区域两个差异比例。阈值与计算口径见 ADR 0001（含 2026-11-17 的修订 1：非文字区域沿用 8/255 与 ≤1% / ≤0.2%，文字区域改判为几何三项 + 剖面内容 + 墨量带 + 12× 归一化降采样兜底）；升级 `@napi-rs/canvas` / Skia / 字体版本后须重审基准图并重跑标定。

## 7. 首版验收清单

对应 ADR 0006 的 8 条，实施时逐条打勾；任一条未通过不算首版完成。逐条的命令与实测结果见
`docs/ACCEPTANCE-v1.md`（2026-11-17 全部通过）。

| # | 验收项 | 检查方式 |
| --- | --- | --- |
| 1 | 编辑器加载并修改 `project.json` | 载入示例配置 → 拖动组件 → 保存后 JSON 可被 Schema 校验 |
| 2 | 网格布局 + 拖动 + Resize + 联合校验 | 故意在横屏制造越界，确认保存被拒绝并列出具体错误 |
| 3 | 浏览器与 Node 使用共享绘制模块 | `shared/` 内无 `window` / `document` / Node 专有 API 引用 |
| 4 | CLI 逐帧输出完整 RGBA 流 | `--dry-run` 通过后统计写入字节数 = W×H×4×帧数 |
| 5 | FFmpeg 合成 | 输出 MP4 可解码、HUD 出现在正确位置 |
| 6 | 竖屏 / 横屏两种成片 | 各跑一次，分辨率分别为 1080×1920 / 1920×1080 |
| 7 | Golden Image 两个预设通过 | 见第 6 节，全图 ≤1%、关键区域 ≤0.2% |
| 8 | 真实视频端到端验证 | 用一段真实素材完整跑通链路 |

## 8. 明确不做

断点续跑、PTS 精确校验、编码器吞吐对比、GPU 加速、AI 跑者追踪、自动裁剪构图、实时视频预览，以及任何 scale / crop / pad。这些列入 README 待办，但时间轴同步（固定 FPS、`alignmentOffsetMs`、帧数与时长对齐）仍是硬性要求，见第 5 节。
