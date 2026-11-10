#!/usr/bin/env node
/* 构建：把 CSS / 壁纸 base64 / 数据 / 交互脚本内联进单文件 dist/index.html */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('src/index.html');
const css = read('src/styles.css') + "\n" + read('src/liquid.css');
const data = read('src/data.js');
const app = read('src/app.js');

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
if (!app.includes('PROVIDER_ICONS')) throw new Error('app.js 未引用 PROVIDER_ICONS');
if (!app.includes('WALLPAPERS')) throw new Error('app.js 未引用 WALLPAPERS');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/index.html'), out, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('dist/index.html 已生成');
console.log('  壁纸：' + wpFiles.length + ' 张，' + kb(Object.values(wpMap).reduce((s, v) => s + v.length, 0)) + ' base64');
console.log('  CSS：' + kb(css.length) + ' · 数据：' + kb(data.length) + ' · 脚本：' + kb(app.length));
console.log('  单文件合计：' + kb(out.length));