#!/usr/bin/env node
/* 第二块验收：--inline-covers 打出来的单文件，在拦截 *.126.net 后仍能显示封面。
   做法：静态服务 dist/index.html + headless Chrome 加 --host-resolver-rules="MAP *.126.net 127.0.0.1"，
   打开「一起听」，断言封面 naturalWidth>0，两主题各截一张图到 shots/phase-d2/。
   用法：node scripts/phase-d2-covers-check.mjs   （会先跑 node scripts/build.mjs --inline-covers）
*/
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, serveStatic, startChrome, sleep } from './d2-cdp.mjs';

const DIST = path.join(ROOT, 'dist/index.html');
execFileSync(process.execPath, [path.join(ROOT, 'scripts/build.mjs'), '--inline-covers'], { cwd: ROOT, stdio: 'inherit' });
const html = fs.readFileSync(DIST, 'utf8');
const inlineCount = (html.match(/data:image\/jpeg;base64,/g) || []).length - 18;
if (!/var INLINE_COVER_MAP = \{/.test(html)) throw new Error('dist 里没有内联封面表');
if (!html.includes('"https://p')) throw new Error('内联封面表里没有原图地址键');
console.log('内联封面 data URI 数量：', inlineCount);

const served = await serveStatic(html);
const page = await startChrome({ hostResolverRules: 'MAP *.126.net 127.0.0.1', outDir: path.join(ROOT, 'shots/phase-d2') });
const results = {};
try {
  for (const theme of ['pink', 'ice']) {
    await page.send('Page.navigate', { url: served.base + '/blank' });
    await sleep(300);
    await page.ev('localStorage.setItem("msyq.v2", ' + JSON.stringify(JSON.stringify({ theme, overrides: {}, settings: {} })) + '); localStorage.setItem("msyq.migrated","1"); true');
    await page.send('Page.navigate', { url: served.base + '/' });
    await page.waitFor("document.querySelector('.view.is-active') && document.querySelectorAll('.w').length>=6", 15000);
    await sleep(700);
    await page.click('.tab[data-nav="listen"]', 900);
    await page.waitFor("document.getElementById('trackCover') && document.getElementById('listenPlaylist') && document.querySelectorAll('.song-row').length>0", 8000);
    await sleep(1600);
    const info = await page.ev(`(function(){
      function stat(sel){
        var els = [].slice.call(document.querySelectorAll(sel));
        var loaded = els.filter(function(im){ return im && (im.naturalWidth||0) > 0; });
        return {total: els.length, loaded: loaded.length, widths: loaded.map(function(im){ return im.naturalWidth; })};
      }
      var coverImgs = [].slice.call(document.querySelectorAll('#recordCover, #trackCover, .song-row__cover img, #homeDiscCover'));
      var dataUri = coverImgs.filter(function(im){ return (im.getAttribute('src')||'').indexOf('data:image/jpeg') === 0; }).length;
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        record: stat('#recordCover'),
        track: stat('#trackCover'),
        rows: stat('.song-row__cover img'),
        disk: stat('#homeDiscCover'),
        dataUriImages: dataUri,
        coverImages: coverImgs.length,
        missing: document.querySelectorAll('.is-missing').length
      };
    })()`);
    results[theme] = info;
    await page.shot('covers-inline-blocked-' + theme, 300);
  }
} finally {
  await page.close();
  await served.close();
}

const ok = results.pink.record.loaded === 1 && results.ice.record.loaded === 1 &&
  results.pink.rows.loaded === results.pink.rows.total && results.ice.rows.loaded === results.ice.rows.total &&
  results.pink.dataUriImages === results.pink.coverImages && results.ice.dataUriImages === results.ice.coverImages &&
  results.pink.dataUriImages > 0 && results.pink.missing === 0 && results.ice.missing === 0;
console.log(JSON.stringify(results, null, 2));
console.log('JS errors:', page.errors.slice(0, 5));
console.log(ok ? '✅ 拦截 126.net 后封面仍全部显示' : '❌ 有封面没显示');
process.exitCode = ok ? 0 : 1;
