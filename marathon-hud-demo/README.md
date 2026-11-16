# Marathon HUD Demo (Mac Intel)

一个最小可运行的离线运动视频 HUD 合成 Demo：Node.js + `@napi-rs/canvas` + FFmpeg。

## 1. 环境要求

- macOS Intel
- Node.js 20 或更高版本
- FFmpeg（需要同时有 `ffmpeg` 和 `ffprobe`）

安装 FFmpeg（已安装可跳过）：

```bash
brew install ffmpeg
```

检查：

```bash
node -v
ffmpeg -version
ffprobe -version
```

## 2. 安装依赖

```bash
cd marathon-hud-demo
npm install
```

## 3. 准备输入文件

把原始视频放到项目目录，命名为 `input.mp4`。运动数据使用 `activity.csv`。

CSV 必需列：

```csv
time_ms,distance_km,pace_sec_km,heart_rate
0,0.00,360,105
1000,0.003,355,110
2000,0.006,350,112
```

- `time_ms`：相对运动开始的毫秒数，必须递增（程序会排序）。
- `distance_km`：累计距离，公里。
- `pace_sec_km`：配速，秒/公里，例如 5 分 30 秒填写 `330`。
- `heart_rate`：心率，bpm。
- 可选列：`cadence`、`elevation_m`、`lat`、`lon`。

仓库附带的 `activity.csv` 只是演示数据，不是真实 Garmin 记录。真实制作时请替换它。

## 4. 运行

```bash
npm run render -- --input input.mp4 --csv activity.csv --output output.mp4
```

可选参数：

```bash
npm run render -- \
  --input input.mp4 \
  --csv activity.csv \
  --output output.mp4 \
  --fps 30 \
  --offset-ms 0 \
  --encoder libx264 \
  --preset medium \
  --crf 19
```

`--offset-ms` 用于对齐视频与运动数据。例如运动数据相对视频画面晚 12 秒开始显示，传入 `--offset-ms 12000`。如果需要提前 2 秒，传入 `--offset-ms -2000`。

Intel Mac 首次建议使用 `libx264`。完成基准测试后，再尝试 macOS VideoToolbox：

```bash
--encoder h264_videotoolbox
```

当前脚本对 VideoToolbox 使用固定 12 Mbps 码率；若希望精细控制画质，优先使用 `libx264 -crf`。

## 5. 输出组件

- 左上：当前配速、心率
- 右下：累计距离、视频经过时间
- HUD 使用透明背景，合成时不会覆盖原视频画面

## 6. 时间同步说明

每帧时间由 `frameIndex / fps` 计算，不依赖墙上时钟或实时渲染速度。运动数据通过 `--offset-ms` 映射到视频时间轴，并对相邻 CSV 记录进行线性插值。

注意：这里的 `time_ms` 必须代表相对运动开始时间。第一版没有自动识别视频中跑者起跑时刻，也没有自动解析 Garmin FIT。

## 7. 性能与限制

1920×1080 RGBA 每帧约 8.29 MB，30 FPS 理论数据流约 249 MB/s。脚本使用 Node Stream 背压，避免无限缓存，但全画幅像素传输仍然是本 Demo 的主要性能成本。

第一版优先验证正确性和端到端链路。后续性能优化建议按顺序进行：

1. HUD 改成透明小画布，仅传输实际覆盖区域，并在 FFmpeg 中定位叠加。
2. 静态背景、边框、图标预渲染缓存。
3. 运动数据提前生成定频采样索引，减少逐帧查找开销。
4. 对比 `libx264` 与 `h264_videotoolbox` 的实际吞吐量。
5. 增加任务中断恢复、音视频 PTS 检查和 FIT 原生解析。

## 8. 验证输出

```bash
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,duration -of table output.mp4
```

建议先用 1～3 分钟视频验证透明效果、时间偏移和音频同步，再测试完整长视频。
