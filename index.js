/**
 * Host half of the NetEase Cloud Music plugin.
 *
 * Owns one prefix route, `/api/dsh-wyymusic-player`, and answers it from
 * `lib/wyy.js`. It exists because the browser cannot reach `music.163.com`
 * itself: the NetEase gateways send no CORS headers, the audio CDN needs a
 * matching Referer, and the session cookie must not live in page storage.
 *
 * The browser half is a `dsh.client` module declared in `package.json`.
 */
import { Readable } from 'node:stream';
import { NeteaseClient, NeteaseError } from './lib/wyy.js';

export const inject = ['webServer'];

const ROUTE_PATH = '/api/dsh-wyymusic-player';

const DEFAULT_AUDIO_HOSTS = [
  '.music.126.net',
  '.126.net',
  '.163.com',
  '.music.163.com',
  '.netease.com',
];

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 256) throw new NeteaseError('请求体过大', 'too-large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  const type = String(req.headers['content-type'] || '');
  try {
    if (type.includes('application/json')) return JSON.parse(text);
    return Object.fromEntries(new URLSearchParams(text));
  } catch {
    throw new NeteaseError('请求体不是合法的 JSON 或表单', 'bad-body');
  }
}

function hostAllowed(hostname, suffixes) {
  const host = String(hostname || '').toLowerCase();
  return suffixes.some((suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix));
}

/**
 * Re-slice a full response body into one byte window, for the case where the CDN
 * ignored a Range request. Chunks are dropped until `start` and the stream is cut
 * at `end`, keeping the declared `content-length` honest.
 * @param body - web ReadableStream from `fetch`
 * @param start - first byte to emit (inclusive)
 * @param end - last byte to emit (inclusive)
 */
async function* skipBytes(body, start, end) {
  let offset = 0;
  for await (const chunk of Readable.fromWeb(body)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const chunkStart = offset;
    const chunkEnd = offset + buffer.length - 1;
    offset += buffer.length;
    if (chunkEnd < start) continue;
    const from = Math.max(0, start - chunkStart);
    const to = Math.min(buffer.length, end - chunkStart + 1);
    if (to > from) yield buffer.subarray(from, to);
    if (chunkEnd >= end) return;
  }
}

