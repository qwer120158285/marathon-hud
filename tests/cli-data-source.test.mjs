/**
 * CLI 数据源边界：`--validate-only` 报告数据源统计、`--at-frame` 在任意帧号给出运动指标、
 * 数据源缺失或不可解析时退出码 4（SPEC-v1 第 4 节退出码表）。
 *
 * 小 TCX 里的数值都是手写的：0/1/2 s 三个点，距离 0/4/8 m，心率 140/140/160，速度 4 m/s（配速 4'10"/km）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli, readValidProject, writeTempProject, VALID_PROJECT_PATH } from './helpers/cli.mjs';

const MINI_TCX = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase
  xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>2026-01-01T08:00:00.000Z</Id>
      <Lap StartTime="2026-01-01T08:00:00.000Z">
        <TotalTimeSeconds>2</TotalTimeSeconds>
        <DistanceMeters>8</DistanceMeters>
        <Track>
          <Trackpoint>
            <Time>2026-01-01T08:00:00.000Z</Time>
            <Position><LatitudeDegrees>22.5</LatitudeDegrees><LongitudeDegrees>115.5</LongitudeDegrees></Position>
            <AltitudeMeters>20</AltitudeMeters>
            <DistanceMeters>0</DistanceMeters>
            <HeartRateBpm><Value>140</Value></HeartRateBpm>
            <Extensions><ns3:TPX><ns3:Speed>4</ns3:Speed><ns3:RunCadence>90</ns3:RunCadence></ns3:TPX></Extensions>
          </Trackpoint>
          <Trackpoint>
            <Time>2026-01-01T08:00:01.000Z</Time>
            <Position><LatitudeDegrees>22.5001</LatitudeDegrees><LongitudeDegrees>115.5001</LongitudeDegrees></Position>
            <AltitudeMeters>21</AltitudeMeters>
            <DistanceMeters>4</DistanceMeters>
            <HeartRateBpm><Value>140</Value></HeartRateBpm>
            <Extensions><ns3:TPX><ns3:Speed>4</ns3:Speed><ns3:RunCadence>90</ns3:RunCadence></ns3:TPX></Extensions>
          </Trackpoint>
          <Trackpoint>
            <Time>2026-01-01T08:00:02.000Z</Time>
            <Position><LatitudeDegrees>22.5002</LatitudeDegrees><LongitudeDegrees>115.5002</LongitudeDegrees></Position>
            <AltitudeMeters>22</AltitudeMeters>
            <DistanceMeters>8</DistanceMeters>
            <HeartRateBpm><Value>160</Value></HeartRateBpm>
            <Extensions><ns3:TPX><ns3:Speed>4</ns3:Speed><ns3:RunCadence>90</ns3:RunCadence></ns3:TPX></Extensions>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

/** 合法配置 + 一份小 TCX 数据源；`mutate` 用来改坏数据源配置。 */
function projectWithMiniData(mutate = () => {}, tcx = MINI_TCX) {
  const project = readValidProject();
  project.tcx = { path: './mini.tcx' };
  project.output = { path: './out/final.mp4', fps: 10, codec: 'libx264', pixFmt: 'yuv420p' };
  project.alignmentOffsetMs = 0;
  mutate(project);
  return writeTempProject(project, { 'mini.tcx': tcx });
}

// 验收项 1：真实样本经 --validate-only 报告解析结果，退出码 0。
test('--validate-only 报告真实样本的采样点、Lap、距离、时长与重复时间戳', () => {
  const { code, stdout } = runCli(['--project', VALID_PROJECT_PATH, '--validate-only']);

  assert.equal(code, 0);
  assert.match(stdout, /数据源/);
  assert.match(stdout, /采样点\s+4828（去重后 4810，重复时间戳 18）/);
  assert.match(stdout, /Lap\s+19/);
  assert.match(stdout, /18278/);
  assert.match(stdout, /时长\s+1:20:15/);
  assert.match(stdout, /不可用指标\s+触地时间/);
});

