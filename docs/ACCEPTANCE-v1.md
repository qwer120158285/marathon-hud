# 首版验收 v1

对应 `docs/adr/0006-v1-scope-freeze.md` 的 8 条首版验收标准，以及 `docs/SPEC-v1.md` 第 7 节的检查方式。
每一条都给出**怎么验证**（可直接复制的命令）与**实测结果**，全部为 2026-11-17 在本机
（macOS Intel / Node 22.22.2 / FFmpeg 4.4.1 / `@napi-rs/canvas` 0.1.100 / Chrome 150）的真实输出。

判据与阈值没有为通过而放宽：基准图口径仍是 ADR 0001 修订 1 的原始阈值。

## 结论

| # | 验收项 | 结果 |
| --- | --- | --- |
| 1 | 编辑器可以加载并修改 `project.json` | 通过 |
| 2 | 网格布局、组件拖动、缩放（整数 Resize）与联合预设校验 | 通过 |
| 3 | 浏览器与 Node 使用共享绘制模块 | 通过 |
| 4 | CLI 逐帧生成完整 RGBA 流 | 通过 |
| 5 | FFmpeg 能将 HUD 与原视频合成 | 通过 |
| 6 | 输出 1080p 竖屏与 1080p 横屏 MP4 | 通过 |
| 7 | Golden Image 两个预设均通过 | 通过 |
| 8 | 至少一段真实视频的端到端渲染验证 | 通过（两段） |

---

## 1. 编辑器可以加载并修改 project.json

**怎么验证**

```bash
npm run editor        # http://127.0.0.1:8000/ → 项目填 project.json → 载入 → 拖动 → 保存
node --test tests/editor-server.test.mjs tests/editor-browser.test.mjs
```

**实测结果**

- 编辑器的 `GET /api/project?path=project.json` 读取仓库根配置；`PUT` 落盘前用与 CLI 相同的
  Schema 契约校验，`PUT 合法配置落盘，并且能被 CLI 的 Schema 校验通过`（通过）。
- 浏览器侧（Chrome headless）：`编辑器页面载入示例配置：无 console 报错、预览有像素、预设与组件正确渲染`（通过）、
  `载入示例配置、切换组件显隐后保存，落盘 JSON 通过 Schema 校验`（通过）。
- 非法配置返回 422、错误文本回传、磁盘文件不被覆盖（两个用例通过）。
- `tests/editor-server.test.mjs` 8 个用例、`tests/editor-browser.test.mjs` 4 个用例，全部通过。

## 2. 网格布局、拖动、整数 Resize 与联合预设校验

**怎么验证**

```bash
node --test tests/editor-layout.test.mjs tests/joint-validation.test.mjs tests/layout.test.mjs
node cli/render.mjs --project project.json --validate-only
```

**实测结果**

- `拖动 37 × −18 px 后吸附到整数格位，并推导出最近的左下锚点`：通过。
- `东侧 Resize 87 px 吸附为跨 8 格，且仍贴在安全区底边`：通过（Resize 只按整数格）。
- `向下拖出安全区时拒绝提交，组件保持原位并报出下边越界 200 px（5 格）`：通过。
- `竖屏合法、横屏越界时拒绝保存，错误点名预设、组件与越界量`：通过。
- `全部目标预设通过时允许保存，层叠只作为提示返回`：通过（重叠只提示、不阻断）。
- `--validate-only` 实测：`project.json` 的两个目标预设都通过联合校验 ——
  抖音竖屏 27 列 × 48 行、可放置列 2–24 / 行 4–41；B 站横屏 48 列 × 27 行、可放置列 2–45 / 行 2–23；
  `联合校验通过：douyin-portrait、bilibili-landscape（4 个组件）`。

## 3. 浏览器与 Node 使用共享绘制模块

**怎么验证**

```bash
node --test tests/shared-boundary.test.mjs tests/fonts.test.mjs
```

**实测结果**

