  /* =========================================================================
     第二块 · 网易云封面加载：p1→p4 域名轮换重试 + --inline-covers 内联封面
     模块和 app.js 同作用域（构建时注入 src/modules/*.js）。
     ========================================================================= */

  var D2_COVER_HOSTS = ['p1', 'p2', 'p3', 'p4'];
  var D2_COVER_HOST_RE = /^(https?:)\/\/p[1-4]\.music\.126\.net\//i;
  /* 构建时若带 --inline-covers，这里会被替换成 {"原图地址":"data:image/jpeg;base64,..."} */
  var INLINE_COVER_MAP = /*@INLINE_COVERS@*/;

  function d2CoverSwapHost(url, attempt) {
    var m = D2_COVER_HOST_RE.exec(String(url || ''));
    if (!m) return '';
    var index = Math.max(0, Math.min(3, parseInt(attempt, 10) || 0));
    var host = D2_COVER_HOSTS[index];
    return m[1] + '://' + host + '.music.126.net/' + String(url).slice(m[0].length);
  }

  /* 封面地址：内联样稿优先用 data URI；正常版由手机直连网易云，失败再换 p1–p4 */
  function d2CoverSongUrl(song, size, attempt) {
    if (!song || !song.coverUrl) return '';
    var inline = INLINE_COVER_MAP && INLINE_COVER_MAP[song.coverUrl];
    if (inline) return inline;
    var px = size || 300;
    var url = song.coverUrl + '?param=' + px + 'y' + px;
    if (attempt === undefined || attempt === null || attempt <= 0) return url;
    var swapped = d2CoverSwapHost(url, attempt - 1);
    return swapped || url;
  }

  /* 页面内 <img onerror> 统一走这里：p1→p2→p3→p4 轮流试，全失败才退回素面唱片 */
  function d2CoverError(img) {
    if (!img) return;
    var src = img.getAttribute('src') || '';
    var cleanup = function () {
      img.onerror = null;
      img.removeAttribute('src');
      var wrap = img.parentNode;
      if (wrap && wrap.classList) wrap.classList.add('is-missing');
    };
    if (src.indexOf('data:') === 0) { cleanup(); return; }
    var attempt = parseInt(img.getAttribute('data-cover-attempt') || '0', 10) || 0;
    var base = img.getAttribute('data-cover-base') || src;
    if (!base) { cleanup(); return; }
    if (attempt >= 4) { cleanup(); return; }
    var next = d2CoverSwapHost(base, attempt);
    if (!next) { cleanup(); return; }
    img.setAttribute('data-cover-attempt', String(attempt + 1));
    img.src = next;
  }

  /* JS 里逐张设置封面的场景（首页唱片、一起听大图）共用这里的重试 */
  function d2CoverSetImg(el, song, size) {
    if (!el) return;
    var url = d2CoverSongUrl(song, size, 0);
    if (!url) {
      el.onerror = null;
      el.classList.add('is-missing');
      el.removeAttribute('src');
      return;
    }
    el.classList.remove('is-missing');
    el.setAttribute('data-cover-base', url.indexOf('data:') === 0 ? '' : url);
    el.setAttribute('data-cover-attempt', '0');
    el.onerror = function () { d2CoverError(el); };
    if (el.getAttribute('src') !== url) el.src = url;
  }

  function d2InitCovers() {
    window.d2CoverError = d2CoverError;
    window.d2CoverSongUrl = d2CoverSongUrl;
  }

  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(d2InitCovers, 0);
  });
