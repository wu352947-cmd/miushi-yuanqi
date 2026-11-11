#!/usr/bin/env node
/* 构建：把 CSS / 壁纸 base64 / 数据 / 交互脚本内联进单文件 dist/index.html
   第 D2 轮起支持：
   - src/features/*.css：按文件名排序拼在 liquid.css 之后；
   - src/modules/*.js：按文件名排序注入 app.js 的 /*@MODULES@* / 位置（同一个 IIFE 作用域）；
   - --inline-covers：把内置歌曲封面压成 300px JPEG data URI 打进单文件（用于交付样稿）。
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const readDirJs = (dir) => {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => f.endsWith('.js')).sort();
};
const readDirCss = (dir) => {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => f.endsWith('.css')).sort();
};

const html = read('src/index.html');
const featureCss = readDirCss('src/features').map((f) => '\n/* ===== features/' + f + ' ===== */\n' + read('src/features/' + f)).join('');
const css = read('src/styles.css') + "\n" + read('src/liquid.css') + featureCss;
const data = read('src/data.js');
let app = read('src/app.js');

/* 功能模块按文件名排序注入 app.js 的 IIFE 内，和 app.js 共享作用域 */
const moduleFiles = readDirJs('src/modules');
const moduleCode = moduleFiles.map((f) => '\n/* ===== modules/' + f + ' ===== */\n' + read('src/modules/' + f)).join('');
if (!app.includes('/*@MODULES@*/')) throw new Error('app.js 缺少 /*@MODULES@*/ 注入点');
app = app.split('/*@MODULES@*/').join(moduleCode);

const wpDir = path.join(root, 'assets/wallpapers-720');
const wpFiles = fs.readdirSync(wpDir).filter((f) => /^wp\d{2}\.jpg$/.test(f)).sort();
const wpMap = {};
for (const f of wpFiles) {
  const b64 = fs.readFileSync(path.join(wpDir, f)).toString('base64');
  wpMap[f.replace('.jpg', '')] = 'data:image/jpeg;base64,' + b64;
}
if (wpFiles.length !== 18) throw new Error('壁纸数量不是 18：' + wpFiles.length);

const wallpapers = 'const WALLPAPERS = ' + JSON.stringify(wpMap) + ';';

/* 官方图标：只内联 src/icons/ 里实际用到的 SVG（MIT，@lobehub/icons-static-svg） */
const iconDir = path.join(root, 'src/icons');
const iconFiles = fs.readdirSync(iconDir).filter((f) => f.endsWith('.svg')).sort();
if (!iconFiles.length) throw new Error('src/icons/ 里没有图标');
const iconMap = {};
for (const f of iconFiles) {
  let svg = fs.readFileSync(path.join(iconDir, f), 'utf8');
  if (!/^<svg[\s>]/.test(svg.trim())) throw new Error('图标不是 SVG：' + f);
  svg = svg
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/\s*height="1em"/g, '')
    .replace(/\s*width="1em"/g, '')
    .replace(/\s*style="flex:none;line-height:1"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim();
  const key = f.replace(/\.svg$/, '');
  iconMap[key] = svg;
  /* 彩色图标同时注册短名（deepseek-color → deepseek），方便按提供商类型取用 */
  if (/-color$/.test(key)) iconMap[key.replace(/-color$/, '')] = svg;
}
const icons = 'const PROVIDER_ICONS = ' + JSON.stringify(iconMap) + ';';

let out = html
  .split('/*@CSS@*/').join(css)
  .split('/*@WALLPAPERS@*/').join(wallpapers)
  .split('/*@ICONS@*/').join(icons)
  .split('/*@DATA@*/').join(data)
  .split('/*@APP@*/').join(app);

for (const token of ['/*@CSS@*/', '/*@WALLPAPERS@*/', '/*@ICONS@*/', '/*@DATA@*/', '/*@APP@*/']) {
  if (out.includes(token)) throw new Error('存在未替换的占位符：' + token);
}
if (!out.includes('PROVIDER_ICONS')) throw new Error('app.js 未引用 PROVIDER_ICONS');
if (!out.includes('WALLPAPERS')) throw new Error('app.js 未引用 WALLPAPERS');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

/* --inline-covers：把内置歌曲封面压成 300px JPEG data URI 打进单文件（交付样稿用） */
const inlineCovers = process.argv.includes('--inline-covers');
let coverStats = '';
if (inlineCovers) {
  const mod = await import(path.join(root, 'scripts/inline-covers.mjs'));
  const result = await mod.buildInlineCovers({ root, html: out, read });
  out = result.html;
  coverStats = result.stats || '';
} else {
  /* 普通构建：内联封面表留空，封面仍由手机直连网易云（失败走 p1–p4 重试） */
  out = out.split('/*@INLINE_COVERS@*/').join('{}');
}

fs.writeFileSync(path.join(root, 'dist/index.html'), out, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('dist/index.html 已生成' + (inlineCovers ? '（--inline-covers）' : ''));
console.log('  壁纸：' + wpFiles.length + ' 张，' + kb(Object.values(wpMap).reduce((s, v) => s + v.length, 0)) + ' base64');
console.log('  CSS：' + kb(css.length) + ' · 数据：' + kb(data.length) + ' · 脚本：' + kb(app.length));
console.log('  模块：' + (moduleFiles.length ? moduleFiles.join(', ') : '无'));
if (coverStats) console.log('  内联封面：' + coverStats);
console.log('  单文件合计：' + kb(out.length));