- `shared/ 源码不引用 window、document、process、require() 或 node: 专有模块`：通过。
- `shared/ 源码只使用随项目打包的 Inter，不出现系统字体名`：通过。
- `绘制代码的字体族只来自 FONT_FAMILY（= FONTS.json 的 Inter）`：通过。
- `FONTS.json` 登记 Inter 4.1 / OFL 1.1，四个字重文件 SHA-256 与清单一致：通过。
- 两端各自只有薄适配层：`cli/adapter.mjs`（`@napi-rs/canvas` + 字体注册）与
  `editor/preview.js`（`FontFace` + 字体就绪等待），绘制全部在 `shared/`。

## 4. CLI 逐帧输出完整 RGBA 流

**怎么验证**

```bash
node cli/render.mjs --project project.json --preset douyin-portrait --dry-run
node cli/render.mjs --project project.landscape.json --preset bilibili-landscape --dry-run
```

**实测结果**

```
帧循环完成：360 帧
  每帧字节     1080 × 1920 × 4 = 8294400 字节
  写入 RGBA 管道 2985984000 字节（= 8294400 × 360）
```

两段素材同为 1080 × 1920 像素规模（1920×1080 的像素总数相同），字节数等式都成立：
`2985984000 = 8294400 × 360`，退出码 0。端到端用例里 FFmpeg 收到 360 帧后正常结束，
成片 `nb_frames` 也是 360，没有丢帧。

## 5. FFmpeg 将 HUD 与原视频合成

**怎么验证**

```bash
npm run accept:video          # 缺成片会先出片，再验收
node --test tests/e2e-render.test.mjs
```

**实测结果**

```
竖屏（douyin-portrait）out/portrait.mp4
  1080×1920 @ 30/1 fps，360 帧，时长 12.000 s，可完整解码
  抽帧 1 s：HUD 墨迹 166340 像素（route 306 / progress 58802 / metrics 68098 / weather 39134）
  组件矩形外（外扩 24 px 之外）：越界 HUD 像素 0，PSNR 41.20 dB ≥ 35，结构差异 0.002% ≤ 0.1%
横屏（bilibili-landscape）out/landscape.mp4
  1920×1080 @ 30/1 fps，360 帧，时长 12.000 s，可完整解码
  抽帧 1 s：HUD 墨迹 174851 像素（route 2802 / progress 62956 / metrics 69435 / weather 39657）
  组件矩形外（外扩 24 px 之外）：越界 HUD 像素 0，PSNR 39.24 dB ≥ 35，结构差异 0.011% ≤ 0.1%
```

- `ffmpeg -v error -i <成片> -f null -` 无任何输出，退出码 0（可完整解码）。
- 四类组件都在自己的组件矩形内留下墨迹；矩形外没有 HUD 像素，只有 H.264 二次编码噪声。
- `tests/e2e-render.test.mjs` 6 个用例全部通过，含音频轨保留、`--out` 覆盖、
  FFmpeg 失败退出码 3（`output.path` 与 `--out` 两条路径各一个进程级用例）。
- 「源视频构图未被改动」由 FFmpeg 参数保证：滤镜链只有 `fps` / `setpts` / `format` / `overlay=0:0`，
  没有 scale / crop / pad（`tests/ffmpeg-args.test.mjs`）。

## 6. 输出 1080p 竖屏与 1080p 横屏 MP4

**怎么验证**

```bash
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,nb_read_frames -show_entries format=duration \
  -of json out/portrait.mp4 out/landscape.mp4
```

**实测结果**

| 成片 | 宽高 | r_frame_rate | nb_frames | duration |
| --- | --- | --- | --- | --- |
| `out/portrait.mp4` | 1080 × 1920 | 30/1 | 360 | 12.000 s |
| `out/landscape.mp4` | 1920 × 1080 | 30/1 | 360 | 12.000 s |

像素格式 `yuv420p`，编码 `libx264`，帧数 = `round(12 × 30) = 360`。两段源视频都没有音轨，
`-map 0:a?` 因此不产生音轨；带音轨的素材由 `成片保留音频轨` 用例覆盖。