// 验收项 8：数据源文件缺失 → 退出码 4，说明路径与原因。
test('数据源文件不存在时退出码 4 并说明原因', () => {
  const file = projectWithMiniData((project) => {
    project.tcx = { path: './missing.tcx' };
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 4);
  assert.match(stderr, /无法读取数据源：.*missing\.tcx（文件不存在）/);
});

// 验收项 8：数据源不可解析 → 退出码 4，而不是当成配置错误或静默通过。
test('数据源内容不可解析时退出码 4 并说明原因', () => {
  const file = projectWithMiniData(() => {}, '<html><body>不是 TCX</body></html>');

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 4);
  assert.match(stderr, /无法解析数据源：.*mini\.tcx（TCX 里没有找到 Activity 节点/);
});

// 项目没配置数据源也算数据源缺失。
test('未配置 tcx.path 时退出码 4', () => {
  const file = projectWithMiniData((project) => {
    delete project.tcx;
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 4);
  assert.match(stderr, /未配置 tcx\.path/);
});

// 验收项 7：第 n 帧的运动时刻与指标来自数据源，帧号由 fps 换算。
test('--at-frame 按 fps 换算出运动时刻并给出该帧的运动指标', () => {
  const file = projectWithMiniData();

  const { code, stdout } = runCli(['--project', file, '--at-frame', '15']);

  assert.equal(code, 0);
  assert.match(stdout, /帧号：15（fps 10，对齐偏移 0 ms）/);
  assert.match(stdout, /运动时刻：1\.500 s/);
  assert.match(stdout, /距离：6 m/);
  assert.match(stdout, /配速：4'10"\/km/);
  assert.match(stdout, /心率：150 bpm/);
  assert.match(stdout, /步频：180 spm/);
});

// 验收项 7：对齐偏移只影响「视频 0 秒对应的运动时刻」，不影响帧号本身。
test('--at-frame 叠加 alignmentOffsetMs 后取对应时刻的指标', () => {
  const file = projectWithMiniData((project) => {
    project.alignmentOffsetMs = 500;
  });

  const { code, stdout } = runCli(['--project', file, '--at-frame', '15']);

  assert.equal(code, 0);
  assert.match(stdout, /帧号：15（fps 10，对齐偏移 500 ms）/);
  assert.match(stdout, /运动时刻：2\.000 s/);
  assert.match(stdout, /心率：160 bpm/);
});

// 超出活动时长的帧取末点值（不外推、不报 NaN）。
test('--at-frame 超出活动时长时取末点值', () => {
  const file = projectWithMiniData();

  const { code, stdout } = runCli(['--project', file, '--at-frame', '100']);

  assert.equal(code, 0);
  assert.match(stdout, /运动时刻：10\.000 s/);
  assert.match(stdout, /心率：160 bpm/);
  assert.match(stdout, /距离：8 m/);
});

// 帧号必须是 0 起的整数。
test('--at-frame 取值非法时退出码 2', () => {
  const file = projectWithMiniData();

  assert.equal(runCli(['--project', file, '--at-frame', 'abc']).code, 2);
  assert.match(runCli(['--project', file, '--at-frame', 'abc']).stderr, /--at-frame 需要非负整数/);
  assert.equal(runCli(['--project', file, '--at-frame', '1.5']).code, 2);
  assert.equal(runCli(['--project', file, '--at-frame', '-1']).code, 2);
});

// 数据源缺失对 --at-frame 同样成立。
test('--at-frame 遇到缺失数据源时退出码 4', () => {
  const file = projectWithMiniData((project) => {
    project.tcx = { path: './missing.tcx' };
  });

  const { code, stderr } = runCli(['--project', file, '--at-frame', '0']);

  assert.equal(code, 4);
  assert.match(stderr, /无法读取数据源/);
});
