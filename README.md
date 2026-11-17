# marathon-hud

把运动记录（TCX）渲染成带透明通道的 HUD 帧，再用 FFmpeg 与源视频合成成片。这是一个**离线**工具链：
渲染期不联网、不读时钟，同一份配置与素材每次都得到同一段视频。

首版只交付一条链路，没有第二条：

```
编辑器（原生 HTML + Canvas 2D，零构建）
   │  布局编辑 · 拖动 · 整数 Resize · 联合预设校验
   ▼
project.json
   │
   ▼
Node CLI（加载项目 → 解析运动数据 → 逐帧生成 RGBA）
   │
   ▼
FFmpeg（源视频 + HUD RGBA → overlay 0:0 → H.264 MP4）
   │
   ▼
成片
```

决策依据见 `docs/adr/0001`–`0006`，冻结规格见 `docs/SPEC-v1.md`，领域词汇见 `GLOSSARY.md`，
首版验收逐条结论见 `docs/ACCEPTANCE-v1.md`。

## 目录结构

```
marathon-hud/
├── project.json              # 抖音竖屏项目（源视频 1080×1920）
├── project.landscape.json    # B 站横屏项目（源视频 1920×1080）
├── activity_662602587.tcx    # 真实样本：4828 点 / 19 Lap / 18.278 km / 1:20:15
├── assets/                   # 源视频（*.mp4 被 .gitignore 忽略，需本机自备）
├── cli/                      # Node 适配层 + CLI（args / project / data / ffprobe / ffmpeg / frame-loop）
├── shared/                   # 两端共用的绘制与布局（零 DOM、零 Node API）
│   ├── hud.js  layout.js  presets.js  theme.js  weather.js  validate.js
│   └── fonts/                # Inter 4.1 四个字重 + FONTS.json（SHA-256）
├── data/                     # TCX 解析、插值、可用性判定、天气取数
├── editor/                   # 浏览器编辑器 + 本地静态服务
├── tests/                    # node --test 用例、基准图与验收脚本
├── docs/                     # ADR、规格、验收、Schema、决策总览
└── archive/marathon-hud-demo # 迁移前的参考实现（只读，见 archive/README.md）
```

## 环境要求

- Node.js 22（内置 `node --test`，无测试框架依赖）
- FFmpeg 4.4+，`ffmpeg` 与 `ffprobe` 都在 `PATH` 上
- 可选：本机 Chrome（基准图的浏览器侧比对；没有则跳过浏览器侧）

```bash
npm install     # 只装一个运行时依赖 @napi-rs/canvas
```

## 准备素材

源视频与 TCX 是两个独立输入：

- **TCX**：仓库自带 `activity_662602587.tcx`（真实样本）。
- **源视频**：`assets/run-portrait.mp4`（1080×1920、30 fps、12 s）与 `assets/run-landscape.mp4`
  （1920×1080、30 fps、12 s）。`*.mp4` 被 `.gitignore` 忽略，需要本机自备。

**为什么有两个 project 文件**：工具不做 scale / crop / pad（ADR 0003），源视频画幅必须与目标画布一致。
竖屏素材配 `project.json`（`targetPresets` 同时列出两个预设，用同一份布局跑联合校验），
横屏素材配 `project.landscape.json`（布局按横屏安全区摆放）。两份配置引用同一条 TCX 与同一份天气快照
（快照由 `npm run weather -- --project project.json` 真实取数后写入；同一活动、同一坐标，取数结果相同）。

## 用法

### 1. 编辑器

```bash
npm run editor          # 默认 http://127.0.0.1:8000/
```

打开页面后在「项目」输入框里填 `project.json` 或 `project.landscape.json` → 载入 → 拖动 / Resize /
切换显隐 → 保存。保存前会用与 CLI 完全相同的 Schema 与联合校验（全部 `targetPresets`）检查，
越界或非法字段会被拒绝并列出预设、组件与越界量，磁盘文件保持不变。

```bash
node editor/serve.mjs --port 8080 --host 127.0.0.1
```

### 2. 只校验配置与数据源

```bash
node cli/render.mjs --project project.json --validate-only
```

打印每个目标预设的画布尺寸、安全边距、格边长、网格规模、可放置格位，联合校验结论，
以及 TCX 的采样点 / Lap / 距离 / 时长 / 可用指标。不读视频、不启动 FFmpeg。

### 3. 试跑（不出片）

```bash
node cli/render.mjs --project project.json --preset douyin-portrait --dry-run
```