export function apply(ctx, config = {}) {
  const settings = config && typeof config === 'object' ? config : {};
  const client = new NeteaseClient({
    stateFile: typeof settings.stateFile === 'string' ? settings.stateFile : undefined,
    timeoutMs: Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : undefined,
  });
  const audioHosts = Array.isArray(settings.allowedAudioHosts) && settings.allowedAudioHosts.length
    ? settings.allowedAudioHosts.map(String)
    : DEFAULT_AUDIO_HOSTS;

  /** Stream one CDN object with Range support so seeking works in <audio>. */
  async function streamAudio(req, res, url) {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return sendJson(res, 400, { ok: false, error: '仅支持 http/https 音频地址' });
    }
    if (!hostAllowed(target.hostname, audioHosts)) {
      return sendJson(res, 403, { ok: false, error: `不允许的音频域名：${target.hostname}` });
    }
    const headers = { 'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0', Referer: 'https://music.163.com/' };
    if (req.headers.range) headers.Range = String(req.headers.range);
    // The response body is streamed for as long as the track plays, so the
    // request must live until the client goes away — a fixed timeout would cut
    // a long track off mid-stream. The ceiling only bounds a stalled socket.
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const signal =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([abort.signal, AbortSignal.timeout(10 * 60 * 1000)])
        : abort.signal;
    let upstream;
    try {
      upstream = await fetch(target, { headers, signal });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: `音频源不可达：${error && error.message}` });
    }
    if (!upstream.ok && upstream.status !== 206) {
      return sendJson(res, upstream.status === 404 ? 404 : 502, {
        ok: false,
        error: `音频源返回 HTTP ${upstream.status}`,
      });
    }
    // The client asked for a byte range. If the CDN ignored it and answered 200 with the
    // whole object, passing that 200 straight through would tell the browser the resource
    // is not seekable: `<audio>` then *silently discards* `currentTime` assignments and
    // replays from the very start, which is exactly the "drag the bar and the song
    // restarts" symptom. Answering 206 ourselves keeps the stream addressable.
    const rangeHeader = req.headers.range ? String(req.headers.range) : '';
    const total = Number(upstream.headers.get('content-length')) || 0;
    const wantsRange = /^bytes=/.test(rangeHeader);
    const upstreamRange = upstream.headers.get('content-range');
    const seekable = upstream.status === 206 && Boolean(upstreamRange);
    const out = {
      'content-type': upstream.headers.get('content-type') || 'audio/mpeg',
      'cache-control': 'no-store',
    };
    // Advertise range support whenever this proxy can actually honour a range: either the
    // CDN gave us a real byte range, or we know the total size and can synthesise one
    // below. Advertising it is what tells `<audio>` the stream is addressable; without it
    // the element may treat the media as unseekable and restart from 0 on every seek.
    if (seekable || total > 0) out['accept-ranges'] = 'bytes';
    for (const [from, to] of [
      ['content-length', 'content-length'],
      ['content-range', 'content-range'],
      ['etag', 'etag'],
      ['last-modified', 'last-modified'],
    ]) {
      const value = upstream.headers.get(from);
      if (value) out[to] = value;
    }
    // Upstream ignored the range: synthesise a correct 206 for the requested window so
    // the element stays seekable for the rest of the track.
    if (wantsRange && !seekable && total > 0) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        if (Number.isFinite(start) && start <= end && start < total) {
          out['accept-ranges'] = 'bytes';
          out['content-range'] = `bytes ${start}-${end}/${total}`;
          out['content-length'] = String(end - start + 1);
          res.writeHead(206, out);
          if (!upstream.body) {
            res.end();
            return undefined;
          }
          const stream = Readable.from(skipBytes(upstream.body, start, end));
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return undefined;
        }
      }
    }
    res.writeHead(upstream.status, out);
    if (!upstream.body) {
      res.end();
      return undefined;
    }
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return undefined;
  }

  const handler = async (req, res) => {
    let pathname;
    let query;
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      pathname = url.pathname.slice(ROUTE_PATH.length) || '/';
      query = url.searchParams;
    } catch {
      sendJson(res, 400, { ok: false, error: '非法请求地址' });
      return;
    }

    try {
      if (pathname === '/audio') {
        const src = query.get('src');
        if (!src) {
          sendJson(res, 400, { ok: false, error: '缺少 src 参数' });
          return;
        }
        await streamAudio(req, res, src);
        return;
      }

      if (pathname === '/status' && req.method === 'GET') {
        const status = await client.loginStatus();
        sendJson(res, 200, { ok: true, ...status });
        return;
      }

      if (pathname === '/login/captcha/sent' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.phone) {
          sendJson(res, 400, { ok: false, error: '请填写手机号' });
          return;
        }
        await client.captchaSent(String(body.phone), String(body.countrycode || '86'));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/login/captcha' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.phone || !body.captcha) {
          sendJson(res, 400, { ok: false, error: '请填写手机号与验证码' });
          return;
        }
        const status = await client.loginCaptcha(String(body.phone), String(body.captcha), String(body.countrycode || '86'));
        sendJson(res, 200, { ok: true, ...status });
        return;
      }

      if (pathname === '/login/cookie' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.cookie) {
          sendJson(res, 400, { ok: false, error: '请粘贴 Cookie' });
          return;
        }
        const status = await client.loginCookie(String(body.cookie));
        sendJson(res, 200, { ok: true, ...status });
        return;
      }

      if (pathname === '/logout' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, ...(await client.logout()) });
        return;
      }

      // Multiple saved accounts: the picker lists them, and switching only moves which
      // stored cookie the rest of the routes use.
      if (pathname === '/accounts' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...client.accountStatus() });
        return;
      }

      if (pathname === '/accounts/switch' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.userId === undefined || body.userId === null || body.userId === '') {
          sendJson(res, 400, { ok: false, error: '缺少 userId 参数' });
          return;
        }
        sendJson(res, 200, { ok: true, ...client.switchAccount(body.userId) });
        return;
      }

      if (pathname === '/accounts/remove' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.userId === undefined || body.userId === null || body.userId === '') {
          sendJson(res, 400, { ok: false, error: '缺少 userId 参数' });
          return;
        }
        sendJson(res, 200, { ok: true, ...client.removeAccount(body.userId) });
        return;
      }

      if (pathname === '/playlists' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, playlists: await client.playlists() });
        return;
      }

      if (pathname === '/playlist' && req.method === 'GET') {
        const id = query.get('id');
        if (!id) {
          sendJson(res, 400, { ok: false, error: '缺少 id 参数' });
          return;
        }
        // Always the whole playlist; there is deliberately no `limit` any more.
        sendJson(res, 200, { ok: true, ...(await client.playlist(id)) });
        return;
      }

      if (pathname === '/song/url' && req.method === 'POST') {
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids : body.ids ? [body.ids] : [];
        if (!ids.length) {
          sendJson(res, 400, { ok: false, error: '缺少 ids 参数' });
          return;
        }
        const level = String(body.level || 'exhigh');
        sendJson(res, 200, { ok: true, level, songs: await client.songUrls(ids, level) });
        return;
      }

      if (pathname === '/lyric' && req.method === 'GET') {
        const id = query.get('id');
        if (!id) {
          sendJson(res, 400, { ok: false, error: '缺少 id 参数' });
          return;
        }
        sendJson(res, 200, { ok: true, ...(await client.lyric(id)) });
        return;
      }

      if (pathname === '/search' && req.method === 'GET') {
        const keywords = query.get('keywords');
        if (!keywords) {
          sendJson(res, 400, { ok: false, error: '缺少 keywords 参数' });
          return;
        }
        const type = Number(query.get('type')) || 1;
        const limit = Number(query.get('limit')) || 30;
        const result = await client.search(keywords, type, limit);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (pathname === '/intelligence' && req.method === 'GET') {
        const pid = query.get('pid');
        const sid = query.get('sid');
        if (!pid || !sid) {
          sendJson(res, 400, { ok: false, error: '心动模式需要 pid 与 sid 参数' });
          return;
        }
        sendJson(res, 200, { ok: true, tracks: await client.intelligence(pid, sid) });
        return;
      }

      sendJson(res, 404, { ok: false, error: `未知的接口：${pathname}` });
    } catch (error) {
      if (error instanceof NeteaseError) {
        const status = typeof error.code === 'number' && error.code >= 100 && error.code < 600 ? error.code : 400;
        sendJson(res, status === 200 ? 400 : status, { ok: false, error: error.message, code: error.code });
        return;
      }
      console.warn('[wyymusic-player] route failed:', error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: (error && error.message) || '内部错误' });
      else res.destroy();
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler }),
    'wyymusic-player: api routes',
  );
}
