# 架构决策记录

本文件是 Q1–Q19 设计拷问的共识落点，也是本项目 ADR 的索引。决策细节以各 ADR 为准，本表只作总览与追溯。

- **状态：共识达成，首版范围冻结**
- 日期：2026-11-16
- 结论：设计树前沿为空，Q1–Q19 全部有明确结论，可以开始实现。

## ADR 索引

| 编号 | 标题 | 状态 | 覆盖问题 |
| --- | --- | --- | --- |
| 0001 | 共享绘制模块 + 双端薄适配层 | Accepted | Q10；Q18 补齐验收标准 |
| 0002 | 格位网格与布局存储 | Accepted | Q3、Q11、Q15、Q16 |
| 0003 | 导出前校验与工具边界 | Accepted | Q9、Q12 |
| 0004 | HUD 组件清单基线 | Accepted | Q6（部分）、Q14 |
| 0005 | 单一项目配置 project.json | Accepted | Q17 |
| 0006 | 首版范围冻结 | Accepted | Q19 |

术语定义见仓库根 `GLOSSARY.md`；首版冻结规格见 `docs/SPEC-v1.md`；配置 Schema 见 `docs/schema/project.schema.json`。

## Q1–Q19 决策总览

| Q | 主题 | 结论 | 落点 |
| --- | --- | --- | --- |
| Q1 | 基线选择 | 以既有 `marathon-hud-demo` 为起点，拆成 TCX 解析器 / 布局渲染器 / 管道驱动三层；合并工作区原型的 4 类组件绘制，消除两套实现 | SPEC-v1 目录结构 |
| Q2 | 时间轴与时区 | 视频帧为主时钟；`alignmentOffsetMs` 对齐；相邻采样点线性插值、暂停保持上一有效值；`timezone` 显式配置，采样点内部用 UTC 相对时间插值，仅墙钟显示层做时区转换 | SPEC-v1 时间轴 |
| Q3 | 画布与坐标 | 画布预设 = 成片分辨率；布局用与预设无关的坐标 + 锚点。经 Q11/Q16 收敛为整数格位 + 四角锚点自动推导，不做自由拖拽与智能参考线 | ADR 0002 |
| Q4 | 管道拓扑 | 只输出透明 RGBA HUD 帧，FFmpeg `overlay` 合成；源视频与编码全部交给 FFmpeg | 既有 demo `render.js` |
| Q5 | 背压 | 零丢帧 pull：`write()` 返回 false 即等 `drain`；FFmpeg 提前退出时用 `Promise.race` 同时监听 `close`/`error`，避免渲染循环挂死 | 既有 demo `render.js` |
| Q6 | TCX 映射与缺值 | 规范化采样点；18 个重复时间戳去重、7 s 间隔照常插值；配速由 `ns3:Speed` 换算并做 10 s 滑动平滑；步频 ×2 记 SPM；进度终点 18.278 km；前 36 点无 GPS 断笔；GCT 无来源整行隐藏 | ADR 0004 / SPEC-v1 数据层 |
| Q7 | 天气数据来源 | 编辑期按「活动开始时刻 + 首个有效 GPS 坐标」取一次，冻结为天气快照（含来源 URL、取数时刻、网格坐标、WMO code）；渲染期零网络；手工覆盖优先；单快照而非逐小时序列 | ADR 0005 / SPEC-v1 |
| Q8 | 静态层 | 仍走单条 RGBA 管道；静态组件预绘到离屏位图，每帧只合成一次，不重排文字、不描路径 | ADR 0001 |
| Q9 | 画幅适配 | 使用者自行匹配源视频画幅（竖屏视频用竖屏素材）；工具只保证安全边距，绝不 scale / crop / pad | ADR 0003 |
| Q10 | 渲染后端统一 | 共享绘制模块 + 双端薄适配层；不共享运行环境、字体显式注册、Golden Image 用容差而非逐像素；最终原则「浏览器原型就是最终渲染器的可视化预览」 | ADR 0001 |
| Q11 | 网格与布局存储 | 40 px @ 短边 1080、按短边缩放、全画布 27×48 / 48×27、原点左上、安全边距独立；存锚点 + 整数格位 + `zIndex`/`visible` + `gridVersion` + 预设标识；跨格允许、整数格 Resize、无像素微调、重叠允许但区分视觉重叠与允许的层叠、网格线默认显示可关、不自动避让 | ADR 0002 |
| Q12 | 导出校验与工具边界 | 安全边距 64/160/240（抖音）、64/80/120（B 站），按短边缩放；硬约束在布局引擎层且校验完整矩形；分别比较 width/height/SAR/DAR 与旋转元数据；不匹配拒绝导出；工具不做 scale / crop / pad | ADR 0003 |
| Q13 | 历史天气 API | Open-Meteo Historical Archive（免 key、CORS `*`、CC BY 4.0）；接受 ERA5 0.25° 网格再分析值；来源 URL 与网格坐标写入快照 | ADR 0005 / SPEC-v1 |
| Q14 | 组件清单基线 | 四类组件；PACE / HR / CAD 默认开、GCT 不画不留空；功率 / 海拔 / Lap 刻度为可选子组件、默认关；`shouldRender = configEnabled && dataAvailable` | ADR 0004 |
| Q15 | 跨预设策略与联合校验 | 定案 **A**：`colSpan`/`rowSpan` 不变、格边长按短边缩放、位置按 `anchor + col + row` 映射、不因方向变化改尺寸；B 仅原型对照。任何布局变更须对全部目标预设联合校验通过才可保存，且基于同一候选布局与同一版本预设配置 | ADR 0002（Accepted，删除待确认） |
| Q16 | 网格语义 | 网格线铺满整张画布、仅作视觉辅助；可放置格位仅完整落在安全区内的整格（抖音从 `col 2` 起）；边界判断用完整矩形。「网格铺满画布，可放置区域受安全区硬约束」 | ADR 0002（并澄清 ADR 0003 措辞） |
| Q17 | project.json | 单文件配置入口；`sourcePresetId` 编辑上下文 vs `targetPresets[]` 适用预设；相对路径、探测值与使用者配置分开、`version` 与 `gridVersion` 独立 | ADR 0005 |
| Q18 | 字体与 Golden Image | Inter / OFL 1.1 / 内置 / 双端注册 / `tabular-nums` / 固定版本与 SHA-256；全图 ≤1%、关键区域 ≤0.2%、单通道 ≤8/255、Alpha 参与、分别计算；关键区域 = 组件矩形外扩 8 px + 文字实际绘制包围盒；固定数据 × 两预设；升级依赖须重审基准图、不得放宽容差 | ADR 0001 验收标准 |
| Q19 | 首版范围冻结 | 唯一链路（编辑器 → `project.json` → CLI → FFmpeg → 成片）；技术选型冻结、零构建但需本地 HTTP 服务或文件选择接口；7 项不做；时间轴同步 5 条硬要求；8 条验收 | ADR 0006 / SPEC-v1 |