跑到导出前全量校验（Schema → 联合校验 → 字体与资源 → ffprobe 尺寸比对 → HUD 帧尺寸），
再真实跑完整帧循环，只把 RGBA 写进计数 sink。报告里可直接核对
`写入字节数 = 宽 × 高 × 4 × 帧数`。

### 4. 出片

```bash
node cli/render.mjs --project project.json --preset douyin-portrait --out out/portrait.mp4
node cli/render.mjs --project project.landscape.json --preset bilibili-landscape --out out/landscape.mp4
```

`--out` 覆盖 `output.path`（相对当前目录）；不写时用 `project.json` 里的 `output.path`（相对配置文件目录）。
输出目录不会自动创建：写不进去就是 FFmpeg 报错、CLI 退出码 3。

### 5. 核对某一帧的运动数据

```bash
node cli/render.mjs --project project.json --at-frame 90
```

打印第 90 帧对应的时间、插值后的配速 / 心率 / 步频 / 距离与可用性。帧号是唯一时钟
（`t = n / fps + alignmentOffsetMs`），与实际渲染耗时无关。

### 6. 天气快照（可选，唯一的联网点）

```bash
npm run weather -- --project project.json
```

按「活动开始时刻 + 首个有效 GPS」取一次 Open-Meteo 历史归档的小时值，冻结成 `weatherSnapshot`
写回 `project.json`。渲染期只读这份快照，不联网；手填快照同样能出片。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 配置 / 校验失败（含参数用法错误） |
| 3 | FFmpeg 失败（启动失败、非零退出、提前退出） |
| 4 | 数据源缺失（TCX 或源视频缺失 / 不可解析） |

## 测试与验收

```bash
npm test                     # node --test：单元 + 进程边界 + 端到端出片
npm run accept:video         # 两预设成片验收（缺成片会先出片）
npm run accept:video -- --check   # 只验收，不出片
npm run accept:golden        # 两预设 × Node / 浏览器 两端基准图比对
npm run golden:generate      # 重新生成基准图（改了绘制或字体版本后才需要）
npm run golden:browser       # 只跑浏览器侧基准图比对
```

- `npm test` 包含：共享绘制纯函数、布局与联合校验、TCX 解析与插值、CLI 退出码与报告文本、
  FFmpeg 参数与背压、`--dry-run` 字节数等式、2 s 端到端出片与 HUD 位置逐像素比对、
  两个预设的 Node 侧基准图比对。
- `npm run accept:video` 用 ffprobe 断言宽高 / `r_frame_rate=30/1` / `nb_frames=360` / `duration≈12`、
  `ffmpeg -v error -f null -` 可完整解码，并抽帧比对「源视频同刻帧 vs 成片帧」确认 HUD 只出现在
  组件矩形内。
- `npm run accept:golden` 的判据与阈值取 `tests/golden-compare.mjs`（ADR 0001 修订 1）：
  非文字区域全图 ≤1%、关键区域 ≤0.2%；文字区域判几何三项（≤1 px）、剖面相关 ≥0.98、L1 ≤0.05、
  墨量差 ≤20%、12× 粗降采样 ≤6%。**不要为了变绿调阈值**；升级 `@napi-rs/canvas`、Skia、Chrome
  或字体版本后必须重跑标定并审查基准图。
- 基准图的浏览器侧需要本机 Chrome；找不到时跳过（可用 `CHROME_PATH` 指定），Node 侧照常比对。

## 明确不做（首版）

以下能力**不在首版范围**，也不打算用「临时脚本」偷偷补上（ADR 0006）：

- 断点续跑（中断后只能重跑）
- PTS 精确校验
- 编码器吞吐量对比（libx264 / VideoToolbox 等）
- GPU 加速
- AI 跑者追踪
- 自动裁剪构图
- 实时视频预览
- 任何 scale / crop / pad：源视频画幅必须与画布预设一致，不一致就拒绝导出
- FIT / GPX 输入（首版只有 TCX）
- 自定义预设编辑 UI（只有两个内置画布预设）
- 多项目管理（一份 `project.json` 一个项目；画幅不同就复制一份配置）
- 组件自由拖拽与像素级微调（只有整数格位 + 四角锚点）

时间轴同步仍是硬性要求：固定 FPS、视频与 HUD 同一输出时间轴、帧数与时长对齐、
`alignmentOffsetMs` 生效、渲染耗时不影响运动数据时间。

## 归档

`archive/marathon-hud-demo/` 是迁移前的参考实现，已被 `cli/` + `shared/` + `data/` 取代，
只保留作历史参考（管道拓扑与背压的验证过程），不参与构建与测试。原因见 `archive/README.md`。