## 7. Golden Image 两个预设均通过

**怎么验证**

```bash
npm run accept:golden
```

**实测结果**

Node 侧（`@napi-rs/canvas`）两个预设都是 0 差异（基准图由同一实现生成，必须逐字节可复现）：

- `douyin-portrait` / `bilibili-landscape`：全图非文字 0.0000%、关键区域 0.0000%、文字区全部 0。
- `基准图可重复生成：重跑得到逐字节相同的 PNG`：通过。

浏览器侧（Chrome headless，跨光栅器）：

| 预设 | 非文字全图 | 非文字关键区域 | 文字质心 | 包围盒 | 轮廓 | 墨量差 | 剖面相关 | 剖面 L1 | 12× 粗降采样 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| douyin-portrait | 0.0008% | 0.0052% | 0.572 px | 1 px | 0 px | 11.4524% | 0.9899 | 0.0422 | 1.6026% |
| bilibili-landscape | 0.0008% | 0.0053% | 0.572 px | 1 px | 0 px | 11.4524% | 0.9899 | 0.0422 | 1.6026% |

对照 ADR 0001 修订 1 的阈值：全图 ≤1%、关键区域 ≤0.2%、几何 ≤1 px、相关 ≥0.98、L1 ≤0.05、
墨量 ≤20%、粗降采样 ≤6% —— 全部通过。`tests/golden.test.mjs` 的 4 条失败用例
（组件平移 1 px、文字平移 2 px、墨量减半、换数字）仍然会被判失败，判据没有退化。

## 8. 至少一段真实视频的端到端渲染验证

**怎么验证**

```bash
node --test tests/tcx-sample.test.mjs         # 真实 TCX 的事实基线
npm run accept:video                          # 两段真实素材的完整链路
```

**实测结果**

- 数据源是真实样本 `activity_662602587.tcx`：4828 个采样点（去重后 4810，18 个重复时间戳）、
  19 个 Lap（18 个完整公里刻度）、18.278 km、1:20:15、首点 `2026-11-15T11:44:02Z`、
  最前 36 点无 GPS、步频 ×2 记 SPM、无 GCT。
- 素材是两段真实拍摄的 12 s 视频（竖屏 1080×1920 / 横屏 1920×1080，30 fps），
  经「编辑器布局 → project.json → CLI 逐帧 RGBA → FFmpeg overlay → 成片」完整跑通，
  ffprobe 规格与 HUD 位置见第 5、6 条。
- 天气是真实取数结果（2026-11-17 实跑 `npm run weather -- --project project.json`）：
  22 °C / 89% / 0.1 mm / WMO 51（DRIZZLE），ERA5 网格 22.952547 / 115.36534。

---

## 首版收口时修掉的四处遗留

| 问题 | 处理 | 验证 |
| --- | --- | --- |
| 天气短语用系统 CJK 字体，违反「字体随项目打包」 | 短语改英文（CLEAR / DRIZZLE / RAIN …），未知码显示 `WX <code>`，删除第二套字体分支 | `tests/fonts.test.mjs` 扫描 shared/ 源码；`tests/weather.test.mjs` 断言不出现汉字、字体串一律以 `Inter` 结尾 |
| `--dry-run` 把未标注的 SAR / DAR 印成 `0:1` | 改为 `未标注（按 1:1 处理）` / `未标注（按画面宽高处理）`，行为不变 | `--dry-run 把未标注的 SAR / DAR 写成「未标注（按…处理）」，不印 0:1` |
| 缺进程级 FFmpeg 失败断言 | 补 `--out` 指向不存在目录的用例 | `--out 指向不存在的目录时退出码 3，stderr 带 FFmpeg 片段` |
| `sourceVideo.probed.durationSec` 没有消费点 | 与 ffprobe 实测差 >1 s 时在导出前校验里给一条不阻断的提示，并给出重探测命令 | `probed.durationSec 与实测差 ≤1 s 不提示，>1 s 报一条不阻断的过期提示` + 进程级用例 |
