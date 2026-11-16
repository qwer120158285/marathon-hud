---
status: accepted
---

# 单一项目配置 project.json

一个项目只维护一份 `project.json` 作为配置入口，不再有互相独立的布局配置文件。编辑时所用预设与布局最终适配哪些预设是两个不同维度，用 `layout.sourcePresetId` 与根级 `targetPresets[]` 分开表达，避免共用一个字段造成语义冲突。

## 结构

```json
{
  "version": 1,
  "targetPresets": ["douyin-portrait", "bilibili-landscape"],
  "gridVersion": 1,
  "layout": {
    "sourcePresetId": "douyin-portrait",
    "components": []
  },
  "sourceVideo": {},
  "tcx": {},
  "timezone": "Asia/Shanghai",
  "alignmentOffsetMs": 0,
  "weatherSnapshot": {},
  "fonts": [],
  "output": {}
}
```

## 字段职责

| 字段 | 职责 |
| --- | --- |
| `version` | 项目配置文件版本，用于迁移 |
| `targetPresets[]` | 当前布局必须通过校验的目标预设 |
| `gridVersion` | 网格计算规则版本 |
| `layout.sourcePresetId` | 当前编辑布局时使用的预设 |
| `layout.components[]` | 组件位置、尺寸、锚点、层级和可见性 |
| `sourceVideo` | 原始视频路径及媒体信息 |
| `tcx` | 运动数据文件路径及解析信息 |
| `timezone` | 活动时间解释所使用的时区 |
| `alignmentOffsetMs` | 视频与运动数据的时间对齐偏移 |
| `weatherSnapshot` | 天气数据快照，避免重复查询导致结果变化 |
| `fonts` | 字体资源及注册配置 |
| `output` | 输出分辨率、帧率、编码等配置 |

## 两个预设字段的边界

以 `targetPresets: ["douyin-portrait", "bilibili-landscape"]` 且 `layout.sourcePresetId: "douyin-portrait"` 为例：

- 使用者当前在抖音竖屏画布中编辑；
- 当前布局必须同时兼容抖音竖屏和 B 站横屏；
- 切换到 B 站时，根据锚点重新映射位置；
- 不改变组件的 `colSpan` 与 `rowSpan`；
- 修改布局后，必须对两个目标预设联合校验。

**`sourcePresetId` 只是编辑上下文，不是布局归属**，它不应影响布局在其他预设中的解释结果。联合校验以 `targetPresets[]` 为准（ADR 0002）。

## 工程约束

1. **路径统一使用项目相对路径。** 视频、TCX、字体资源尽量相对于 `project.json` 所在目录引用，方便整个项目迁移。
2. **媒体元数据与使用者配置分开。** `sourceVideo` 可保存路径、宽高、SAR、时长等探测结果，但应区分自动探测值与使用者修改值。
3. **配置版本与网格版本独立。** `version` 负责 JSON 结构迁移，`gridVersion` 负责格位计算规则迁移，不能混为一谈。

## 决策

- 一个项目一个 `project.json`。
- 不再维护互相独立的布局配置文件。
- `sourcePresetId` 放在 `layout` 内。
- `targetPresets[]` 放在项目根级。
- 不存单一布局归属预设。
- 联合校验以 `targetPresets[]` 为准。

这为项目导入、导出、迁移与跨预设布局复用提供了统一的数据入口。

## 备选方案

每个画布预设各存一份独立布局文件。不选原因：同一组件改动要改两遍，且无法表达「一份布局同时适配多个预设」；联合校验也无法针对同一份候选布局执行。
