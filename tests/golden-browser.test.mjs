import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESET_IDS } from '../shared/presets.js';
import { findChrome, runBrowserGolden } from './golden-browser.mjs';
import { formatReport } from './golden-compare.mjs';

const chrome = findChrome();

// 验收项：浏览器 headless 与 Node 各出一张 PNG，与同一张基准图比对。
// 这条测试依赖本机 Chrome 与端口，环境不确定时跳过；`npm run golden:browser` 可单独跑。
test(
  '浏览器侧（Chrome headless）两个预设与基准图一致',
  { skip: chrome === null ? '未找到 Chrome，跳过浏览器侧基准图比对' : false },
  async () => {
    const reports = await runBrowserGolden({ presetIds: BUILTIN_PRESET_IDS, chrome });

    assert.equal(reports.length, BUILTIN_PRESET_IDS.length);
    for (const report of reports) {
      assert.ok(report.pass, `${formatReport(report)} → 判定未通过`);
    }
  },
);
