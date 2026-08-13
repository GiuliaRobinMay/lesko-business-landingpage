// LeskoHelp Pro — tiny API worker.
// Static assets are served before this worker runs; only unmatched
// routes (like /api/videos, /ai-embed, /llproxy/*) land here.

const CHANNEL_ID = 'UCwKJZfa7sWV_qKxQnLBUpjA'; // @MatthewLesko
const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CHANNEL_ID;
const MAX_VIDEOS = 12;

const LL_ORIGIN = 'https://www.leskolovesai.com';
const LL_PAGE = LL_ORIGIN + '/business';

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

async function latestVideos() {
  const res = await fetch(FEED_URL, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; LeskoHelpSite/1.0)' },
    cf: { cacheTtl: 1800, cacheEverything: true }
  });
  if (!res.ok) throw new Error('feed ' + res.status);
  const xml = await res.text();
  const videos = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) && videos.length < MAX_VIDEOS) {
    const entry = m[1];
    const id = (entry.match(/<yt:videoId>([\w-]+)<\/yt:videoId>/) || [])[1];
    const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const published = (entry.match(/<published>([^<]+)<\/published>/) || [])[1];
    if (id && title) videos.push({ id, title: decodeEntities(title.trim()), published: published || null });
  }
  return videos;
}

// Injected into the proxied Lesko Loves AI page. Routes the app's own
// root-relative API calls through /llproxy and removes the membership
// popup — matched strictly by its own text, so nothing else is touched.
const EMBED_INJECT = `<base href="${LL_ORIGIN}/"><script>(function () {
  // The app is a client-side-routed SPA: make sure it sees the path it
  // expects, no matter which local path served this wrapper.
  try { history.replaceState(null, '', '/business'); } catch (e) {}
  var P = '/llproxy';
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string' && input.charAt(0) === '/' && input.charAt(1) !== '/') {
        input = P + input;
      } else if (input instanceof Request) {
        var u = new URL(input.url);
        if (u.origin === location.origin && u.pathname.indexOf(P) !== 0) {
          input = new Request(P + u.pathname + u.search, input);
        }
      }
    } catch (e) {}
    return origFetch.call(this, input, init);
  };
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    try {
      if (typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/' && u.indexOf(P) !== 0) {
        arguments[1] = P + u;
      }
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = function () { return new Promise(function () {}); };
  }

  var MARKERS = ['Not a Member Yet', 'The Love You Get When You Become a Member'];
  function overlayFor(el) {
    var node = el, overlay = null, hops = 0;
    while (node && node !== document.body && hops < 14) {
      var cs = getComputedStyle(node);
      if (cs.position === 'fixed') overlay = node;
      node = node.parentElement; hops++;
    }
    return overlay;
  }
  function nuke() {
    if (!document.body) return;
    var els = document.body.querySelectorAll('div,section,dialog,aside');
    for (var i = 0; i < els.length; i++) {
      var t = els[i].textContent || '';
      for (var k = 0; k < MARKERS.length; k++) {
        if (t.indexOf(MARKERS[k]) !== -1) {
          var overlay = overlayFor(els[i]);
          if (overlay) {
            overlay.remove();
            document.documentElement.style.overflow = '';
            document.body.style.overflow = '';
            return;
          }
        }
      }
    }
  }
  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; nuke(); });
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', schedule);
  var tries = 0;
  var iv = setInterval(function () { schedule(); if (++tries > 25) clearInterval(iv); }, 800);
})();</script>`;

function stripHopHeaders(headers) {
  const h = new Headers(headers);
  ['host', 'cookie', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip'].forEach(k => h.delete(k));
  return h;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/videos') {
      const cache = caches.default;
      const cacheKey = new Request(url.origin + '/api/videos');
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      let body, status;
      try {
        body = JSON.stringify({ videos: await latestVideos() });
        status = 200;
      } catch (e) {
        body = JSON.stringify({ videos: [], error: 'feed-unavailable' });
        status = 502;
      }
      const res = new Response(body, {
        status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': status === 200 ? 'public, max-age=1800' : 'no-store'
        }
      });
      if (status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // Same-origin wrapper around the Lesko Loves AI page so we can strip
    // its membership popup. Any hiccup falls back to the real page.
    if (url.pathname === '/ai-embed' || url.pathname === '/business') {
      let upstream;
      try {
        upstream = await fetch(LL_PAGE, {
          headers: {
            'user-agent': request.headers.get('user-agent') || 'Mozilla/5.0',
            'accept': 'text/html,application/xhtml+xml',
            'accept-language': request.headers.get('accept-language') || 'en-US,en;q=0.9'
          }
        });
      } catch (e) {
        return Response.redirect(LL_PAGE, 302);
      }
      const ct = upstream.headers.get('content-type') || '';
      if (!upstream.ok || !ct.includes('text/html')) return Response.redirect(LL_PAGE, 302);
      let html = await upstream.text();
      if (!/<head[^>]*>/i.test(html)) return Response.redirect(LL_PAGE, 302);
      html = html.replace(/<head([^>]*)>/i, match => match + EMBED_INJECT);
      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex'
        }
      });
    }

    // Forward the embedded app's own API/data calls to its origin.
    if (url.pathname.startsWith('/llproxy/')) {
      const target = LL_ORIGIN + url.pathname.slice('/llproxy'.length) + url.search;
      const init = {
        method: request.method,
        headers: stripHopHeaders(request.headers),
        body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : await request.arrayBuffer()
      };
      init.headers.set('origin', LL_ORIGIN);
      init.headers.set('referer', LL_PAGE);
      let res;
      try {
        res = await fetch(target, init);
      } catch (e) {
        return new Response('proxy error', { status: 502 });
      }
      const h = new Headers(res.headers);
      h.delete('set-cookie');
      h.set('cache-control', 'no-store');
      return new Response(res.body, { status: res.status, headers: h });
    }

    // Root-relative subresources requested by the embedded page (images,
    // fonts referenced from inline styles, etc.) — recognizable by referer.
    const referer = request.headers.get('referer') || '';
    if (referer.includes('/ai-embed') || referer.includes('/business') || referer.includes('/llproxy/')) {
      try {
        const res = await fetch(LL_ORIGIN + url.pathname + url.search, {
          headers: { 'user-agent': request.headers.get('user-agent') || 'Mozilla/5.0', 'referer': LL_PAGE }
        });
        const h = new Headers(res.headers);
        h.delete('set-cookie');
        return new Response(res.body, { status: res.status, headers: h });
      } catch (e) {
        return new Response('Not found', { status: 404 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
};
