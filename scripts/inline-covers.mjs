#!/usr/bin/env node
/* --inline-covers：把内置歌曲封面下载下来，压成 300px JPEG data URI 打进单文件。
   供 scripts/build.mjs 在 --inline-covers 时 import。
   - 只处理 src/data.js 里内置歌曲的 coverUrl（不碰用户自己加的封面）；
   - 下载失败会明确 warning 并统计；一张都没成功则构建失败（不许静默打空）；
   - 压缩后的图缓存在 assets/covers-300/（下次构建可离线复用，除非 --refresh-covers）。
*/
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const COVER_DIR = 'assets/covers-300';

function resizeToJpeg(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-vf', "scale='min(300,iw)':-2",
      '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => { err += c.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error('ffmpeg 压缩失败：' + (err.slice(-200) || ('exit ' + code))));
    });
    ff.stdin.end(buffer);
  });
}

async function downloadCover(url) {
  const lastErr = { message: '' };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url + '?param=300y300', {
        signal: AbortSignal.timeout(20000),
        headers: {
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          referer: 'https://music.163.com/'
        }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 500) throw new Error('图片太小');
      return buffer;
    } catch (e) {
      lastErr.message = e.message || String(e);
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    }
  }
  throw new Error(lastErr.message);
}

async function coverJpeg(root, url, refresh) {
  const cacheDir = path.join(root, COVER_DIR);
  fs.mkdirSync(cacheDir, { recursive: true });
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const cacheFile = path.join(cacheDir, hash + '.jpg');
  if (!refresh && fs.existsSync(cacheFile)) {
    return fs.readFileSync(cacheFile);
  }
  const original = await downloadCover(url);
  const jpeg = await resizeToJpeg(original);
  fs.writeFileSync(cacheFile, jpeg);
  return jpeg;
}

export async function buildInlineCovers({ root, html, read }) {
  const data = read('src/data.js');
  const urls = [...new Set([...data.matchAll(/coverUrl:\s*"([^"]+)"/g)].map((m) => m[1]))];
  if (!urls.length) throw new Error('没有从 src/data.js 里解析到任何封面地址');
  const refresh = process.argv.includes('--refresh-covers');
  const map = {};
  const failed = [];
  for (const url of urls) {
    try {
      const jpeg = await coverJpeg(root, url, refresh);
      map[url] = 'data:image/jpeg;base64,' + jpeg.toString('base64');
    } catch (e) {
      failed.push(url + '（' + (e.message || e) + '）');
    }
  }
  if (failed.length) {
    console.warn('  ⚠ 有 ' + failed.length + '/' + urls.length + ' 张封面没有内联成功：' + failed.join('；'));
  }
  if (!Object.keys(map).length) {
    throw new Error('一张封面都没能内联：检查网络能不能访问 p1–p4.music.126.net，或先跑一次成功的构建把缓存放到 ' + COVER_DIR + '/');
  }
  const marker = '/*@INLINE_COVERS@*/';
  if (!html.includes(marker)) throw new Error('构建产物里缺少封面注入标记 ' + marker);
  const out = html.split(marker).join(JSON.stringify(map));
  const kb = (Object.values(map).reduce((n, v) => n + v.length, 0) / 1024).toFixed(1);
  return {
    html: out,
    stats: Object.keys(map).length + '/' + urls.length + ' 张（' + kb + ' KB data URI）'
  };
}
