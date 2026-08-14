// LeskoHelp Pro — tiny API worker.
// Static assets are served before this worker runs; only unmatched
// routes (like /api/videos) land here.

const CHANNEL_ID = 'UCwKJZfa7sWV_qKxQnLBUpjA'; // @MatthewLesko
const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CHANNEL_ID;
const MAX_VIDEOS = 12;

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

    return new Response('Not found', { status: 404 });
  }
};
