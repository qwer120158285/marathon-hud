#!/usr/bin/env node
/**
 * 准备真实验收素材（`npm run assets:prepare`）。
 *
 * 素材不入库（`*.mp4` 被 .gitignore 忽略），但验收文档里的命令必须可复现：
 * 这里把两段本机拍摄素材各取 12 s，按画布预设的宽高缩放并裁齐，写到 `assets/`。
 *
 * 缩放 / 裁剪只发生在**素材准备**阶段；渲染工具本身仍然不做 scale / crop / pad（ADR 0003）。
 *
 * 用法：
 *   npm run assets:prepare
 *   node scripts/prepare-assets.mjs --portrait ~/Movies/a.mp4 --landscape ~/Movies/b.mp4
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');

/** 验收用素材规格：12 s、30 fps、与画布预设等宽高（同名路径由两个 project.json 引用）。 */
export const ASSET_SPECS = [
  {
    key: 'portrait',
    flag: '--portrait',
    defaultSource: '~/Movies/ba8b092acd78ac0a2bbc19583a39af55.mp4',
    width: 1080,
    height: 1920,
    output: 'assets/run-portrait.mp4',
  },
  {
    key: 'landscape',
    flag: '--landscape',
    defaultSource: '~/Movies/bgm.mp4',
    width: 1920,
    height: 1080,
    output: 'assets/run-landscape.mp4',
  },
];

const SECONDS = 12;
const FPS = 30;

/** 素材缺失时打印的准备指引；验收脚本直接复用这一段，避免两处说明漂移。 */
export const ASSET_HINT = [
  '真实素材不入库（*.mp4 被 .gitignore 忽略），先运行：',
  '  npm run assets:prepare',
  '等价命令（本机素材 → 12 s、1080×1920 / 1920×1080）：',
  '  ffmpeg -y -t 12 -i ~/Movies/ba8b092acd78ac0a2bbc19583a39af55.mp4 \\',
  '    -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1" \\',
  '    -r 30 -an -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p assets/run-portrait.mp4',
  '  ffmpeg -y -t 12 -i ~/Movies/bgm.mp4 \\',
  '    -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1" \\',
  '    -r 30 -an -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p assets/run-landscape.mp4',
].join('\n');

/** `~/...` → 绝对路径（spawn 不经过 shell，不会自己展开 ~）。 */
function expandHome(value) {
  return value.startsWith('~/') ? path.join(process.env.HOME ?? '', value.slice(2)) : value;
}

/** 解析 `--portrait` / `--landscape` 覆盖值；其余参数报错，避免拼错后静默用默认素材。 */
export function parseAssetArgs(argv) {
  const sources = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') return { help: true, sources };
    const spec = ASSET_SPECS.find((item) => item.flag === token);
    if (spec === undefined) throw new Error(`未知参数 "${token}"；可用参数见 --help`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${token} 需要一个视频路径`);
    }
    sources[spec.key] = value;
    i += 1;
  }
  return { help: false, sources };
}

/** 单个素材：缩放 + 裁齐 + 截取 12 s（无音轨，成片音频由单元测试的带音轨素材覆盖）。 */
export function prepareAsset(spec, source) {
  const outputPath = path.join(REPO_ROOT, spec.output);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const filter = `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=increase`
    + `,crop=${spec.width}:${spec.height},setsar=1`;
  const result = spawnSync('ffmpeg', [
    '-v', 'error',
    '-y',
    '-t', String(SECONDS),
    '-i', source,
    '-vf', filter,
    '-r', String(FPS),
    '-an',
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ], { encoding: 'utf8' });

  if (result.error !== undefined) {
    throw new Error(`无法启动 ffmpeg：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg 处理失败：${source}\n${result.stderr.trim()}`);
  }
  return outputPath;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseAssetArgs(argv);
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(
      '用法：node scripts/prepare-assets.mjs [--portrait <视频>] [--landscape <视频>]\n\n'
        + `${ASSET_HINT}\n`,
    );
    return 0;
  }

  for (const spec of ASSET_SPECS) {
    const source = expandHome(parsed.sources[spec.key] ?? spec.defaultSource);
    if (!existsSync(source)) {
      process.stderr.write(`错误：素材不存在：${source}\n${ASSET_HINT}\n`);
      return 2;
    }
    const outputPath = prepareAsset(spec, source);
    process.stdout.write(`${spec.output} ← ${source}\n  ${spec.width}×${spec.height}，${SECONDS} s，${FPS} fps\n${outputPath}\n`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