## 事实基线（决策依据，不是决策）

- 真实样本 `activity_662602587.tcx`（3.6 MB，`~/Downloads` 副本与仓库副本 MD5 相同）：4828 个 Trackpoint、19 个 Lap、18.278 km、时长 1:20:15；首点 `2026-11-15T11:44:02Z`（Asia/Shanghai 19:44:02）。
- 字段：Time、DistanceMeters、HeartRateBpm、AltitudeMeters、`ns3:Speed`、`ns3:RunCadence`、`ns3:Watts`、Position（4792 个，最前 36 点缺失）；无 `Cadence`、无 `TrackpointExtension`、无 GCT / 触地时间。
- `ns3:RunCadence` 中位 92 为单脚 rpm，显示步频需 ×2 ≈ 184 spm；配速中位 3.84 m/s；心率 60–168；功率中位 337 W。功率与海拔范围只是该样本的事实，不得写成组件默认值。
- 18 个重复时间戳、1 处 7 s 间隔；插值前需去重。
- 天气实测：Open-Meteo archive + `timezone=Asia/Shanghai`，11/15 19:00 为 22.0 °C / 89% / 0.1 mm / WMO 51；ERA5 网格吸附到 22.9525 / 115.3653（距 GPS 点约 4 km），是再分析估计值而非站点实测。
- 环境：FFmpeg 4.4.1-tessus（支持 rawvideo rgba、overlay、libx264/libx265）、Node 22.22.2 x86_64、`@napi-rs/canvas` 0.1.100 预编译二进制、Chrome 150。
- 既有 `marathon-hud-demo` 的 `render.js` 已验证透明 RGBA + overlay + `drain` 背压，`csv.js` 已验证二分查找 + 线性插值；但其 `activity.csv` 是演示假数据，TCX 未接入、`hud.js` 坐标硬编码。

## 已冻结与拟定

- **已冻结**：Q1–Q19 全部决策、ADR 0001–0006 的内容、`GLOSSARY.md` 的领域语言。
- **拟定（依已确认决策推导，不推翻任何原则）**：`SPEC-v1.md` 中的目录命名、CLI 参数与退出码、JSON Schema 的具体字段细节、Golden Image 基准图生成脚本，以及把 Q14 的布尔开关合并进 `layout.components[].visible` 的实现口径。这些属于实现参数，调整时不得与 ADR 冲突。
