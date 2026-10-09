/**
 * Browser half of the NetEase Cloud Music plugin.
 *
 * Registers one right-Sidebar tab type (`wyymusic-player`) through the same public
 * two-stage path a shipped provider uses — `ctx.sidebarRightTabs.register` for
 * the type, a `sidebar.right.pane.tab` registration for the body — and renders
 * the player inside it.
 *
 * Three more seats carry the rest of the feature: the left Sidebar's foot row
 * opens the panel, and `conversation.input.dock` renders the read-only now-playing
 * strip above the composer with the current track, its artist, a playhead-driven
 * pulse, and the current and next lyric lines. The strip is switched from the
 * player's own bottom-right control and stores that choice in the same
 * localStorage preferences as the volume and the play mode.
 *
 * Everything here is plain JavaScript: React comes from the browser module
 * table, the Host half is reached over `/api/dsh-wyymusic-player`, and every
 * colour comes from a `--dsw-alias-*` theme token so the panel follows the DSH
 * theme and whatever a skin plugin (dsh-web-all's skin center) overrides.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-wyymusic-player',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const PACKAGE_ID = '@local/dsh-wyymusic-player';
    const NS = 'wyyMusicPlayer';
    const KIND = 'wyymusic-player';
    const API = '/api/dsh-wyymusic-player';
    const PREF_KEY = 'dsh.wyymusic-player.prefs';
    const OPENED_KEY = 'dsh.wyymusic-player.autoOpened';

    // How often the clock checks which lyric line is current. It is a binary
    // search over the timeline and only commits to the store when the line or
    // the whole second actually changes, so a tight interval is cheap and keeps
    // the switch within ~100ms of the real timestamp (a 500ms tick made fast
    // songs visibly late). The transport position still commits once a second.
    const LYRIC_POLL_MS = 100;
    // How long to sweep a lyric line that has no word-level (YRC) timing.
    //
    // An LRC file stamps only where a line *starts*, so the sweep must guess how
    // long the line is sung. Using the whole gap to the next stamp overshoots: the
    // voice usually stops before the next line begins, and the gap is often a held
    // instrumental bar (over 1429 measured line pairs, 40% end with >0.5s of
    // trailing silence). So the tail has to be trimmed — but by how much?
    //
    // A single global rate does NOT work. Singing speed varies hugely between
    // songs: the 95th percentile line runs 8x slower per character than the 5th,
    // and whole songs differ (measured medians: 0.39 s/char for one ballad here,
    // 0.81 for another). A fixed cap tuned on the average therefore saws the legs
    // off slow songs — a 0.6 s/char cap shortened 24 of 27 lines in `彼方へ…`,
    // which is exactly "the highlight races ahead of the vocal".
    //
    // So the reference is the song's OWN median pace, and only lines that are
    // clear *outliers* against it get trimmed. Those outliers are the instrumental
    // gaps; a slow ballad's ordinary lines are left alone. Compared with the same
    // YRC ground truth this lowers the mean position error (13.5% -> 12.5%) and,
    // importantly, no song in the 45-track validation set comes out worse.
    // The factor is deliberately generous: at 1.5 a line may run 50% slower than
    // the song's own pace and still be trusted in full, so only padding is cut.
    const LRC_SLOW_LINE_FACTOR = 1.5;
    // Even a trimmed line still keeps at least this share of its gap, so a line
    // that really is held for a long time cannot collapse to a blink.
    const LRC_MIN_GAP_SHARE = 0.5;
    // Fallback pace when the song has too few lines to measure one (s/char).
    const LRC_FALLBACK_SECONDS_PER_CHAR = 0.5;
    // Column count of the dock's spectrum strip (the analyser is sampled into this many bands).
    const PULSE_COLUMNS = 16;

    // ------------------------------------------------------------ vocabulary --

    const MODES = ['order', 'loop', 'single', 'shuffle', 'heart'];

    /** NetEase level id → short label, shown next to the elapsed time. */
    const LEVEL_LABEL = {
      standard: '标准',
      higher: '较高',
      exhigh: '极高',
      lossless: '无损',
      hires: 'Hi-Res',
      jyeffect: '环绕',
      sky: '超清母带',
      jymaster: '高清母带',
    };

    // Playback quality is no longer user-selectable: the switcher was removed because
    // changing it made no audible difference for this account. `exhigh` is the highest
    // tier NetEase serves without a membership, so it is the one sensible default.
    const PLAY_LEVEL = 'exhigh';

    const DICT = {
      zh: {
        title: '网易云音乐',
        guide: '打开网易云音乐播放器',
        playlists: '歌单',
        search: '搜索',
        account: '账号',
        refresh: '刷新',
        loadFailed: '加载失败：{message}',
        needLogin: '登录后即可同步你的歌单与会员音质',
        goLogin: '去登录',
        account: '账号',
        accounts: '已登录账号',
        addAccount: '添加用户',
        logoutCurrent: '退出当前账号',
        close: '关闭',
        accountSwitched: '已切换到 {name}',
        accountUnavailable: '多账号切换需要重启 DSH 后生效',
        myPlaylists: '我的歌单',
        emptyPlaylists: '这里还没有歌单',
        createdBy: '{name} 创建',
        songs: '{count} 首',
        playing: '正在播放',
        nothingPlaying: '还没有正在播放的歌曲',
        hintPlay: '从歌单里挑一首开始播放',
        prev: '上一首',
        next: '下一首',
        play: '播放',
        pause: '暂停',
        volume: '音量',
        mode: '播放方式',
        order: '顺序播放',
        loop: '列表循环',
        single: '单曲循环',
        shuffle: '随机播放',
        heart: '心动模式',
        searchPlaceholder: '搜索歌曲 / 歌单 / 歌手',
        searchSong: '单曲',
        searchPlaylist: '歌单',
        searchArtist: '歌手',
        searching: '搜索中…',
        searchEmpty: '没有找到结果',
        back: '返回',
        login: '登录',
        loginPhone: '手机号登录',
        loginCookie: 'Cookie 登录',
        phone: '手机号',
        captcha: '验证码',
        sendCaptcha: '发送验证码',
        resendIn: '{seconds}s 后重发',
        captchaSent: '验证码已发送',
        cookieHint: '在浏览器登录 music.163.com，复制 document.cookie 粘贴到这里',
        cookiePlaceholder: 'MUSIC_U=...; __csrf=...',
        submit: '登录',
        loggingIn: '登录中…',
        logout: '退出登录',
        loggedOut: '已退出登录',
        nickFallback: '网易云用户',
        loadPlaylistFailed: '歌单加载失败：{message}',
        vipOnly: '需要会员：{message}',
        noUrl: '这首暂时无法播放',
        heartNeedsPlaylist: '心动模式需要从歌单里播放',
        heartFailed: '心动模式暂时不可用，已回退到随机播放',
        heartLoading: '正在生成心动歌单…',
        noCopyright: '无版权',
        vip: 'VIP',
        svip: 'SVIP',
        playFailed: '播放失败：{message}',
        requestFailed: '请求失败：{message}',
        truncated: '网易云只提供了其中 {count} 首，其余曲目无法获取',
        nowPlayingCount: '{index} / {total}',
        dockToggle: '歌词展示框',
        dockIdle: '还没有播放，去歌单里挑一首吧',
        noLyric: '纯音乐，请欣赏',
        dockSoon: '即将开始',
      },
      en: {
        title: 'NetEase Cloud Music',
        guide: 'Open the NetEase Cloud Music player',
        playlists: 'Playlists',
        search: 'Search',
        account: 'Account',
        refresh: 'Refresh',
        loadFailed: 'Could not load: {message}',
        needLogin: 'Sign in to sync your playlists and member-only quality',
        goLogin: 'Sign in',
        account: 'Account',
        accounts: 'Signed-in accounts',
        addAccount: 'Add user',
        logoutCurrent: 'Sign out of this account',
        close: 'Close',
        accountSwitched: 'Switched to {name}',
        accountUnavailable: 'Account switching needs a DSH restart',
        myPlaylists: 'My playlists',
        emptyPlaylists: 'No playlists yet',
        createdBy: 'by {name}',
        songs: '{count} tracks',
        playing: 'Now playing',
        nothingPlaying: 'Nothing is playing',
        hintPlay: 'Pick a track from a playlist to start',
        prev: 'Previous',
        next: 'Next',
        play: 'Play',
        pause: 'Pause',
        volume: 'Volume',
        mode: 'Play mode',
        order: 'In order',
        loop: 'Repeat all',
        single: 'Repeat one',
        shuffle: 'Shuffle',
        heart: 'Heartbeat',
        searchPlaceholder: 'Search tracks / playlists / artists',
        searchSong: 'Tracks',
        searchPlaylist: 'Playlists',
        searchArtist: 'Artists',
        searching: 'Searching…',
        searchEmpty: 'No results',
        back: 'Back',
        login: 'Sign in',
        loginPhone: 'Phone',
        loginCookie: 'Cookie',
        phone: 'Phone number',
        captcha: 'Code',
        sendCaptcha: 'Send code',
        resendIn: 'Resend in {seconds}s',
        captchaSent: 'Code sent',
        cookieHint: 'Sign in at music.163.com, then paste document.cookie here',
        cookiePlaceholder: 'MUSIC_U=...; __csrf=...',
        submit: 'Sign in',
        loggingIn: 'Signing in…',
        logout: 'Sign out',
        loggedOut: 'Signed out',
        nickFallback: 'NetEase user',
        loadPlaylistFailed: 'Could not load the playlist: {message}',
        vipOnly: 'Members only: {message}',
        noUrl: 'This track cannot be played right now',
        heartNeedsPlaylist: 'Heartbeat mode needs a playlist to play from',
        heartFailed: 'Heartbeat mode is unavailable — switched to shuffle',
        heartLoading: 'Building your heartbeat queue…',
        noCopyright: 'Unavailable',
        vip: 'VIP',
        svip: 'SVIP',
        playFailed: 'Playback failed: {message}',
        requestFailed: 'Request failed: {message}',
        truncated: 'NetEase only supplied {count} of them; the rest could not be fetched',
        nowPlayingCount: '{index} / {total}',
        dockToggle: 'Lyrics display',
        dockIdle: 'Nothing playing yet — pick a song from a playlist',
        noLyric: 'Instrumental',
        dockSoon: 'Up next',
      },
    };

    // ------------------------------------------------------------------ utils --

    function createTranslator() {
      let active = 'zh';
      return {
        setLocale(id) {
          active = String(id || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
        },
        t(key, params) {
          const dict = DICT[active] || DICT.zh;
          let text = dict[key] !== undefined ? dict[key] : (DICT.zh[key] !== undefined ? DICT.zh[key] : key);
          if (params) {
            for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
          }
          return text;
        },
      };
    }

    const translator = createTranslator();
    const t = (key, params) => translator.t(key, params);

    async function api(path, options = {}) {
      const url = new URL(API + path, window.location.origin);
      if (options.query) {
        for (const [key, value] of Object.entries(options.query)) {
          if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
      }
      let response;
      try {
        response = await fetch(url.toString(), {
          method: options.method || 'GET',
          headers: options.body ? { 'content-type': 'application/json' } : undefined,
          body: options.body ? JSON.stringify(options.body) : undefined,
        });
      } catch (error) {
        throw new Error(t('requestFailed', { message: (error && error.message) || error }));
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(t('requestFailed', { message: `HTTP ${response.status}` }));
      }
      if (!payload || payload.ok !== true) {
        throw new Error((payload && payload.error) || `HTTP ${response.status}`);
      }
      return payload;
    }

    function formatTime(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
      const total = Math.floor(seconds);
      const minutes = Math.floor(total / 60);
      return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }

    // --------------------------------------------------------------- lyrics --

    /** One `[mm:ss.xx]` stamp, or null for text that carries none (credits, `[00:00]`). */
    function parseStamp(text) {
      const match = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(text);
      if (!match) return null;
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      return Number(match[1]) * 60 + Number(match[2]) + fraction;
    }

    // NetEase appends its production credits as ordinary LRC lines — `[00:00.000] 作词 : 张三`,
    // and at the tail they arrive only ~0.1s apart (`钢琴 : …`, `第一小提琴 : …`). Left in the
    // timeline they flash past in under a second, which reads as the strip "jumping to the
    // next line before the previous one finished", so they are dropped outright.
    //
    // Matching used to be a prefix whitelist, which missed every instrument it did not name
    // (钢琴, 鼓手, 录音师, 弦乐编写 …) and the English/繁 forms (Lyric, Compose, 作詞). The label
    // is now "whatever precedes the colon", tested against a broad vocabulary — measured over
    // 57 real tracks this caught every credit while dropping no actual lyric.
    const CREDIT_TERMS = [
      '作词', '作詞', '作曲', '编曲', '編曲', '填词', '填詞', '词', '詞', '曲',
      'Lyric', 'Compose', 'Arrangement', 'Arranger', 'Songwriter', 'Written',
      '制作人', '製作人', '制作', '製作', '出品', '监制', '監製', 'Producer', 'Produced',
      '统筹', '統籌', '策划', '企劃', '企划', '发行', '發行', 'OP', 'SP',
      '录音', '錄音', 'Recording', 'Recorded', 'Engineer',
      '混音', 'Mix', '母带', '母帶', 'Master',
      '人声编辑', '人聲編輯', '音频编辑', '音頻編輯', '编辑', '編輯', 'Editing', 'Editor',
      '吉他', 'Guitar', '贝斯', '貝斯', 'Bass', '鼓', 'Drum', '打击乐', '打擊樂', 'Percussion',
      '键盘', '鍵盤', 'Keyboard', '钢琴', '鋼琴', 'Piano', '合成器', 'Synth',
      '弦乐', '弦樂', 'Strings', '小提琴', 'Violin', '中提琴', 'Viola', '大提琴', 'Cello',
      '低音提琴', '竖琴', '豎琴', 'Harp', '口琴', 'Harmonica',
      '长笛', '長笛', 'Flute', '萨克斯', '薩克斯', 'Saxophone', '小号', '小號', 'Trumpet',
      '长号', '長號', 'Trombone', '单簧管', '單簧管', 'Clarinet', '双簧管', '雙簧管', 'Oboe',
      '和声', '和聲', 'Harmony', '配唱', '伴唱', 'Backing', '人声', '人聲', 'Vocal',
      '封面', 'Cover', '设计', '設計', 'Design', '插画', '插畫', 'Illustration',
      '摄影', '攝影', 'Photography', '美术', '美術', 'Artwork',
      '鸣谢', '鳴謝', '感谢', '感謝', 'Thanks', '助理', 'Assistant', '编写', '編寫',
    ];

    /** The credit label of a line (`钢琴` in `钢琴 : 何秉舜`), or null if it is a lyric. */
    function creditLabel(words) {
      const colon = words.search(/[:：]/);
      if (colon <= 0) return null;
      const label = words.slice(0, colon).replace(/\s+/g, '');
      // A credit label is short and never punctuated; this keeps a sung line that merely
      // contains a colon (e.g. `他说：走吧`) out of the filter.
      if (!label || label.length > 20 || /[。！？，、；,.!?;]/.test(label)) return null;
      return CREDIT_TERMS.some((term) => label.includes(term)) ? label : null;
    }

    /**
     * The song's median singing pace in seconds per non-space character, with a
     * fallback for timelines too short to measure. Cached by timeline identity:
     * the sweep reads this on every animation frame, so recomputing the median
     * across a few hundred lines each frame would be pure waste.
     */
    let lrcPaceCache = { lines: null, pace: LRC_FALLBACK_SECONDS_PER_CHAR };
    function lrcPace(lines) {
      if (lrcPaceCache.lines === lines) return lrcPaceCache.pace;
      const rates = [];
      for (let i = 0; i < lines.length - 1; i += 1) {
        const g = lines[i + 1].time - lines[i].time;
        const c = (lines[i].words.match(/\S/g) || []).length;
        if (c > 0 && g > 0.3 && g < 30) rates.push(g / c);
      }
      rates.sort((a, b) => a - b);
      const pace = rates.length >= 4
        ? rates[Math.floor(rates.length / 2)]
        : LRC_FALLBACK_SECONDS_PER_CHAR;
      lrcPaceCache = { lines, pace };
      return pace;
    }

    /**
     * How long to sweep one LRC-only line, in seconds.
     *
     * The line gets the gap to the next stamp, *unless* that gap is a clear
     * outlier against the pace of the rest of the song — which means the gap
     * contains instrumental time rather than singing. The song's own median
     * seconds-per-character is the reference, so a slow ballad keeps its slow
     * lines and only the genuine instrumental stretches are trimmed. A final
     * floor keeps `LRC_MIN_GAP_SHARE` of the gap so a held note cannot vanish.
     */
    function lrcLineDuration(lines, index) {
      const line = lines[index];
      if (!line) return 0;
      const next = index + 1 < lines.length ? lines[index + 1].time : line.time + 4;
      const gap = Math.max(0.5, next - line.time);
      const chars = (line.words.match(/\S/g) || []).length || 1;
      const pace = lrcPace(lines);
      // A line slower than `factor` x the song's own pace is instrumental padding.
      const allowed = gap / chars <= LRC_SLOW_LINE_FACTOR * pace
        ? gap
        : Math.max(LRC_MIN_GAP_SHARE * gap, chars * LRC_SLOW_LINE_FACTOR * pace);
      return Math.max(0.3, Math.min(gap, allowed));
    }

    /**
     * Parse an LRC document into a time-ordered timeline. One physical line may
     * carry several stamps (`[00:05.00][00:09.00]副歌`) and is emitted once per
     * stamp; the result is sorted because NetEase also emits stamps out of
     * order. Untimed, credit-only and repeated lines are dropped rather than
     * breaking the strip.
     */
    function parseLrc(text) {
      if (typeof text !== 'string' || !text.trim()) return [];
      const lines = [];
      const seen = new Set();
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const stamps = [];
        let words = line;
        for (;;) {
          const next = parseStamp(words);
          if (next === null) break;
          stamps.push(next);
          words = words.slice(words.indexOf(']') + 1);
        }
        if (!stamps.length) continue;
        words = words.trim();
        if (!words || creditLabel(words)) continue;
        for (const time of stamps) {
          const key = `${time}\u0000${words}`;
          if (seen.has(key)) continue;
          seen.add(key);
          lines.push({ time, words });
        }
      }
      lines.sort((a, b) => a.time - b.time);
      return lines;
    }

    /**
     * Parse a NetEase YRC (word-level / "karaoke") document into the same
     * time-ordered shape, additionally carrying each line's syllable offsets.
     *
     * The real document looks like this (milliseconds throughout):
     *
     *   [28480,11820](28480,160,0)我(28640,420,0)带(29060,230,0)着…
     *
     * The leading `[startMs,durMs]` is the line's absolute start and sung
     * length; every following `(startMs,durMs,0)` is one syllable, whose time is
     * *absolute* milliseconds from the song's zero, not an offset from the line.
     * (Some catalogues instead emit `{ "t":…, "c":[…] }` JSON lines for the
     * credits — those carry no `(t,d)` pairs and are skipped below.)
     *
     * `syls[i].t` is normalised to *milliseconds from the line's own start*, so
     * the dock can compare it against `audio.currentTime - line.time`.
     */
    function parseYrc(text) {
      if (typeof text !== 'string' || !text.trim()) return [];
      const out = [];
      const head = /^\[(\d+),(\d+)\]/;
      const token = /\((\d+),(\d+),\d+\)([^()]*)/g;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const lead = head.exec(line);
        if (!lead) continue; /* JSON credit rows and tag lines carry no timing */
        const startMs = Number(lead[1]);
        const body = line.slice(lead[0].length);
        const syls = [];
        let match;
        token.lastIndex = 0;
        while ((match = token.exec(body))) {
          // Absolute syllable time → offset from the line's start, which is what
          // the renderer adds to `line.time` when it walks the highlight forward.
          syls.push({ t: Math.max(0, Number(match[1]) - startMs), d: Number(match[2]), text: match[3] });
        }
        if (!syls.length) continue;
        let words = '';
        for (const s of syls) words += s.text;
        if (!words.trim() || creditLabel(words)) continue;
        out.push({ time: startMs / 1000, words, syls });
      }
      out.sort((a, b) => a.time - b.time);
      return out;
    }

    /** Binary search the last line at or before `seconds`; -1 before the first one. */
    function lineIndexAt(timeline, seconds) {
      let low = 0;
      let high = timeline.length - 1;
      let found = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (timeline[mid].time <= seconds) {
          found = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return found;
    }

    /**
     * Fetch one track's lyrics, returning the LRC timeline plus the parsed YRC
     * (word-level) data when the track carries it. Both come back empty when the
     * song has none (instrumental, or a region-restricted track).
     */
    async function loadLyric(trackId) {
      try {
        const payload = await api('/lyric', { query: { id: trackId } });
        return {
          lines: parseLrc(payload.lyric || ''),
          yrc: parseYrc(payload.yrc || ''),
        };
      } catch (error) {
        return { lines: [], yrc: [] };
      }
    }

    /**
     * The strip's current themed fill colour. Read from CSS (the canvas carries
     * `color: var(--dsw-alias-brand-primary)`) so themes and skin plugins keep
     * working without a second source of truth.
     */
    function pulseColor(canvas) {
      try {
        const value = window.getComputedStyle(canvas).color;
        return value && value !== 'rgba(0, 0, 0, 0)' ? value : '#7aaaff';
      } catch {
        return '#7aaaff';
      }
    }

    /**
     * Paint the stepped spectrum area onto a canvas.
     *
     * Canvas, not an SVG path: rewriting a path's `d` every frame dirties SVG
     * geometry and costs a style recalculation per frame — measured on this
     * machine, the strip took the page from 61 to 181 style recalcs per second,
     * and on a weak integrated GPU that per-frame re-raster is what made the
     * bars stutter on busy tracks. Drawing pixels invalidates nothing outside
     * the canvas, so a frame costs one small bitmap fill.
     */
    function drawPulse(canvas, heights, color) {
      const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (!ctx) return;
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      for (let column = 0; column < PULSE_COLUMNS; column += 1) {
        // Round to device pixels so neighbouring columns meet without a seam.
        const left = Math.round((column / PULSE_COLUMNS) * width);
        const right = Math.round(((column + 1) / PULSE_COLUMNS) * width);
        const bar = Math.max(1, Math.round((heights[column] / 100) * height));
        ctx.fillRect(left, height - bar, Math.max(1, right - left), bar);
      }
    }

    /**
     * Sample the analyser straight across the strip: all bins, in frequency
     * order, left to right. This is the original behaviour the user asked to
     * restore — a plain frequency sweep with the energy (bass) at the left edge
     * and the natural decay toward the right. No bin cropping, no rotation,
     * no mirroring: what you see is the spectrum as the analyser reports it.
     */
    function pulseHeights(freq) {
      const columns = new Array(PULSE_COLUMNS);
      const bins = freq.length;
      for (let column = 0; column < PULSE_COLUMNS; column += 1) {
        const from = Math.floor((column / PULSE_COLUMNS) * bins);
        const to = Math.max(from + 1, Math.floor(((column + 1) / PULSE_COLUMNS) * bins));
        let sum = 0;
        for (let bin = from; bin < to; bin += 1) sum += freq[bin];
        const avg = sum / (to - from);
        columns[column] = Math.max(8, Math.min(100, Math.round((avg / 255) * 100)));
      }
      return columns;
    }

    function readPrefs() {
      try {
        const raw = window.localStorage.getItem(PREF_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    }

    function writePrefs(patch) {
      try {
        window.localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
      } catch {
        /* storage may be unavailable */
      }
    }

    function markAutoOpened() {
      try {
        if (window.localStorage.getItem(OPENED_KEY)) return false;
        window.localStorage.setItem(OPENED_KEY, String(Date.now()));
        return true;
      } catch {
        return false;
      }
    }

    // ------------------------------------------------------------------ icons --

    function Icon(props) {
      const { d, size = 16, fill = 'none', strokeWidth = 1.7, viewBox = '0 0 24 24', ...rest } = props;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox,
          fill,
          stroke: fill === 'none' ? 'currentColor' : 'none',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          ...rest,
        },
        h('path', { d }),
      );
    }

    const GLYPH = {
      play: { d: 'M7.5 4.8v14.4L19.5 12z', fill: 'currentColor' },
      pause: { d: 'M9.5 5v14M14.5 5v14' },
      prev: { d: 'M18.5 5.5v13L8.8 12zM5.5 5v14', fill: 'none' },
      next: { d: 'M5.5 5.5v13L15.2 12zM18.5 5v14', fill: 'none' },
      order: { d: 'M4 6h16M4 12h9M4 18h6' },
      loop: { d: 'M17 2.5l3.5 3.5L17 9.5M3.5 11V9.6A3.6 3.6 0 0 1 7.1 6H20M7 21.5L3.5 18 7 14.5M20.5 13v1.4a3.6 3.6 0 0 1-3.6 3.6H4' },
      single: { d: 'M17 2.5l3.5 3.5L17 9.5M3.5 11V9.6A3.6 3.6 0 0 1 7.1 6H20M7 21.5L3.5 18 7 14.5M20.5 13v1.4a3.6 3.6 0 0 1-3.6 3.6H4M11 14.5l1.6-1.1V18' },
      shuffle: { d: 'M16 3.5h4.5V8M4 20L20.5 3.5M20.5 16v4.5H16M14.5 14.5l6 6M4 4l4.6 4.6' },
      heart: { d: 'M20.4 5.9a5.1 5.1 0 0 0-7.2 0L12 7.1l-1.2-1.2a5.1 5.1 0 0 0-7.2 7.2l1.2 1.2L12 21.5l7.2-7.2 1.2-1.2a5.1 5.1 0 0 0 0-7.2z' },
      refresh: { d: 'M20.5 12a8.5 8.5 0 1 1-2.5-6M20.5 3.5V9h-5.5' },
      search: { d: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3' },
      back: { d: 'M15 18.5L8.5 12 15 5.5' },
      volume: { d: 'M11 5L6.5 9H3v6h3.5L11 19zM15.5 8.8a4.6 4.6 0 0 1 0 6.4M18.4 5.8a8.6 8.6 0 0 1 0 12.4' },
      logout: { d: 'M9.5 21H5.5A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3h4M16 16.5l4.5-4.5L16 7.5M20.5 12H9' },
      music: { d: 'M9.5 18V5.5l11-2V16M9.5 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20.5 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z' },
      user: { d: 'M20 21v-1.8a4.2 4.2 0 0 0-4.2-4.2H8.2A4.2 4.2 0 0 0 4 19.2V21M12 11.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2z' },
      chevron: { d: 'M9 5.5l6.5 6.5L9 18.5' },
      plus: { d: 'M12 5v14M5 12h14' },
      alert: { d: 'M12 8.5v5M12 17h.01M10.3 3.9L2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' },
      check: { d: 'M4.5 12.5l5 5 10-11' },
      close: { d: 'M6 6l12 12M18 6L6 18' },
    };

    // ------------------------------------------------------------------ style --

    const CSS = `
.wyym-root{position:relative;display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;overflow:hidden;box-sizing:border-box;padding:10px 10px 12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}
.wyym-root *,.wyym-root *::before,.wyym-root *::after{box-sizing:border-box}
.wyym-muted{color:var(--dsw-alias-label-secondary)}
.wyym-faint{color:var(--dsw-alias-label-secondary);opacity:.78}
.wyym-row{display:flex;align-items:center;gap:8px}
.wyym-col{display:flex;flex-direction:column;gap:8px;min-height:0}
/* Body region: the only part that flexes, so it owns the remaining height and scrolls. */
.wyym-main{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:10px}
/* Player bar: pinned to the bottom and never squashed by the flex container, so its
   transport row can no longer overflow and paint over the list above it. */
.wyym-player{flex:0 0 auto;display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
/* Player foot: the dock switch alone, right-aligned under the volume control. */
/* Queue position / playlist name on the left, dock switch level with it on the right. */
.wyym-playerFoot{display:flex;align-items:center;gap:8px;min-height:20px}
.wyym-playerFoot .wyym-switch{margin-left:auto}
.wyym-switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:11px}
.wyym-switch:hover{color:var(--dsw-alias-label-primary)}
.wyym-switchLabel{white-space:nowrap}
.wyym-switchTrack{position:relative;flex:0 0 auto;width:28px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);transition:background-color .14s,border-color .14s}
.wyym-switchKnob{position:absolute;top:1px;left:1px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .14s,background-color .14s}
.wyym-switchInput{position:absolute;width:1px;height:1px;margin:0;padding:0;opacity:0;pointer-events:none}
.wyym-switchInput:checked~.wyym-switchTrack{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.wyym-switchInput:checked~.wyym-switchTrack .wyym-switchKnob{background:var(--dsw-alias-bg-base);transform:translateX(12px)}
.wyym-switchInput:focus-visible~.wyym-switchTrack{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.wyym-switchTrack,.wyym-switchKnob{transition:none}}
/* Lyrics dock above the composer. It is a sibling of the composer card rather
   than a child, and nothing inside it is interactive. The negative margin eats the
   stack gap so it reads as attached to the card below it.
   The width deliberately drops the two --dsh-composer-dock-inset terms that the
   shell's own queue dock uses (and that this strip copied). The dock is a sibling
   of the composer card, and the card's own side clearance is
   --dsh-composer-side-clearance, so a strip 2x dock-inset (16px) narrower than the
   card centred itself *inside* the card's footprint: the card's 28px rounded top
   corners then poked out 16px on each side of the strip's edges (measured
   panel 312..885 against card 296..901), which reads as tabs sticking out of the
   display box. Spanning exactly the card's width removes them; measured deltas are
   now 0 on both sides. The percentage resolves against the same stack the card
   does, and --dsh-composer-card-max-width is a length, so the capping regime
   matches too. */
.wyym-dock{display:grid;grid-template-rows:0fr;box-sizing:border-box;flex:none;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance));max-width:var(--dsh-composer-card-max-width);margin:0 auto 0;padding:0;pointer-events:none;user-select:none;overflow:hidden;will-change:grid-template-rows,opacity,transform}
/* Open/close animation. The strip is never unmounted — it keeps its slot and
   animates its own height, margin, opacity and a small slide, so opening and
   closing run the exact same transition in both directions. Closed it collapses
   to zero height AND zero margin, so it occupies no space in the composer stack.
   The height is animated with grid-template-rows 0fr -> 1fr rather than a fixed
   height, because the panel must be free to grow: the lyric wraps to two, three
   or four rows as the strip narrows, and a hard-coded 48px box clipped every row
   past the second. 1fr resolves to the content's natural height, so the strip
   fits whatever the lyric needs while still animating open and shut.

   TIMING. The strip's slide and the card's corner are two segments that must run in
   sequence (see the corner rules below for why they cannot overlap), and the quality
   of the hand-off is entirely in two numbers: whether segment 2's delay equals
   segment 1's duration, and what the two easings are at the boundary.

   Both were wrong before. Timings read back from getComputedStyle:
     closing  strip .28s ease-out @0s  ->  corner .18s ease-out @.28s
     opening  corner .18s ease-out @0s ->  strip .28s ease-out @.20s
   Two faults, and they explain exactly what was reported:
     * "closing feels slow to connect" — both segments used an ease-OUT, i.e. each one
       decelerates to a stop and the next re-accelerates from rest. The hand-off is a
       beat of stillness: velocity 0 -> 0. Nothing is late, it just stops twice.
     * "opening does not connect smoothly" — same double-stop, and worse, the strip's
       delay was .20s while the corner only took .18s, so there was also a genuine
       20ms dead window where nothing on screen moved at all.

   So each direction is now a proper chain, with the delay equal to the preceding
   duration and the easings mirrored across the joint:
     closing  strip .24s ease-IN  @0s   ->  corner .16s ease-OUT @.24s
     opening  corner .16s ease-IN @0s   ->  strip .24s ease-OUT @.16s
   ease-in ends at its fastest and ease-out starts at its fastest, and the two are
   exact mirror images, so the boundary carries speed through instead of stopping:
   the strip accelerates into the moment the corner takes over, and the corner then
   decelerates into place. Same two phases, one continuous motion. Both directions
   total .40s, close to the .46s/.48s before, so the motion reads as quicker as well
   as smoother.

   The delay must be written as the literal duration of the other segment (not a
   shared token) because the browser resolves transition-delay independently of
   transition-duration; a mismatch is exactly the dead gap above. */
.wyym-dock[data-open=true]{grid-template-rows:1fr;margin-bottom:calc(0px - var(--dsh-composer-stack-gap) - 3px);opacity:1;transform:translateY(0);transition:grid-template-rows .24s cubic-bezier(0,0,.58,1) .16s,margin-bottom .24s cubic-bezier(0,0,.58,1) .16s,opacity .24s cubic-bezier(0,0,.58,1) .16s,transform .24s cubic-bezier(0,0,.58,1) .16s}
.wyym-dock[data-open=false]{grid-template-rows:0fr;margin-bottom:0;opacity:0;transform:translateY(6px);transition:grid-template-rows .24s cubic-bezier(.42,0,1,1),margin-bottom .24s cubic-bezier(.42,0,1,1),opacity .24s cubic-bezier(.42,0,1,1),transform .24s cubic-bezier(.42,0,1,1)}
/* min-height:0 + overflow:hidden is what lets the grid row collapse to zero and
   expand to the content height. The padding deliberately lives on the panel
   *inside* this clip element rather than on the clip itself: a grid item's own
   vertical padding cannot shrink, so putting it here left a ~14px sliver on
   screen with the strip "closed" (measured), while nesting it one level deeper
   collapses cleanly to the border. */
.wyym-dockClip{min-height:0;overflow:hidden}
.wyym-dockPanel{position:relative;isolation:isolate;display:flex;align-items:center;gap:12px;padding:7px 12px;border-radius:var(--dsw-radius-panel) var(--dsw-radius-panel) 0 0;overflow:hidden}
.wyym-dockPanel:before{content:'';position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-alias-bg-layer-1)}
.wyym-dockPanel:after{content:'';position:absolute;inset:0;z-index:-1;border:.5px solid var(--dsw-alias-border-l2);border-bottom:none;border-radius:inherit}
/* The strip must not leave a notch where it meets the composer card.
   The strip is a rounded-top / square-bottom slab sitting exactly on the card's top
   edge, and the card keeps its own 28px top corners. The two shapes therefore meet at
   a corner that disagrees: measured, the card's painted left edge at its first row is
   318.7px (296 + a 22.7px arc inset) while the strip's is 296px, so a wedge of page
   background shows through at each end — the card's shoulders read as cut-outs under
   the strip. Squaring the card's two TOP corners while the strip is attached makes the
   outline continuous: rounded at the very top (strip), straight down both sides, then
   the card's rounded BOTTOM corners are untouched. Only the top two are overridden, so
   the card still looks like a card once the strip is gone.
   GEOMETRY: the notch is exactly as tall as the radius is wide. So a non-zero card
   radius and a visible strip can never coexist — whatever the timing, that pair of
   states draws a wedge of background at each end. Animating the radius alongside the
   strip's collapse (an earlier attempt: same .28s, same easing) fails for this reason,
   not for a timing reason; measured mid-close it still had the strip 9.2px tall while
   the radius was already 22.6px, i.e. a 22.6px notch.
   So the radius is not animated *during* the slide. It is animated in a slot of its own,
   and the two phases are pinned end to end, which is what makes the change read as
   smooth rather than as a snap:
     - opening  -> the corner rounds off FIRST (.18s, no delay). The strip's expansion is
                   held back by the same .2s on the open rule, so the corner is already
                   square before any height appears. Nothing to notch against.
     - closing  -> the strip collapses first (.28s, no delay). Only then does the radius
                   transition back to the card's own 28px, which is why the base rule
                   carries a .28s delay. By the time it is non-zero the strip is gone.
   That .2s on the open rule is the piece that removes the "abrupt" feel: previously the
   square-off was an instant flip and then the strip jumped open on the very next frame,
   so the two changes landed together. Now each is a real .18s/.28s ease, and they run in
   sequence, so an open is corner-rounds -> strip-grows and a close is strip-shrinks ->
   corner-rounds.
   Only the radius is conditional on the open state; the transition is declared
   unconditionally so it is still in effect on the frame the attribute flips.
   The card is reached through the composer stack rather than by class name: the dock's
   own parent is a display:contents slot host (so the card is not a sibling the dock can
   select), and the shell's class names are content-hashed. div:has(> * > .wyym-dock)
   names the stack structurally, and [data-composer-card] is the shell's own stable hook.
   NOTE: this replaces the card's own transition:all (which resolves to a 0s duration
   today, so nothing else was animating) with just these two radii. */
div:has(> * > .wyym-dock) [data-composer-card=true]{transition:border-top-left-radius .16s cubic-bezier(0,0,.58,1) .24s,border-top-right-radius .16s cubic-bezier(0,0,.58,1) .24s}
div:has(> * > .wyym-dock[data-open=true]) [data-composer-card=true]{border-top-left-radius:0;border-top-right-radius:0;transition:border-top-left-radius .16s cubic-bezier(.42,0,1,1),border-top-right-radius .16s cubic-bezier(.42,0,1,1)}
.wyym-dockLead{display:flex;align-items:center;gap:10px;min-width:0;flex:0 0 auto;max-width:46%}
.wyym-dockCover{flex:0 0 auto;width:34px;height:34px;border-radius:7px;background:var(--dsw-alias-bg-layer-2) center/cover no-repeat;object-fit:cover;overflow:hidden}
.wyym-dockMeta{display:flex;flex-direction:column;justify-content:center;min-width:0}
.wyym-dockTitle{font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wyym-dockArtist{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The three modules are laid out side by side and each one is responsible for
   its own overflow. .wyym-dockLyrics stretches its children (not center):
   with align-items:center the line box shrinks to its *content* width, so a
   long line measured 461px inside a 300px column and painted straight over the
   title and the visualiser. stretch plus overflow:hidden keeps every module
   inside its own box. */
.wyym-dockLyrics{display:flex;flex-direction:column;justify-content:center;align-items:stretch;text-align:center;gap:1px;flex:1 1 auto;min-width:0;overflow:hidden}
/* The lyric wraps instead of being truncated, so a narrow strip shows the whole
   line over several rows rather than an ellipsis. */
.wyym-dockLine{position:relative;font-size:12.5px;line-height:17px;color:var(--dsw-alias-label-primary);overflow:hidden;white-space:normal;text-align:center;transition:color .18s,opacity .18s}
/* The current line mounts as a fresh node (keyed by its index) and slides UP
   from below while fading in, so a line change reads as a transition. */
.wyym-dockLine-enter{animation:wyym-dockLineIn .4s cubic-bezier(.22,.61,.36,1) both}
@keyframes wyym-dockLineIn{from{opacity:0;transform:translateY(17px)}to{opacity:1;transform:translateY(0)}}
/* Karaoke sweep, drawn one *syllable* at a time rather than as one clipped copy
   of the whole line.
   Why per-syllable: the strip has to wrap (a narrow composer must not push the
   lyric over the title or the visualiser), and a single clip-path on a wrapped
   block cannot work — inset(0 X% 0 0) reveals the left X% of *every row at
   once*, so the highlight appears as a vertical stripe across the paragraph
   instead of running through the words in reading order.
   Each syllable is therefore its own inline-grid cell holding two stacked
   copies of the same text (base + accent); the accent copy is clipped
   left-to-right as that syllable is sung. Because both copies live in the same
   grid cell they are laid out identically by the browser, so the edge always
   sits on a real glyph boundary — no font measurement, no canvas, no drift.
   IMPORTANT: --dsw-alias-brand-primary is NOT an accent colour in this design
   system — it resolves to exactly the same value as --dsw-alias-label-primary
   (near-black in the light theme, near-white in the dark one). Painting the
   sung layer with it made the highlight literally the same colour as the unsung
   text, which is why it only ever read as a faint weight difference.
   --dsw-alias-link is genuinely distinct in both themes, and the emphasis is
   carried by colour + glow rather than stroke weight, so the two layers keep
   identical metrics and the edge cannot drift. */
.wyym-dockKaraoke{display:inline;white-space:normal;word-break:break-word}
.wyym-dockSeg{display:inline-grid;white-space:pre;vertical-align:baseline}
.wyym-dockSeg>*{grid-area:1/1;min-width:0}
.wyym-dockSegBase{color:var(--dsw-alias-label-secondary);opacity:.55}
.wyym-dockSegFill{color:var(--dsw-alias-link,#4176e6);clip-path:inset(0 100% 0 0)}
.wyym-dockLine.is-idle{color:var(--dsw-alias-label-secondary)}
/* Spectrum strip: a filled area rather than a bare line, pinned to the right edge.
   Wide enough to actually read as a spectrum, and fluid so it takes more room on
   a wide composer without ever pushing into the lyric column. */
.wyym-dockPulse{position:relative;display:flex;align-items:center;justify-content:center;flex:0 1 auto;width:clamp(88px,11%,150px);min-width:64px;height:30px;overflow:hidden}
.wyym-dockPulseCanvas{position:relative;display:block;width:100%;height:28px;color:var(--dsw-alias-brand-primary);opacity:.5}
.wyym-dockPulse[data-playing=false] .wyym-dockPulseCanvas{opacity:.22}
@media (prefers-reduced-motion:reduce){
/* Must beat .wyym-dock[data-open=...] (specificity 0,2,0), which is where the
   open/close transitions are declared — a bare .wyym-dock here is 0,1,0 and loses. */
.wyym-dock[data-open=true],.wyym-dock[data-open=false]{transition:none}
.wyym-dockLine-enter{animation:none}
div:has(> * > .wyym-dock) [data-composer-card=true],
div:has(> * > .wyym-dock[data-open=true]) [data-composer-card=true]{transition:none}
}
/* On a narrow strip only the decorative cover steps aside. The title/artist stay:
   they are one of the three modules the strip is made of, and dropping them would
   leave the lyric sharing the row with nothing. A long title already truncates
   with an ellipsis inside its own column, and the lyric column wraps, so the three
   modules stay separate at every width (measured down to 340px: no overlap). */
@media (max-width:720px){.wyym-dockCover{display:none}}
.wyym-grow{flex:1 1 auto;min-width:0}
.wyym-scroll{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;margin:0 -4px;padding:0 4px}
.wyym-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:4px 9px;min-height:26px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;white-space:nowrap}
.wyym-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wyym-btn:disabled{opacity:.5;cursor:default}
.wyym-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.wyym-iconbtn{padding:0;width:28px;height:28px;min-height:28px;border-color:transparent;background:transparent}
.wyym-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wyym-iconbtn.is-on{color:var(--dsw-alias-brand-primary)}
.wyym-fbtn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:36px;height:36px;min-height:36px;padding:0;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;transition:background-color .12s,color .12s}
.wyym-fbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wyym-fbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.wyym-fbtn.is-on{color:var(--dsw-alias-brand-primary)}
@media (prefers-reduced-motion:reduce){.wyym-fbtn{transition:none}}
.wyym-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.wyym-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.88}
.wyym-play{width:38px;height:38px;min-height:38px;border-radius:50%;padding:0;border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.wyym-play:hover:not(:disabled){opacity:.88;background:var(--dsw-alias-brand-primary)}
.wyym-seg{display:flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.wyym-seg>button{flex:1 1 0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;padding:3px 6px;border-radius:6px;cursor:pointer}
.wyym-seg>button[aria-selected=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}
.wyym-seg>button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wyym-input,.wyym-select{width:100%;min-height:28px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.wyym-select{cursor:pointer}
.wyym-input:focus-visible,.wyym-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wyym-textarea{width:100%;min-height:56px;resize:vertical;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.wyym-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px}
.wyym-now{display:flex;gap:10px;align-items:center;flex:0 0 auto;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.wyym-cover{width:46px;height:46px;border-radius:8px;flex:0 0 auto;object-fit:cover;background:var(--dsw-alias-bg-layer-2);display:block}
.wyym-cover-sm{width:38px;height:38px;border-radius:6px;flex:0 0 auto;object-fit:cover;background:var(--dsw-alias-bg-layer-2);display:block}
.wyym-cover-lg{width:64px;height:64px;border-radius:10px;flex:0 0 auto;object-fit:cover;background:var(--dsw-alias-bg-layer-2);display:block}
.wyym-title{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wyym-sub{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.wyym-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.wyym-item{display:flex;align-items:center;gap:8px;width:100%;padding:5px 6px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.wyym-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wyym-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.wyym-item[data-active=true]{background:var(--dsw-alias-bg-multi-select);color:var(--dsw-alias-brand-primary)}
.wyym-item[disabled]{opacity:.55;cursor:default}
.wyym-index{width:22px;flex:0 0 auto;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.wyym-range{width:100%;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.wyym-range:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.wyym-banner{display:flex;align-items:flex-start;gap:6px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.wyym-banner[data-kind=error]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.wyym-banner[data-kind=ok]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.wyym-badge{display:inline-block;padding:0 4px;border-radius:4px;border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-size:10px;line-height:15px;vertical-align:middle}
.wyym-tag{font-size:10px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.wyym-empty{padding:22px 10px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary)}
.wyym-head{display:flex;align-items:center;gap:8px}
.wyym-account{position:relative;display:flex;min-width:0}
.wyym-accountBtn{display:flex;align-items:center;gap:6px;min-width:0;max-width:196px;padding:3px 6px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.wyym-accountBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wyym-accountBtn[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}
.wyym-accountBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wyym-accountBtn .wyym-chevron{transform:rotate(90deg);transition:transform .14s;color:var(--dsw-alias-label-secondary)}
.wyym-accountBtn[aria-expanded=true] .wyym-chevron{transform:rotate(-90deg)}
.wyym-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:30;min-width:238px;max-width:280px;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv3)}
.wyym-menuTitle{padding:4px 8px 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.wyym-menuItem{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.wyym-menuItem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wyym-menuItem.is-active{background:var(--dsw-alias-interactive-bg-hover)}
.wyym-menuItem:disabled{cursor:default}
.wyym-menuItem:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.wyym-menuAvatar{width:22px;height:22px;border-radius:50%;object-fit:cover;flex:0 0 auto;background:var(--dsw-alias-bg-layer-2)}
.wyym-menuSep{height:1px;margin:5px 4px;background:var(--dsw-alias-border-l1)}
.wyym-menuNote{padding:4px 8px 2px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.wyym-overlay{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--dsw-alias-bg-mask-1)}
.wyym-modal{display:flex;flex-direction:column;gap:10px;width:100%;max-width:340px;max-height:100%;overflow:auto;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv3)}
.wyym-avatar{width:22px;height:22px;border-radius:50%;object-fit:cover;background:var(--dsw-alias-bg-layer-2)}
.wyym-spin{animation:wyym-spin 1s linear infinite}
@keyframes wyym-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.wyym-spin{animation:none}}
`;

    // ------------------------------------------------------------------ store --

    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        getState: () => state,
        set(patch) {
          const next = typeof patch === 'function' ? patch(state) : patch;
          // Skip the notify entirely when the patch changes nothing: the karaoke sweep
          // and the clock both commit the same value repeatedly (a lyricIndex that has
          // not moved, a whole-second position). Letting those through would wake every
          // subscriber — and re-render the whole panel — for no reason.
          let changed = false;
          for (const key of Object.keys(next)) {
            if (state[key] !== next[key]) {
              changed = true;
              break;
            }
          }
          if (!changed) return;
          state = { ...state, ...next };
          for (const listener of [...listeners]) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    function useStore(store) {
      const [snapshot, setSnapshot] = useState(store.getState);
      useEffect(() => store.subscribe(() => setSnapshot(store.getState())), [store]);
      return snapshot;
    }

    // ----------------------------------------------------------------- player --

    function createPlayer(store) {
      let audio = null;
      let audioContext = null;
      let analyser = null;
      let sourceNode = null;
      let playToken = 0;
      let heartPool = [];
      let lyricToken = 0;
      let clockTimer = null;
      let clockSeconds = -1;
      // A seek is in flight. `seeked` fires as soon as the jump is *issued* — measured:
      // it arrives while `audio.currentTime` still reports the pre-seek spot (notably on
      // Windows, where the media pipeline lags the instruction), so the next
      // timeupdate/clockTick would write that stale reading back into the store and snap
      // the scrubber to the start of the song. The guard therefore ignores element
      // readings until the clock has actually moved onto (or past) the chosen spot, with
      // a deadline so a genuinely stalled element cannot freeze the progress bar forever.
      let seekTarget = -1;
      let seekStartedAt = 0;
      function positionUsable() {
        if (seekTarget < 0) return true;
        if (Date.now() - seekStartedAt > 5000) { seekTarget = -1; return true; }
        return false;
      }
      function positionArrived(seconds) {
        if (seekTarget < 0) return;
        if (seconds >= seekTarget - 1.5 || Date.now() - seekStartedAt > 5000) seekTarget = -1;
      }

      /**
       * Ten commits a second while a line is actually being sung, so the active
       * lyric lands on time; every other state (idle, paused, a long instrumental
       * gap) stays on the panel's own once-per-second audio commits.
       */
      function clockTick() {
        if (!audio || audio.paused) return;
        const state = store.getState();
        const lines = state.lyrics;
        if (!lines.length) return;
        // Switch on the sound the user actually hears, not the element clock:
        // playback is buffered through the AudioContext, so `currentTime` runs
        // ahead and using it raw advances every line slightly early.
        const now = Math.max(0, audio.currentTime - outputLatencyMs() / 1000);
        const index = lineIndexAt(lines, now);
        // Switch lines strictly at their time boundaries. A line shows the instant
        // the song reaches it (no earlier guess), and we leave it up exactly until
        // the next line's stamp — so fast songs change fast and slow songs change
        // slow, locked to the real timestamps instead of a fixed hold.
        const target = index < 0 ? -1 : index;
        if (target !== state.lyricIndex) {
          // A plain forward step lands here; give it a 200ms floor so two stamps
          // sitting almost on top of each other cannot make the line flicker.
          // A seek (jumping backwards or skipping lines) is not a forward step,
          // so it applies at once and the strip follows the scrubber.
          const forward = state.lyricIndex >= 0 && target === state.lyricIndex + 1;
          const shownFor = state.lyricIndex >= 0 ? now - lines[Math.max(0, state.lyricIndex)].time : Infinity;
          if (!forward || shownFor >= 0.2) {
            store.set({ lyricIndex: target });
          }
        }
        const seconds = Math.floor(now);
        if (seconds === clockSeconds) return;
        clockSeconds = seconds;
        // While a seek is still settling, the element clock reports the pre-seek spot;
        // writing it here is exactly the snap-back. Wait until it reaches the target.
        if (!positionUsable()) return;
        positionArrived(now);
        store.set({ position: now });
      }

      function syncClock() {
        const wanted = Boolean(audio) && !audio.paused && store.getState().lyrics.length > 0;
        if (wanted === (clockTimer !== null)) return;
        if (wanted) {
          clockSeconds = -1;
          clockTimer = window.setInterval(clockTick, LYRIC_POLL_MS);
        } else {
          window.clearInterval(clockTimer);
          clockTimer = null;
        }
      }

      function ensureAudio() {
        if (audio) return audio;
        audio = new Audio();
        audio.preload = 'auto';
        audio.volume = store.getState().volume;
        // Tap the audio output so the dock's pulse can react to the real song.
        // A shared AudioContext/AnalyserNode is attached once; the dock reads it
        // through `getAudio()` and drives the bars straight off getByteFrequencyData.
        try {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (Ctor) {
            if (!audioContext) audioContext = new Ctor();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 64;
            analyser.smoothingTimeConstant = 0.78;
            sourceNode = audioContext.createMediaElementSource(audio);
            sourceNode.connect(analyser);
            analyser.connect(audioContext.destination);
          }
        } catch (error) {
          analyser = null;
          sourceNode = null;
        }
        audio.addEventListener('timeupdate', () => {
          // One store commit per second keeps the progress bar honest without
          // re-rendering the whole panel on every audio frame.
          if (Math.floor(audio.currentTime) !== Math.floor(store.getState().position)) {
            // A settling seek must not be overwritten by the stale pre-seek reading,
            // or the scrubber snaps back to the start (measured on Windows).
            if (!positionUsable()) return;
            positionArrived(audio.currentTime);
            store.set({ position: audio.currentTime });
          }
        });
        audio.addEventListener('durationchange', () =>
          store.set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 }),
        );
        audio.addEventListener('play', () => {
          // The AudioContext opens suspended until a user gesture; resume it so
          // the analyser actually receives signal once playback starts.
          if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
          }
          store.set({ playing: true });
          syncClock();
        });
        audio.addEventListener('pause', () => {
          store.set({ playing: false });
          syncClock();
        });
        audio.addEventListener('waiting', () => store.set({ loading: true }));
        // The media pipeline has finished the jump: the element clock is trustworthy again.
        // Note: `seeked` intentionally does NOT clear the guard — it fires while the
        // element clock still reads the pre-seek position, which is exactly the stale
        // reading the guard exists to drop. `positionArrived` clears it once the clock
        // reaches the chosen spot (or the 5s deadline expires).
        audio.addEventListener('playing', () => {
          store.set({ loading: false, error: '' });
          syncClock();
        });
        audio.addEventListener('ended', () => {
          advance(true);
        });
        audio.addEventListener('error', () => {
          if (!audio.currentSrc) return;
          store.set({ loading: false, playing: false, error: t('noUrl') });
        });
        return audio;
      }

      function release() {
        if (clockTimer !== null) {
          window.clearInterval(clockTimer);
          clockTimer = null;
        }
        if (!audio) return;
        try {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        } catch {
          /* nothing to release */
        }
        try {
          if (sourceNode) sourceNode.disconnect();
          if (analyser) analyser.disconnect();
        } catch {
          /* nothing to release */
        }
        audio = null;
        analyser = null;
        sourceNode = null;
        if (audioContext && audioContext.state !== 'closed') {
          audioContext.close().catch(() => {});
          audioContext = null;
        }
        heartPool = [];
      }

      function pickShuffleIndex(length, current) {
        if (length <= 1) return 0;
        let next = current;
        while (next === current) next = Math.floor(Math.random() * length);
        return next;
      }

      /** Adopt lyrics only if the track they belong to is still the current one. */
      async function loadLyrics(track) {
        const token = ++lyricToken;
        const data = await loadLyric(track.id);
        if (token !== lyricToken) return;
        const state = store.getState();
        if (!state.current || state.current.id !== track.id) return;
        // When the track ships word-level (YRC) data, build the timeline from it
        // outright: YRC carries its own text, line start AND per-syllable times,
        // and its millisecond marks are the authoritative karaoke clock. The LRC
        // document is centisecond-rounded and, on tracks with repeated hooks, can
        // sit seconds away from where the line is actually sung (measured: 6.2s on
        // one chorus), so pairing the two and trusting the LRC time is what made
        // the highlight miss the beat. Using YRC directly keeps every syllable on
        // the audio clock; tracks without YRC keep the plain LRC timeline.
        const lines = data.yrc.length
          ? data.yrc.map((y) => ({ time: y.time, words: y.words, syls: y.syls }))
          : data.lines;
        store.set({ lyrics: lines, lyricIndex: lines.length ? lineIndexAt(lines, state.position) : -1 });
        syncClock();
      }

      async function start(track, options = {}) {
        if (!track) return;
        const token = ++playToken;
        store.set({ current: track, loading: true, error: '', position: 0, duration: 0, lyrics: [], lyricIndex: -1 });
        void loadLyrics(track);
        const level = store.getState().quality;
        let entry = null;
        try {
          const payload = await api('/song/url', { method: 'POST', body: { ids: [track.id], level } });
          entry = Array.isArray(payload.songs) ? payload.songs[0] : null;
        } catch (error) {
          if (token !== playToken) return;
          store.set({ loading: false, playing: false, error: error.message });
          return;
        }
        if (token !== playToken) return;
        if (!entry || !entry.url) {
          const message = entry && entry.freeTrial ? t('vipOnly', { message: t('noUrl') }) : t('noUrl');
          store.set({ loading: false, playing: false, error: message, actualLevel: null });
          if (options.autoplay === false) return;
          if (store.getState().mode === 'single') return;
          scheduleAdvance(1400);
          return;
        }
        const element = ensureAudio();
        element.src = `${API}/audio?src=${encodeURIComponent(entry.url)}`;
        store.set({
          actualLevel: entry.level || level,
          actualBr: entry.br || 0,
          loading: true,
        });
        if (options.autoplay === false) {
          store.set({ loading: false });
          return;
        }
        try {
          await element.play();
        } catch (error) {
          if (token !== playToken) return;
          store.set({
            loading: false,
            playing: false,
            error: t('playFailed', { message: (error && error.message) || error }),
          });
        }
      }

      let advanceTimer = null;
      function scheduleAdvance(delay) {
        if (advanceTimer) window.clearTimeout(advanceTimer);
        advanceTimer = window.setTimeout(() => {
          advanceTimer = null;
          advance(true);
        }, delay);
      }

      function playQueue(tracks, index, origin) {
        const list = Array.isArray(tracks) ? tracks.filter(Boolean) : [];
        if (!list.length) return;
        const safeIndex = Math.max(0, Math.min(index, list.length - 1));
        heartPool = [];
        store.set({ queue: list, index: safeIndex, origin: origin || null, notice: '', error: '' });
        void start(list[safeIndex]);
      }

      async function heartQueue(seed) {
        const state = store.getState();
        const playlistId = state.origin && state.origin.playlistId;
        if (!playlistId) {
          store.set({ notice: t('heartNeedsPlaylist'), mode: 'shuffle' });
          writePrefs({ mode: 'shuffle' });
          return null;
        }
        store.set({ notice: t('heartLoading') });
        try {
          const payload = await api('/intelligence', { query: { pid: playlistId, sid: seed.id } });
          const tracks = (payload.tracks || []).filter((item) => item && item.id && item.id !== seed.id);
          if (!tracks.length) throw new Error('empty');
          return tracks;
        } catch {
          store.set({ notice: t('heartFailed'), mode: 'shuffle' });
          writePrefs({ mode: 'shuffle' });
          return null;
        }
      }

      async function advance(auto) {
        const state = store.getState();
        const list = state.queue;
        if (!list.length) return;
        if (state.mode === 'single' && auto) {
          void start(list[state.index]);
          return;
        }
        if (state.mode === 'heart') {
          if (!heartPool.length) {
            const seed = state.current || list[state.index];
            const generated = await heartQueue(seed);
            if (!generated) {
              advance(auto);
              return;
            }
            heartPool = generated;
          }
          const nextTrack = heartPool.shift();
          store.set({ index: Math.min(state.index + 1, list.length - 1), current: nextTrack, notice: '' });
          void start(nextTrack, { keepHeart: true });
          return;
        }
        let index;
        if (state.mode === 'shuffle') index = pickShuffleIndex(list.length, state.index);
        else index = state.index + 1;
        if (index >= list.length) {
          if (state.mode === 'order' && auto) {
            store.set({ playing: false, notice: '' });
            return;
          }
          index = 0;
        }
        store.set({ index, notice: '' });
        void start(list[index]);
      }

      function previous() {
        const state = store.getState();
        const list = state.queue;
        if (!list.length) return;
        const index = state.index > 0 ? state.index - 1 : list.length - 1;
        store.set({ index, notice: '' });
        void start(list[index]);
      }

      /**
       * How far the sound actually leaving the speakers lags the element's own
       * `currentTime`, in milliseconds.
       *
       * Playback is routed through an AudioContext (`createMediaElementSource →
       * analyser → destination`), which buffers the audio before it reaches the
       * output. `audio.currentTime` still advances on the element's own clock, so
       * it runs ahead of what the listener hears; comparing syllables against it
       * directly puts the highlight early. `outputLatency` (or `baseLatency`) is
       * the browser's own measurement of that gap.
       */
      function outputLatencyMs() {
        if (!audioContext) return 0;
        const value =
          typeof audioContext.outputLatency === 'number' && audioContext.outputLatency > 0
            ? audioContext.outputLatency
            : typeof audioContext.baseLatency === 'number'
              ? audioContext.baseLatency
              : 0;
        return Number.isFinite(value) ? Math.max(0, value * 1000) : 0;
      }

      return {
        ensureAudio,
        release,
        // Hand the dock the live audio + analyser so it can drive the pulse and
        // the karaoke sweep straight off the real signal, without polling the
        // store every frame — plus the output latency, so the highlight can be
        // lined up with the sound the user actually hears instead of the element
        // clock that runs ahead of it.
        getAudio: () =>
          audio && !audio.paused
            ? { audio, analyser, latencyMs: outputLatencyMs() }
            : { audio: null, analyser: null, latencyMs: 0 },
        start,
        playQueue,
        next: () => void advance(false),
        prev: previous,
        toggle() {
          const state = store.getState();
          if (!state.current) {
            if (state.queue.length) {
              void start(state.queue[state.index] || state.queue[0]);
              return;
            }
            if (state.playlist && state.playlist.tracks.length) {
              playQueue(state.playlist.tracks, 0, {
                playlistId: state.playlist.info.id,
                playlistName: state.playlist.info.name,
              });
            }
            return;
          }
          const element = ensureAudio();
          if (state.playing) element.pause();
          else void element.play().catch(() => store.set({ playing: false }));
        },
        seek(seconds) {
          if (!audio) return;
          try {
            // Arm the guard *before* touching the element: the very next timeupdate can
            // still carry the pre-seek position (seeked alone does not mean the clock
            // has moved — measured it fires while currentTime still reads the old spot).
            seekTarget = seconds;
            seekStartedAt = Date.now();
            audio.currentTime = seconds;
            store.set({ position: seconds });
            const state = store.getState();
            if (state.lyrics.length) store.set({ lyricIndex: lineIndexAt(state.lyrics, seconds) });
          } catch {
            /* not seekable yet */
            seekTarget = -1;
          }
        },
        setVolume(value) {
          const volume = Math.max(0, Math.min(1, value));
          store.set({ volume });
          if (audio) audio.volume = volume;
          writePrefs({ volume });
        },
        setMode(mode) {
          heartPool = [];
          const valid = MODES.includes(mode) ? mode : 'order';
          store.set({ mode: valid, notice: '' });
          writePrefs({ mode: valid });
        },
        setDock(enabled) {
          const dock = Boolean(enabled);
          store.set({ dock });
          writePrefs({ dock });
        },
      };
    }

    async function loadStatus(store) {
      store.set({ booting: true, error: '' });
      try {
        const payload = await api('/status');
        store.set({
          booting: false,
          loggedIn: Boolean(payload.loggedIn),
          profile: payload.profile || null,
          // Absent on a Host that predates multi-account support; the picker then
          // degrades to showing just the signed-in account.
          accounts: Array.isArray(payload.accounts) ? payload.accounts : [],
          activeUserId: typeof payload.activeUserId === 'number' ? payload.activeUserId : null,
        });
      } catch (error) {
        store.set({ booting: false, error: error.message });
      }
    }

    async function loadPlaylists(store) {
      store.set({ playlistsLoading: true, error: '' });
      try {
        const payload = await api('/playlists');
        store.set({ playlistsLoading: false, playlists: payload.playlists || [] });
      } catch (error) {
        store.set({ playlistsLoading: false, error: error.message });
      }
    }

    async function openPlaylist(store, player, playlist) {
      store.set({ view: 'tracks', playlist: null, playlistLoading: true, error: '', notice: '' });
      try {
        const payload = await api('/playlist', { query: { id: playlist.id } });
        store.set({
          playlistLoading: false,
          playlist: { info: payload.info, tracks: payload.tracks || [], truncated: Boolean(payload.truncated) },
          notice: payload.truncated ? t('truncated', { count: (payload.tracks || []).length }) : '',
        });
      } catch (error) {
        store.set({ playlistLoading: false, error: t('loadPlaylistFailed', { message: error.message }) });
      }
    }

    // ------------------------------------------------------------ components --

    function Banner({ kind, children, onClose }) {
      return h(
        'div',
        { className: 'wyym-banner', 'data-kind': kind || 'info', role: kind === 'error' ? 'alert' : 'status' },
        h(Icon, { d: GLYPH.alert.d, size: 14, style: { flex: '0 0 auto', marginTop: '1px' } }),
        h('span', { className: 'wyym-grow' }, children),
        onClose
          ? h(
              'button',
              { type: 'button', className: 'wyym-btn wyym-iconbtn', onClick: onClose, 'aria-label': 'dismiss' },
              h('span', { 'aria-hidden': 'true' }, '×'),
            )
          : null,
      );
    }

    function ModeIcon({ mode, size }) {
      const glyph = GLYPH[mode] || GLYPH.order;
      return h(Icon, { d: glyph.d, fill: glyph.fill || 'none', size });
    }

    function NowPlaying({ store, player }) {
      const state = useStore(store);
      const track = state.current;
      const duration = state.duration || (track ? track.duration / 1000 : 0);
      // The mode list is plain ids; labels come from the dictionary (keys `order`,
      // `loop`, …) so an English UI does not get Chinese mode names — the labels used
      // to be hardcoded here while their translations sat unused in DICT.
      const modeId = MODES.includes(state.mode) ? state.mode : MODES[0];
      const modeLabel = t(modeId);
      const actual = state.actualLevel ? LEVEL_LABEL[state.actualLevel] : '';
      return h(
        'div',
        { className: 'wyym-player' },
        h(
          'div',
          { className: 'wyym-now' },
          track && track.cover
            ? h('img', { className: 'wyym-cover', src: track.cover, alt: '', loading: 'lazy' })
            : h('div', { className: 'wyym-cover', 'aria-hidden': 'true' }),
          h(
            'div',
            { className: 'wyym-grow' },
            h('div', { className: 'wyym-title' }, track ? track.name : t('nothingPlaying')),
            h('div', { className: 'wyym-sub' }, track ? track.artists : t('hintPlay')),
            track && track.album ? h('div', { className: 'wyym-sub wyym-faint' }, track.album) : null,
          ),
          state.loading
            ? h(Icon, { d: GLYPH.refresh.d, size: 14, className: 'wyym-spin', style: { flex: '0 0 auto' } })
            : null,
        ),
        h('input', {
          className: 'wyym-range',
          type: 'range',
          min: 0,
          max: Math.max(1, Math.round(duration)),
          step: 1,
          value: Math.min(Math.round(state.position), Math.max(1, Math.round(duration))),
          onChange: (event) => player.seek(Number(event.target.value)),
          'aria-label': t('playing'),
          disabled: !track,
        }),
        h(
          'div',
          { className: 'wyym-row' },
          h('span', { className: 'wyym-faint', style: { fontVariantNumeric: 'tabular-nums' } }, formatTime(state.position)),
          h('span', { className: 'wyym-grow' }),
          h(
            'span',
            { className: 'wyym-faint', style: { fontVariantNumeric: 'tabular-nums' } },
            actual && state.actualBr ? `${actual} · ${Math.round(state.actualBr / 1000)}kbps` : formatTime(duration),
          ),
        ),
        h(
          'div',
          { className: 'wyym-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'wyym-btn wyym-iconbtn',
              title: `${t('mode')}：${modeLabel}`,
              onClick: () => {
                const index = MODES.indexOf(modeId);
                player.setMode(MODES[(index + 1) % MODES.length]);
              },
              'aria-label': `${t('mode')}：${modeLabel}`,
            },
            h(ModeIcon, { mode: state.mode, size: 16 }),
          ),
          h('span', { className: 'wyym-faint', style: { fontSize: '11px' } }, modeLabel),
          h('span', { className: 'wyym-grow' }),
          h(
            'button',
            { type: 'button', className: 'wyym-btn wyym-iconbtn', onClick: player.prev, title: t('prev'), 'aria-label': t('prev') },
            h(Icon, { d: GLYPH.prev.d, size: 16 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wyym-btn wyym-play',
              onClick: player.toggle,
              title: state.playing ? t('pause') : t('play'),
              'aria-label': state.playing ? t('pause') : t('play'),
              disabled: !track && !state.queue.length && !(state.playlist && state.playlist.tracks.length),
            },
            h(Icon, { d: state.playing ? GLYPH.pause.d : GLYPH.play.d, fill: state.playing ? 'none' : 'currentColor', size: 18 }),
          ),
          h(
            'button',
            { type: 'button', className: 'wyym-btn wyym-iconbtn', onClick: player.next, title: t('next'), 'aria-label': t('next') },
            h(Icon, { d: GLYPH.next.d, size: 16 }),
          ),
          h('span', { className: 'wyym-grow' }),
          h(
            'label',
            { className: 'wyym-row', style: { gap: '4px' }, title: t('volume') },
            h(Icon, { d: GLYPH.volume.d, size: 15 }),
            h('input', {
              className: 'wyym-range',
              style: { width: '58px' },
              type: 'range',
              min: 0,
              max: 100,
              value: Math.round(state.volume * 100),
              onChange: (event) => player.setVolume(Number(event.target.value) / 100),
              'aria-label': t('volume'),
            }),
          ),
        ),
        // One footer row: the queue position / playlist name on the left and the lyrics
        // dock switch flush with it on the right. They used to be two stacked rows, which
        // left the switch floating below the name instead of level with it.
        h(
          'div',
          { className: 'wyym-playerFoot' },
          h(
            'span',
            { className: 'wyym-faint wyym-grow', style: { fontSize: '11px', minWidth: '0' } },
            state.queue.length > 1
              ? [
                  t('nowPlayingCount', { index: state.index + 1, total: state.queue.length }),
                  state.origin && state.origin.playlistName ? ` · ${state.origin.playlistName}` : '',
                ]
              : state.origin && state.origin.playlistName
                ? state.origin.playlistName
                : '',
          ),
          h(
            'label',
            { className: 'wyym-switch', title: t('dockToggle') },
            h('span', { className: 'wyym-switchLabel' }, t('dockToggle')),
            h('input', {
              type: 'checkbox',
              className: 'wyym-switchInput',
              checked: state.dock,
              onChange: (event) => player.setDock(event.target.checked),
              'aria-label': t('dockToggle'),
            }),
            h('span', { className: 'wyym-switchTrack', 'aria-hidden': 'true' }, h('span', { className: 'wyym-switchKnob' })),
          ),
        ),
      );
    }

    /**
     * Row pitch of a track row: the row box plus the list's 2px flex gap. Fixed,
     * so the rendered window can be computed without measuring each row.
     */
    const TRACK_ROW_PITCH = 50;
    /** Lists longer than this are windowed; shorter ones render whole. */
    const TRACK_WINDOW_MIN = 200;
    /** Extra rows kept mounted beyond the viewport so scrolling shows no blank band. */
    const TRACK_OVERSCAN = 8;

    /**
     * The track rows, windowed and memoised.
     *
     * Why both: the player commits `position` once per second so the progress bar
     * stays honest, and this list used to subscribe to the whole store and render
     * every row. On a 3460-track playlist that is ~29k DOM nodes, and with that
     * much DOM the once-per-second update cost a ~300ms style/layout pass — one
     * frozen frame per second, which is what made the dock's spectrum stutter on
     * tracks like Blue Planet. Measured on this machine, same playback: 3460 rows
     * 48fps with 15 frozen frames per 15s; 300 rows 60fps with none. So the rows
     * now arrive as props (primitives, keeping `React.memo` stable across a
     * position tick) and only the visible slice is mounted.
     *
     * `originId`/`originName` are passed as primitives for the same reason: an
     * inline `{ playlistId, playlistName }` object would be a fresh reference on
     * every parent render and defeat the memo.
     */
    const TrackList = React.memo(function TrackList({ player, tracks, originId, originName, currentId, playing }) {
      const origin = useMemo(() => ({ playlistId: originId, playlistName: originName }), [originId, originName]);
      const rootRef = useRef(null);
      const windowed = tracks.length > TRACK_WINDOW_MIN;
      const [slice, setSlice] = useState(() => ({
        from: 0,
        to: windowed ? TRACK_WINDOW_MIN : tracks.length,
      }));

      useEffect(() => {
        if (!windowed) {
          setSlice((prev) => (prev.from === 0 && prev.to === tracks.length ? prev : { from: 0, to: tracks.length }));
          return undefined;
        }
        const root = rootRef.current;
        const scroller = root && root.parentElement;
        if (!scroller) return undefined;
        let frame = 0;
        const measure = () => {
          frame = 0;
          const height = scroller.clientHeight || 360;
          const top = scroller.scrollTop || 0;
          const from = Math.max(0, Math.floor(top / TRACK_ROW_PITCH) - TRACK_OVERSCAN);
          const count = Math.ceil(height / TRACK_ROW_PITCH) + TRACK_OVERSCAN * 2;
          const to = Math.min(tracks.length, from + count);
          setSlice((prev) => (prev.from === from && prev.to === to ? prev : { from, to }));
        };
        const onScroll = () => {
          if (!frame) frame = window.requestAnimationFrame(measure);
        };
        measure();
        scroller.addEventListener('scroll', onScroll, { passive: true });
        let observer = null;
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(onScroll);
          observer.observe(scroller);
        }
        return () => {
          scroller.removeEventListener('scroll', onScroll);
          if (observer) observer.disconnect();
          if (frame) window.cancelAnimationFrame(frame);
        };
      }, [tracks, windowed]);

      const from = Math.min(slice.from, Math.max(0, tracks.length - 1));
      const to = Math.max(from, Math.min(slice.to, tracks.length));
      const rows = tracks.slice(from, to);
      // Spacer padding keeps the scrollbar honest: the rows above and below the
      // window still occupy their height without being mounted.
      const spacer = windowed
        ? {
            paddingTop: `${from * TRACK_ROW_PITCH}px`,
            paddingBottom: `${Math.max(0, tracks.length - to) * TRACK_ROW_PITCH}px`,
          }
        : undefined;
      const rowStyle = windowed ? { height: `${TRACK_ROW_PITCH - 2}px` } : undefined;
      const start = (index) => player.playQueue(tracks, index, origin);
      return h(
        'div',
        { className: 'wyym-col', ref: rootRef },
        h(
          'ul',
          { className: 'wyym-list', style: spacer },
          rows.map((track, offset) => {
            const index = from + offset;
            return h(
              'li',
              { key: `${track.id}-${index}`, style: rowStyle },
              h(
                'button',
                {
                  type: 'button',
                  className: 'wyym-item',
                  'data-active': currentId === track.id,
                  onClick: () => start(index),
                },
                h('span', { className: 'wyym-index' }, currentId === track.id && playing ? '♪' : index + 1),
                // Every NetEase track carries its album art (al.picUrl), so the list shows it
                // like the playlist rows do. lazy+async keeps a long list cheap to paint.
                track.cover
                  ? h('img', { className: 'wyym-cover-sm', src: track.cover, alt: '', loading: 'lazy', decoding: 'async' })
                  : h('div', { className: 'wyym-cover-sm', 'aria-hidden': 'true' }),
                h(
                  'span',
                  { className: 'wyym-grow' },
                  h('span', { className: 'wyym-title', style: { display: 'block' } }, track.name),
                  h('span', { className: 'wyym-sub', style: { display: 'block' } }, `${track.artists}${track.album ? ` · ${track.album}` : ''}`),
                ),
                track.noCopyright ? h('span', { className: 'wyym-tag' }, t('noCopyright')) : null,
                track.fee === 1 ? h('span', { className: 'wyym-badge' }, 'VIP') : null,
                h('span', { className: 'wyym-index' }, formatTime(track.duration / 1000)),
              ),
            );
          }),
        ),
      );
    });

    function PlaylistList({ store, player, playlists }) {
      if (!playlists.length) return h('div', { className: 'wyym-empty' }, t('emptyPlaylists'));
      return h(
        'ul',
        { className: 'wyym-list' },
        playlists.map((playlist) =>
          h(
            'li',
            { key: playlist.id },
            h(
              'button',
              { type: 'button', className: 'wyym-item', onClick: () => void openPlaylist(store, player, playlist) },
              playlist.cover
                ? h('img', { className: 'wyym-cover-sm', src: playlist.cover, alt: '', loading: 'lazy' })
                : h('div', { className: 'wyym-cover-sm', 'aria-hidden': 'true' }),
              h(
                'span',
                { className: 'wyym-grow' },
                h('span', { className: 'wyym-title', style: { display: 'block' } }, playlist.name),
                h(
                  'span',
                  { className: 'wyym-sub', style: { display: 'block' } },
                  t('songs', { count: playlist.trackCount }),
                  playlist.creator ? ` · ${t('createdBy', { name: playlist.creator })}` : '',
                ),
              ),
              playlist.specialType === 5 ? h('span', { className: 'wyym-badge' }, '♥') : null,
              h(Icon, { d: GLYPH.chevron.d, size: 15 }),
            ),
          ),
        ),
      );
    }

    function SearchPanel({ store, player }) {
      const state = useStore(store);
      const [keywords, setKeywords] = useState('');
      const [kind, setKind] = useState(1);
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      const submit = async (event) => {
        event.preventDefault();
        const text = keywords.trim();
        if (!text) return;
        setBusy(true);
        try {
          const payload = await api('/search', { query: { keywords: text, type: kind, limit: 40 } });
          setResult(payload);
        } catch (error) {
          store.set({ error: error.message });
        } finally {
          setBusy(false);
        }
      };
      return h(
        'div',
        { className: 'wyym-col', style: { flex: '1 1 auto', minHeight: 0 } },
        h(
          'form',
          { className: 'wyym-row', onSubmit: submit },
          h('input', {
            className: 'wyym-input',
            value: keywords,
            placeholder: t('searchPlaceholder'),
            onChange: (event) => setKeywords(event.target.value),
            'aria-label': t('search'),
          }),
          h(
            'button',
            { type: 'submit', className: 'wyym-btn wyym-primary', disabled: busy },
            h(Icon, { d: busy ? GLYPH.refresh.d : GLYPH.search.d, size: 15, className: busy ? 'wyym-spin' : '' }),
          ),
        ),
        h(
          'div',
          { className: 'wyym-seg', role: 'tablist' },
          [1, 1000, 100].map((value) =>
            h(
              'button',
              {
                key: value,
                type: 'button',
                role: 'tab',
                'aria-selected': kind === value,
                onClick: () => setKind(value),
              },
              value === 1 ? t('searchSong') : value === 1000 ? t('searchPlaylist') : t('searchArtist'),
            ),
          ),
        ),
        // Results need their own scroll region: before this wrapper the 40-item list
        // overflowed the host's overflow:hidden pane and the tail was unreachable.
        h(
          'div',
          { className: 'wyym-scroll' },
          busy ? h('div', { className: 'wyym-empty' }, t('searching')) : null,
          !busy && result && result.kind === 'song' && result.tracks.length
            ? h(TrackList, {
                player,
                tracks: result.tracks,
                originId: null,
                originName: t('search'),
                currentId: state.current ? state.current.id : null,
                playing: state.playing,
              })
            : null,
          !busy && result && result.kind === 'playlist' && result.playlists.length
            ? h(PlaylistList, { store, player, playlists: result.playlists })
            : null,
          !busy && result && result.kind === 'artist' && result.artists.length
            ? h(
                'ul',
                { className: 'wyym-list' },
                result.artists.map((artist) =>
                  h(
                    'li',
                    { key: artist.id },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wyym-item',
                        onClick: async () => {
                          const text = artist.name;
                          setKeywords(text);
                          setKind(1);
                          setBusy(true);
                          try {
                            const payload = await api('/search', { query: { keywords: text, type: 1, limit: 40 } });
                            setResult(payload);
                          } catch (error) {
                            store.set({ error: error.message });
                          } finally {
                            setBusy(false);
                          }
                        },
                      },
                      artist.cover ? h('img', { className: 'wyym-cover-sm', src: artist.cover, alt: '', loading: 'lazy' }) : null,
                      h('span', { className: 'wyym-grow wyym-title' }, artist.name),
                      h(Icon, { d: GLYPH.chevron.d, size: 15 }),
                    ),
                  ),
                ),
              )
            : null,
          !busy && result && !((result.tracks && result.tracks.length) || (result.playlists && result.playlists.length) || (result.artists && result.artists.length))
            ? h('div', { className: 'wyym-empty' }, t('searchEmpty'))
            : null,
        ),
      );
    }

    function LoginPanel({ store, onDone }) {
      const [method, setMethod] = useState('phone');
      const [phone, setPhone] = useState('');
      const [captcha, setCaptcha] = useState('');
      const [countdown, setCountdown] = useState(0);
      const [busy, setBusy] = useState(false);
      const [cookie, setCookie] = useState('');
      const [message, setMessage] = useState('');

      useEffect(() => {
        if (countdown <= 0) return undefined;
        const timer = window.setTimeout(() => setCountdown(countdown - 1), 1000);
        return () => window.clearTimeout(timer);
      }, [countdown]);

      const sendCaptcha = async () => {
        if (!phone.trim() || countdown > 0) return;
        setBusy(true);
        setMessage('');
        try {
          await api('/login/captcha/sent', { method: 'POST', body: { phone: phone.trim() } });
          setCountdown(60);
          setMessage(t('captchaSent'));
        } catch (error) {
          setMessage(error.message);
        } finally {
          setBusy(false);
        }
      };

      const submitPhone = async (event) => {
        event.preventDefault();
        if (!phone.trim() || !captcha.trim()) return;
        setBusy(true);
        setMessage('');
        try {
          const payload = await api('/login/captcha', {
            method: 'POST',
            body: { phone: phone.trim(), captcha: captcha.trim() },
          });
          onDone(payload);
        } catch (error) {
          setMessage(error.message);
        } finally {
          setBusy(false);
        }
      };

      const submitCookie = async (event) => {
        event.preventDefault();
        if (!cookie.trim()) return;
        setBusy(true);
        setMessage('');
        try {
          const payload = await api('/login/cookie', { method: 'POST', body: { cookie: cookie.trim() } });
          onDone(payload);
        } catch (error) {
          setMessage(error.message);
        } finally {
          setBusy(false);
        }
      };

      return h(
        'div',
        { className: 'wyym-col' },
        h(
          'div',
          { className: 'wyym-seg', role: 'tablist' },
          [
            ['phone', t('loginPhone')],
            ['cookie', t('loginCookie')],
          ].map(([id, label]) =>
            h('button', { key: id, type: 'button', role: 'tab', 'aria-selected': method === id, onClick: () => setMethod(id) }, label),
          ),
        ),
        message ? h(Banner, { kind: 'info' }, message) : null,
        method === 'phone'
          ? h(
              'form',
              { className: 'wyym-col', onSubmit: submitPhone },
              h('input', {
                className: 'wyym-input',
                value: phone,
                inputMode: 'tel',
                placeholder: t('phone'),
                onChange: (event) => setPhone(event.target.value),
                'aria-label': t('phone'),
              }),
              h(
                'div',
                { className: 'wyym-row' },
                h('input', {
                  className: 'wyym-input',
                  value: captcha,
                  inputMode: 'numeric',
                  placeholder: t('captcha'),
                  onChange: (event) => setCaptcha(event.target.value),
                  'aria-label': t('captcha'),
                }),
                h(
                  'button',
                  { type: 'button', className: 'wyym-btn', disabled: busy || countdown > 0, onClick: sendCaptcha },
                  countdown > 0 ? t('resendIn', { seconds: countdown }) : t('sendCaptcha'),
                ),
              ),
              h(
                'button',
                { type: 'submit', className: 'wyym-btn wyym-primary', style: { justifyContent: 'center' }, disabled: busy },
                busy ? t('loggingIn') : t('submit'),
              ),
            )
          : null,
        method === 'cookie'
          ? h(
              'form',
              { className: 'wyym-col', onSubmit: submitCookie },
              h('div', { className: 'wyym-faint', style: { fontSize: '11.5px' } }, t('cookieHint')),
              h('textarea', {
                className: 'wyym-textarea',
                value: cookie,
                placeholder: t('cookiePlaceholder'),
                onChange: (event) => setCookie(event.target.value),
                'aria-label': t('loginCookie'),
              }),
              h(
                'button',
                { type: 'submit', className: 'wyym-btn wyym-primary', style: { justifyContent: 'center' }, disabled: busy },
                busy ? t('loggingIn') : t('submit'),
              ),
            )
          : null,
      );
    }

    function Root() {
      const state = useStore(storeRef.current);
      const player = playerRef.current;
      const store = storeRef.current;
      const loggedIn = state.loggedIn;
      const view = state.view;

      const [menuOpen, setMenuOpen] = useState(false);
      const [loginOpen, setLoginOpen] = useState(false);

      useEffect(() => {
        if (state.booted) return;
        store.set({ booted: true });
        void (async () => {
          await loadStatus(store);
          const now = store.getState();
          if (now.loggedIn) await loadPlaylists(store);
        })();
      }, [state.booted, store]);

      // Dismiss the account popover on any click outside it.
      useEffect(() => {
        if (!menuOpen) return undefined;
        const onDown = (event) => {
          const node = event.target;
          if (node && typeof node.closest === 'function' && node.closest('.wyym-account')) return;
          setMenuOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
      }, [menuOpen]);

      /** Adopt whatever the Host reports after a login, a switch, or a removal. */
      const applySession = useCallback(
        (payload, patch = {}) => {
          store.set({
            loggedIn: Boolean(payload.loggedIn),
            profile: payload.profile || null,
            accounts: Array.isArray(payload.accounts) ? payload.accounts : [],
            activeUserId: typeof payload.activeUserId === 'number' ? payload.activeUserId : null,
            ...patch,
          });
        },
        [store],
      );

      const onLoginDone = useCallback(
        async (payload) => {
          setLoginOpen(false);
          applySession(payload, { view: 'playlists', error: '' });
          await loadPlaylists(store);
        },
        [applySession, store],
      );

      const switchTo = useCallback(
        async (userId) => {
          setMenuOpen(false);
          if (userId === store.getState().activeUserId) return;
          try {
            const payload = await api('/accounts/switch', { method: 'POST', body: { userId } });
            player.release();
            applySession(payload, {
              playlists: [],
              playlist: null,
              view: 'playlists',
              error: '',
              notice: t('accountSwitched', { name: (payload.profile && payload.profile.nickname) || '' }),
            });
            await loadPlaylists(store);
          } catch (error) {
            store.set({ error: error.message });
          }
        },
        [applySession, player, store],
      );

      const logout = useCallback(async () => {
        setMenuOpen(false);
        player.release();
        try {
          const payload = await api('/logout', { method: 'POST', body: {} });
          applySession(payload, {
            playlists: [],
            playlist: null,
            view: 'playlists',
            error: '',
            notice: t('loggedOut'),
          });
          if (payload.loggedIn) await loadPlaylists(store);
        } catch (error) {
          store.set({ error: error.message });
        }
      }, [applySession, player, store]);

      // Before the Host learns about accounts, fall back to the single signed-in one.
      const accountList = state.accounts.length
        ? state.accounts
        : state.profile
          ? [{
              userId: state.profile.userId,
              nickname: state.profile.nickname,
              avatarUrl: state.profile.avatarUrl,
              vipLabel: state.profile.vipLabel,
              active: true,
            }]
          : [];
      const accountMenuReady = state.accounts.length > 0;

      const accountMenu = h(
        'div',
        { className: 'wyym-menu', role: 'menu', 'aria-label': t('accounts') },
        h('div', { className: 'wyym-menuTitle' }, t('accounts')),
        accountList.map((account) =>
          h(
            'button',
            {
              key: account.userId,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': Boolean(account.active),
              className: account.active ? 'wyym-menuItem is-active' : 'wyym-menuItem',
              disabled: Boolean(account.active),
              onClick: () => void switchTo(account.userId),
            },
            account.avatarUrl
              ? h('img', { className: 'wyym-menuAvatar', src: account.avatarUrl, alt: '', loading: 'lazy' })
              : h(Icon, { d: GLYPH.user.d, size: 15 }),
            h('span', { className: 'wyym-grow wyym-title' }, account.nickname || t('nickFallback')),
            account.vipLabel ? h('span', { className: 'wyym-badge' }, account.vipLabel) : null,
            account.active ? h(Icon, { d: GLYPH.check.d, size: 15 }) : null,
          ),
        ),
        h('div', { className: 'wyym-menuSep' }),
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'wyym-menuItem',
            onClick: () => {
              setMenuOpen(false);
              setLoginOpen(true);
            },
          },
          h(Icon, { d: GLYPH.plus.d, size: 15 }),
          h('span', { className: 'wyym-grow' }, t('addAccount')),
        ),
        h(
          'button',
          { type: 'button', role: 'menuitem', className: 'wyym-menuItem', onClick: () => void logout() },
          h(Icon, { d: GLYPH.logout.d, size: 15 }),
          h('span', { className: 'wyym-grow' }, t('logoutCurrent')),
        ),
        accountMenuReady ? null : h('div', { className: 'wyym-menuNote' }, t('accountUnavailable')),
      );

      const headerRight = loggedIn
        ? h(
            'div',
            { className: 'wyym-row', style: { gap: '6px' } },
            h(
              'div',
              { className: 'wyym-account' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'wyym-accountBtn',
                  'aria-haspopup': 'menu',
                  'aria-expanded': menuOpen,
                  'aria-label': t('account'),
                  title: t('account'),
                  onClick: () => setMenuOpen((open) => !open),
                },
                state.profile && state.profile.avatarUrl
                  ? h('img', { className: 'wyym-avatar', src: state.profile.avatarUrl, alt: '' })
                  : h(Icon, { d: GLYPH.user.d, size: 16 }),
                h(
                  'span',
                  { className: 'wyym-sub', style: { maxWidth: '92px' } },
                  (state.profile && state.profile.nickname) || t('nickFallback'),
                ),
                state.profile && state.profile.vipLabel
                  ? h('span', { className: 'wyym-badge' }, state.profile.vipLabel)
                  : null,
                h(Icon, { d: GLYPH.chevron.d, size: 13, className: 'wyym-chevron' }),
              ),
              menuOpen ? accountMenu : null,
            ),
          )
        : h(
            'button',
            { type: 'button', className: 'wyym-btn', onClick: () => setLoginOpen(true) },
            h(Icon, { d: GLYPH.user.d, size: 14 }),
            t('login'),
          );

      const viewTabs = h(
        'div',
        { className: 'wyym-seg', role: 'tablist' },
        [
          ['playlists', t('playlists')],
          ['search', t('search')],
        ].map(([id, label]) =>
          h(
            'button',
            {
              key: id,
              type: 'button',
              role: 'tab',
              'aria-selected': view === id,
              onClick: () => {
                store.set({ view: id, notice: '' });
                if (id === 'playlists' && loggedIn && !store.getState().playlists.length) void loadPlaylists(store);
              },
            },
            label,
          ),
        ),
      );

      let body = null;
      if (!loggedIn) {
        body = h(
          'div',
          { className: 'wyym-col' },
          h('div', { className: 'wyym-empty' }, t('needLogin')),
          h(
            'button',
            { type: 'button', className: 'wyym-btn wyym-primary', style: { justifyContent: 'center' }, onClick: () => setLoginOpen(true) },
            t('goLogin'),
          ),
        );
      } else if (view === 'search') {
        body = h(SearchPanel, { store, player });
      } else if (view === 'tracks') {
        body = h(
          'div',
          { className: 'wyym-col' },
          h(
            'div',
            { className: 'wyym-row' },
            h(
              'button',
              { type: 'button', className: 'wyym-btn wyym-iconbtn', onClick: () => store.set({ view: 'playlists', playlist: null }), 'aria-label': t('back') },
              h(Icon, { d: GLYPH.back.d, size: 16 }),
            ),
            state.playlist
              ? h(
                  'div',
                  { className: 'wyym-grow' },
                  h('div', { className: 'wyym-title' }, state.playlist.info.name),
                  h(
                    'div',
                    { className: 'wyym-sub' },
                    t('songs', { count: state.playlist.info.trackCount }),
                    state.playlist.info.creator ? ` · ${state.playlist.info.creator}` : '',
                  ),
                )
              : null,
            state.playlist
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'wyym-btn',
                    onClick: () =>
                      player.playQueue(state.playlist.tracks, 0, {
                        playlistId: state.playlist.info.id,
                        playlistName: state.playlist.info.name,
                      }),
                    disabled: !state.playlist.tracks.length,
                  },
                  h(Icon, { d: GLYPH.play.d, fill: 'currentColor', size: 13 }),
                  t('play'),
                )
              : null,
          ),
          state.playlistLoading ? h(Icon, { d: GLYPH.refresh.d, size: 18, className: 'wyym-spin' }) : null,
          state.playlist && state.playlist.tracks.length
            ? h('div', { className: 'wyym-scroll' }, h(TrackList, {
                player,
                tracks: state.playlist.tracks,
                originId: state.playlist.info.id,
                originName: state.playlist.info.name,
                currentId: state.current ? state.current.id : null,
                playing: state.playing,
              }))
            : null,
        );
      } else {
        body = h(
          'div',
          { className: 'wyym-col' },
          h(
            'div',
            { className: 'wyym-row' },
            h('span', { className: 'wyym-title wyym-grow' }, t('myPlaylists')),
            h(
              'button',
              {
                type: 'button',
                className: 'wyym-btn wyym-iconbtn',
                title: t('refresh'),
                'aria-label': t('refresh'),
                onClick: () => void loadPlaylists(store),
                disabled: state.playlistsLoading,
              },
              h(Icon, { d: GLYPH.refresh.d, size: 15, className: state.playlistsLoading ? 'wyym-spin' : '' }),
            ),
          ),
          state.playlistsLoading && !state.playlists.length
            ? h('div', { className: 'wyym-empty' }, h(Icon, { d: GLYPH.refresh.d, size: 18, className: 'wyym-spin' }))
            : h('div', { className: 'wyym-scroll' }, h(PlaylistList, { store, player, playlists: state.playlists })),
        );
      }

      return h(
        'div',
        { className: 'wyym-root' },
        h(
          'div',
          { className: 'wyym-head' },
          h(Icon, { d: GLYPH.music.d, size: 17 }),
          h('span', { className: 'wyym-title wyym-grow' }, t('title')),
          headerRight,
        ),
        // Top of the panel: the 歌单 / 搜索 switch, right under the title.
        loggedIn ? viewTabs : null,
        state.error ? h(Banner, { kind: 'error', onClose: () => store.set({ error: '' }) }, state.error) : null,
        state.notice ? h(Banner, { kind: 'info', onClose: () => store.set({ notice: '' }) }, state.notice) : null,
        // Middle: the only flexing region; every view scrolls inside it.
        h('div', { className: 'wyym-main' }, body),
        // Bottom: transport bar, pinned below the scrolling content.
        h(NowPlaying, { store, player }),
        // Rounded sign-in dialog, opened from the account menu or the sign-in prompt.
        loginOpen
          ? h(
              'div',
              {
                className: 'wyym-overlay',
                role: 'presentation',
                onClick: (event) => {
                  if (event.target === event.currentTarget) setLoginOpen(false);
                },
              },
              h(
                'div',
                { className: 'wyym-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('addAccount') },
                h(
                  'div',
                  { className: 'wyym-row' },
                  h('span', { className: 'wyym-title wyym-grow' }, t('addAccount')),
                  h(
                    'button',
                    { type: 'button', className: 'wyym-btn wyym-iconbtn', 'aria-label': t('close'), title: t('close'), onClick: () => setLoginOpen(false) },
                    h(Icon, { d: GLYPH.close.d, size: 15 }),
                  ),
                ),
                h(LoginPanel, { store, onDone: onLoginDone }),
              ),
            )
          : null,
      );
    }

    // ------------------------------------------------- left-Sidebar shortcut --

    // The right-Sidebar panel is per-session and starts collapsed, so the
    // Sidebar foot carries the durable entry point, beside Settings. The button
    // owns no state: it mirrors whether a panel of our kind is already open.
    function FooterEntry(props) {
      const wide = Boolean(props && props.wide);
      const [open, setOpen] = useState(false);
      useEffect(() => {
        const tabs = runtime.sidebar && runtime.sidebar.openTabs;
        if (!tabs || typeof tabs.subscribe !== 'function') return undefined;
        const read = () => {
          try {
            const list = tabs.getSnapshot();
            setOpen(Array.isArray(list) && list.some((tab) => tab && tab.kind === KIND));
          } catch (error) {
            setOpen(false);
          }
        };
        read();
        return tabs.subscribe(read);
      }, []);
      const label = t('title');
      return h(
        'button',
        {
          type: 'button',
          className: open ? 'wyym-fbtn is-on' : 'wyym-fbtn',
          'data-dsh-plugin': 'wyymusic-player',
          'data-dsh-part': 'entry',
          title: label,
          'aria-label': label,
          'data-open': open ? 'true' : 'false',
          onClick: () => {
            openPanel();
          },
        },
        h(Icon, { d: GLYPH.music.d, size: wide ? 16 : 18 }),
      );
    }

    // -------------------------------------------- conversation lyrics dock --

    // The spectrum strip. It taps the live <audio> output through a shared
    // AudioContext/AnalyserNode (handed over by the player via `getAudio`) and
    // repaints the bars every animation frame from `getByteFrequencyData`, so it
    // pulses with the actual music instead of a seeded curve. When nothing is
    // playing `getAudio` returns nothing and the loop idles; pausing keeps the
    // last shape and the CSS drops the area's opacity, freezing the strip where
    // the song stopped. `prefers-reduced-motion` skips the loop entirely.
    function Pulse({ playing }) {
      const canvasRef = useRef(null);
      const rafRef = useRef(0);
      // Flat baseline shown before any audio flows (and while paused, when the
      // loop stops and the last drawn shape stays on screen).
      const FLAT = useMemo(() => new Array(PULSE_COLUMNS).fill(14), []);

      // Backing-store sizing, kept out of the frame loop: reading layout every
      // frame would itself force the style/layout flush this component exists to
      // avoid. A ResizeObserver reports the CSS size instead.
      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const resize = () => {
          const rect = canvas.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          const width = Math.max(1, Math.round(rect.width * dpr));
          const height = Math.max(1, Math.round(rect.height * dpr));
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
            drawPulse(canvas, FLAT, pulseColor(canvas));
          }
        };
        resize();
        let observer = null;
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(resize);
          observer.observe(canvas);
        }
        window.addEventListener('resize', resize);
        return () => {
          if (observer) observer.disconnect();
          window.removeEventListener('resize', resize);
        };
      }, [FLAT]);

      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        // Reduced motion (and the paused state): leave the canvas on its flat
        // baseline / last drawn shape rather than running a frame loop.
        if (reduced) {
          drawPulse(canvas, FLAT, pulseColor(canvas));
          return undefined;
        }
        if (!playing) return undefined;
        let freq = null;
        let color = pulseColor(canvas);
        let frame = 0;
        const tick = () => {
          rafRef.current = window.requestAnimationFrame(tick);
          const player = playerRef.current;
          const got = player && typeof player.getAudio === 'function' ? player.getAudio() : { audio: null, analyser: null };
          const audio = got.audio;
          const analyser = got.analyser;
          if (!audio || !analyser) return;
          if (!freq || freq.length !== analyser.frequencyBinCount) freq = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(freq);
          // Re-read the themed colour about once a second, not every frame:
          // getComputedStyle flushes style, which is the cost being avoided here.
          frame += 1;
          if (frame % 60 === 0) color = pulseColor(canvas);
          drawPulse(canvas, pulseHeights(freq), color);
        };
        rafRef.current = window.requestAnimationFrame(tick);
        return () => {
          if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
        };
      }, [playing, FLAT]);
      return h(
        'div',
        { className: 'wyym-dockPulse', 'data-playing': playing ? 'true' : 'false', 'aria-hidden': 'true' },
        h('canvas', { ref: canvasRef, className: 'wyym-dockPulseCanvas' }),
      );
    }

    /**
     * The lyric strip above the composer. Read-only by construction: a `div`
     * with no handler, no focusable child, and no binding, which also keeps it
     * out of the way of the composer's own pointer and focus model.
     */
    function NowPlayingDock() {
      const state = useStore(storeRef.current);
      const track = state.current;
      const lines = state.lyrics;
      const index = state.lyricIndex;
      // Before the first stamp falls (the intro / instrumental lead-in), show
      // nothing as a lyric — not even the first line ahead of time. The song has
      // not started singing yet, so the strip stays on a "coming up" placeholder.
      const currentLine = index >= 0 && index < lines.length ? lines[index] : null;

      // Karaoke sweep. Each syllable is drawn as two stacked copies of its own
      // text (base + accent) inside one `inline-grid` cell, and only that cell's
      // accent copy is clipped as the syllable is sung. This is what makes the
      // sweep survive wrapping: the browser lays both copies out identically in
      // the same grid cell, so the clip edge lands on a real glyph boundary by
      // construction — there is no width to measure, and therefore no font-metric
      // or whitespace-collapsing error to accumulate. The fraction is interpolated
      // *inside* each syllable too, so the colour washes across the characters
      // continuously rather than snapping on at each syllable boundary.
      // Split a line into the units that get their own highlight cell. Latin runs
      // stay whole so a word is never broken mid-way by wrapping; everything else
      // (CJK, kana, punctuation, spaces) is one unit per character.
      const splitUnits = (words) => {
        const text = typeof words === 'string' ? words : '';
        const units = [];
        let buffer = '';
        for (const ch of Array.from(text)) {
          if (/[0-9A-Za-z\u00C0-\u024F'’\-&.]/.test(ch)) {
            buffer += ch;
            continue;
          }
          if (buffer) {
            units.push(buffer);
            buffer = '';
          }
          units.push(ch);
        }
        if (buffer) units.push(buffer);
        return units;
      };
      // The units currently rendered, paired with the syllable each belongs to.
      // A YRC syllable can hold several characters, so several cells can map back
      // to one syllable and must light up together.
      const unitsRef = useRef([]);
      useEffect(() => {
        const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        // Reduced motion: no karaoke sweep at all — leave every cell unfilled.
        if (reduced) {
          for (const u of unitsRef.current) {
            if (u.ref && u.ref.current) u.ref.current.style.clipPath = 'inset(0 100% 0 0)';
          }
          return undefined;
        }
        // Paused (or nothing to sing yet): leave the cells exactly where they were,
        // so pausing mid-line freezes the sweep instead of blanking it. The loop
        // still runs while a line is on screen so the sweep keeps tracking.
        if (!state.playing) return undefined;
        let frame = 0;
        const tick = () => {
          frame = window.requestAnimationFrame(tick);
          const player = playerRef.current;
          const got = player && typeof player.getAudio === 'function' ? player.getAudio() : { audio: null, analyser: null, latencyMs: 0 };
          const audio = got.audio;
          if (!audio) return;
          // Subtract the output latency so everything tracks the sound the user
          // actually hears; without this it runs ahead of the audio by the
          // AudioContext's buffer and the highlight lands before the singing.
          const heardMs = (audio.currentTime * 1000) - (got.latencyMs || 0);
          // Advance the line here, on the frame clock, rather than waiting for the
          // 10Hz position poll. Lyrics then change exactly on their timestamps —
          // fast passages change fast and slow ones linger — instead of landing up
          // to a poll interval late.
          const live = storeRef.current.getState();
          const target = lineIndexAt(live.lyrics, heardMs / 1000);
          if (target !== live.lyricIndex) storeRef.current.set({ lyricIndex: target });
          const units = unitsRef.current;
          if (!units.length || !currentLine) return;
          const lineMs = currentLine.time * 1000;
          const syls = currentLine.syls;
          // How many characters each YRC syllable owns, taken from the cells that
          // were actually rendered (so it always matches what is on screen even if
          // the syllable text and the units disagree).
          const sylSpans = [];
          for (const u of units) sylSpans[u.syl] = (sylSpans[u.syl] || 0) + (u.c1 - u.c0);
          // The sweep is one *character position within the line* advancing with
          // the audio; each cell fills as that position passes through it. A YRC
          // syllable holding several characters (an English word, say) therefore
          // fills across its own characters instead of switching on whole, while
          // single-character syllables behave exactly as before.
          // `pos` is that position in characters; -1 means "nothing sung yet".
          let pos = -1;
          if (syls && syls.length) {
            let done = 0; /* characters belonging to syllables already finished */
            for (let i = 0; i < syls.length; i += 1) {
              const start = lineMs + syls[i].t;
              const nextStart = i + 1 < syls.length
                ? lineMs + syls[i + 1].t
                : start + Math.max(1, syls[i].d || 0);
              const chars = sylSpans[i] || 1;
              if (heardMs < start) break;
              if (heardMs < nextStart) {
                // Inside this syllable: interpolate across the characters it owns.
                pos = done + chars * ((heardMs - start) / Math.max(1, nextStart - start));
                break;
              }
              done += chars;
              pos = done;
            }
          } else if (currentLine.words) {
            // Plain LRC: no per-character timing, so estimate how long this line is
            // sung. See `lrcLineDuration` — it trusts the line's own gap unless that
            // gap is an outlier against the rest of the song, in which case it is
            // instrumental time and gets trimmed so the highlight does not crawl
            // through the silence long after the voice has stopped.
            const dur = lrcLineDuration(lines, index);
            const elapsed = heardMs / 1000 - currentLine.time;
            const total = units.reduce((n, u) => n + (u.c1 - u.c0), 0) || 1;
            pos = Math.max(0, Math.min(1, elapsed / dur)) * total;
          } else {
            return;
          }
          for (const u of units) {
            const node = u.ref && u.ref.current;
            if (!node) continue;
            const span = u.c1 - u.c0;
            // Fraction of this cell the character position has reached.
            const lit = span > 0 ? (pos - u.c0) / span : (pos >= u.c1 ? 1 : 0);
            const clamped = Math.max(0, Math.min(1, lit));
            const clip = `inset(0 ${((1 - clamped) * 100).toFixed(2)}% 0 0)`;
            // Only touch the DOM when the value really changed. Assigning an
            // identical string still dirties style, and one frame used to write
            // every cell on the line even though only the syllable being sung
            // moves — on a 60-character line that is 60 pointless invalidations
            // per frame.
            if (u.lastClip === clip) continue;
            u.lastClip = clip;
            node.style.clipPath = clip;
          }
        };
        // A fresh effect run may sit on reused unit objects but brand-new DOM
        // nodes (React re-keys on the line), so drop the cache once to guarantee
        // the first painted frame is correct.
        for (const u of unitsRef.current) u.lastClip = undefined;
        frame = window.requestAnimationFrame(tick);
        return () => {
          if (frame) window.cancelAnimationFrame(frame);
        };
      }, [index, currentLine, lines, state.playing]);

      // The lyric line, built as one two-layer cell per unit. Cells are laid out
      // by the browser (so the text wraps naturally and both layers share exact
      // metrics); the frame loop only ever writes `clip-path` onto each fill cell,
      // never re-renders. `unitsRef` is filled here during render and read by the
      // sweep, which maps every cell back to the syllable that owns it.
      const renderLine = (line) => {
        if (!line) return '';
        const words = line.words || '';
        const units = splitUnits(words);
        const syls = line.syls;
        // Character offset of each syllable within the line, so a cell knows which
        // syllable (and therefore which time span) it belongs to.
        const offsets = [];
        let at = 0;
        for (const s of syls || []) {
          offsets.push(at);
          at += (s.text || '').length;
        }
        const entries = [];
        let cursor = 0;
        for (const text of units) {
          const len = text.length;
          // Which syllable this cell falls in: the last one starting at or before
          // `cursor`. Without YRC every cell belongs to syllable 0 and the whole
          // line is swept as one span.
          let syl = 0;
          for (let i = 0; i < offsets.length; i += 1) {
            if (offsets[i] <= cursor) syl = i;
            else break;
          }
          const ref = { current: null };
          entries.push({ c0: cursor, c1: cursor + len, syl, ref });
          cursor += len;
        }
        unitsRef.current = entries;
        return h(
          'span',
          { className: 'wyym-dockKaraoke' },
          entries.map((entry, i) =>
            h(
              'span',
              { key: i, className: 'wyym-dockSeg' },
              // The base copy is only a visual underlay: the fill layer carries the same
              // text, so without `aria-hidden` the accessibility tree (and text selection)
              // sees every character twice — measured: `textContent` came out as
              // "第第一一句句歌歌词词内内容容". Screen readers would read each line twice.
              h('span', { className: 'wyym-dockSegBase', 'aria-hidden': 'true' }, units[i]),
              h('span', { ref: entry.ref, className: 'wyym-dockSegFill' }, units[i]),
            ),
          ),
        );
      };

      // The strip animates open and shut instead of popping in and out. It is
      // never unmounted (an unmounted node cannot animate, and remounting is why
      // opening had no transition at all): it stays in the flow and the
      // `data-open` attribute drives the same CSS transition in both directions.
      const [open, setOpen] = useState(Boolean(state.dock));
      useEffect(() => {
        // Just flip the attribute. The element is already mounted and painted at
        // its previous height, so both opening and closing animate.
        setOpen(Boolean(state.dock));
      }, [state.dock]);

      if (!track) {
        return h(
          'div',
          {
            className: 'wyym-dock',
            'data-dsh-plugin': 'wyymusic-player',
            'data-dsh-part': 'dock',
            'data-open': open ? 'true' : 'false',
            'aria-hidden': open ? 'false' : 'true',
          },
          h(
            'div',
            { className: 'wyym-dockClip' },
            h(
              'div',
              { className: 'wyym-dockPanel' },
              h('div', { className: 'wyym-dockLyrics' }, h('div', { className: 'wyym-dockLine is-idle' }, t('dockIdle'))),
            ),
          ),
        );
      }

      return h(
        'div',
        {
          className: 'wyym-dock',
          'data-dsh-plugin': 'wyymusic-player',
          'data-dsh-part': 'dock',
          'data-open': open ? 'true' : 'false',
          'aria-hidden': open ? 'false' : 'true',
        },
        h(
          'div',
          { className: 'wyym-dockClip' },
          h(
            'div',
            { className: 'wyym-dockPanel' },
            h(
              'div',
              { className: 'wyym-dockLead' },
              // Cover to the LEFT of the title, per the layout the user asked for.
              track.cover
                ? h('img', { className: 'wyym-dockCover', src: track.cover, alt: '', loading: 'lazy' })
                : h('div', { className: 'wyym-dockCover', 'aria-hidden': 'true' }),
              h(
                'div',
                { className: 'wyym-dockMeta' },
                h('span', { className: 'wyym-dockTitle' }, track.name),
                h('span', { className: 'wyym-dockArtist' }, track.artists || ''),
              ),
            ),
            h(
              'div',
              { className: 'wyym-dockLyrics' },
              index >= 0 && currentLine
                ? h(
                    'div',
                    { key: `cur-${index}`, className: 'wyym-dockLine wyym-dockLine-enter' },
                    renderLine(currentLine),
                  )
                : lines.length
                  ? h('div', { className: 'wyym-dockLine is-idle' }, t('dockSoon'))
                  : h('div', { className: 'wyym-dockLine is-idle' }, t('noLyric')),
            ),
            // Far right of the strip, per the layout the user asked for.
            h(Pulse, { playing: state.playing }),
          ),
        ),
      );
    }

    // ------------------------------------------------------------- plugin body --

    let storeRef = { current: null };
    let playerRef = { current: null };
    const runtime = { sidebar: null };

    // Open (or focus) the panel in the right Sidebar; false when the navigation
    // service is unavailable, so a caller can report instead of failing mutely.
    function openPanel() {
      const sidebar = runtime.sidebar;
      if (!sidebar || typeof sidebar.openTab !== 'function') return false;
      try {
        sidebar.openTab(KIND);
        return true;
      } catch (error) {
        console.warn('[wyymusic-player] could not open the panel:', error && error.message);
        return false;
      }
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'locale'],
      apply(ctx) {
        // Locale: registered through the client locale service, never hardcoded.
        try {
          ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
        } catch (error) {
          console.warn('[wyymusic-player] locale registration fell back:', error && error.message);
        }
        try {
          const locale = ctx.locale.getLocale();
          translator.setLocale(locale && locale.active);
          ctx.effect(() => ctx.locale.subscribe(() => {
            const current = ctx.locale.getLocale();
            translator.setLocale(current && current.active);
          }), 'wyymusic-player: locale');
        } catch {
          /* keep the default language */
        }

        const prefs = readPrefs();
        storeRef = {
          current: createStore({
            booted: false,
            booting: true,
            loggedIn: false,
            profile: null,
            accounts: [],
            activeUserId: null,
            view: 'playlists',
            playlists: [],
            playlistsLoading: false,
            playlist: null,
            playlistLoading: false,
            quality: PLAY_LEVEL,
            mode: MODES.includes(prefs.mode) ? prefs.mode : 'order',
            volume: typeof prefs.volume === 'number' ? Math.max(0, Math.min(1, prefs.volume)) : 0.85,
            queue: [],
            index: 0,
            origin: null,
            current: null,
            playing: false,
            loading: false,
            position: 0,
            duration: 0,
            actualLevel: null,
            actualBr: 0,
            lyrics: [],
            lyricIndex: -1,
            error: '',
            notice: '',
            // The conversation dock is on until the user turns it off in the
            // panel, so an update that introduces it is visible without a trip
            // to a setting.
            dock: prefs.dock !== false,
          }),
        };
        playerRef = { current: createPlayer(storeRef.current) };

        ctx.effect(
          () => () => {
            playerRef.current.release();
          },
          'wyymusic-player: audio element',
        );

        // The Sidebar shortcut renders outside the panel subtree, so the
        // stylesheet cannot live inside Root: it is installed once per plugin
        // instance and removed with it.
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = PACKAGE_ID;
          style.dataset.pluginCss = `${PACKAGE_ID}#stylesheet`;
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => {
            if (style.parentNode) style.parentNode.removeChild(style);
          };
        }, 'wyymusic-player: stylesheet');

        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: PACKAGE_ID,
              kind: KIND,
              priority: 'extension',
              keepMounted: true,
              multiple: false,
              title: () => t('title'),
              guide: [
                {
                  id: 'open',
                  order: 60,
                  title: () => t('title'),
                  description: () => t('guide'),
                },
              ],
            }),
          'wyymusic-player: right-Sidebar tab type',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PACKAGE_ID }, Root),
            ),
          'wyymusic-player: right-Sidebar tab body',
        );

        // Open the panel once per browser profile; afterwards the saved layout
        // and the guide entry are the way in.
        const sidebar = ctx.get('sidebarRight');
        runtime.sidebar = sidebar || null;

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.footer.action', () => {
              try {
                return ctx.slots.register(
                  { name: 'sidebar.footer.action', id: 'wyymusic-player', order: 20, locale: NS },
                  FooterEntry,
                );
              } catch (error) {
                console.warn('[wyymusic-player] Sidebar shortcut registration failed:', error && error.message);
                return () => {};
              }
            }),
          'wyymusic-player: left-Sidebar shortcut',
        );

        // The lyrics strip above the composer. A session-scoped seat, so it
        // exists wherever the conversation does. The component stays mounted and
        // collapses itself to zero height while switched off, so its open/close
        // transition always has a node to animate.
        //
        // It registers last (order 200, after the shipped docks and after
        // git-graph's chip at 100) on purpose: the strip is flush against the
        // composer card by cancelling the stack gap with a negative margin, and
        // that only lands on the card if nothing renders after it.
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.dock', () => {
              try {
                return ctx.slots.register(
                  { name: 'conversation.input.dock', id: 'wyymusic-player', order: 200 },
                  NowPlayingDock,
                );
              } catch (error) {
                console.warn('[wyymusic-player] lyrics dock registration failed:', error && error.message);
                return () => {};
              }
            }),
          'wyymusic-player: lyrics dock',
        );

        if (sidebar && typeof sidebar.openTab === 'function' && sidebar.mounted) {
          ctx.effect(() => {
            let done = false;
            const open = () => {
              if (done) return;
              try {
                if (!sidebar.mounted.getSnapshot()) return;
                const tabs = sidebar.openTabs && sidebar.openTabs.getSnapshot ? sidebar.openTabs.getSnapshot() : [];
                if (Array.isArray(tabs) && tabs.some((tab) => tab && tab.kind === KIND)) {
                  done = true;
                  return;
                }
                if (window.localStorage && window.localStorage.getItem(OPENED_KEY)) {
                  done = true;
                  return;
                }
                sidebar.openTab(KIND);
                markAutoOpened();
                done = true;
              } catch (error) {
                console.warn('[wyymusic-player] could not open the panel:', error && error.message);
              }
            };
            const unsubscribe = sidebar.mounted.subscribe(open);
            const timer = window.setTimeout(open, 600);
            return () => {
              unsubscribe();
              window.clearTimeout(timer);
            };
          }, 'wyymusic-player: first open');
        }
      },
    };
  },
});
