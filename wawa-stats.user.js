// ==UserScript==
// @name         WAWA 小说数据记录与统计
// @namespace    local.wawa-stats
// @version      0.6.5
// @license     MIT
// @description  记录 wawawriter.com 投稿页每日字数/章节/收益/在读人数，并提供本地统计图表与 CSV 导出
// @author       FriksD
// @homepageURL  https://github.com/FriksD/wawa-stats
// @supportURL   https://github.com/FriksD/wawa-stats/issues
// @match        https://wawawriter.com/app/submission*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @downloadURL https://update.greasyfork.org/scripts/591889/WAWA%20%E5%B0%8F%E8%AF%B4%E6%95%B0%E6%8D%AE%E8%AE%B0%E5%BD%95%E4%B8%8E%E7%BB%9F%E8%AE%A1.user.js
// @updateURL https://update.greasyfork.org/scripts/591889/WAWA%20%E5%B0%8F%E8%AF%B4%E6%95%B0%E6%8D%AE%E8%AE%B0%E5%BD%95%E4%B8%8E%E7%BB%9F%E8%AE%A1.meta.js
// ==/UserScript==

(function () {
  'use strict';

  // ========== 配置 ==========
  const STORAGE_KEY = 'wawaStats_v1';
  const STORE_VERSION = 2;
  const API_REVENUE = '/wrhp-api/api/v1/submission/novel/my_revenue';
  const UPDATE_START_HOUR = 14;   // 服务器数据从 14:00 起陆续更新
  const POLL_INTERVAL_MS = 5 * 60 * 1000; // 静默轮询间隔：5 分钟
  const POLL_DEADLINE_HOUR = 17;  // 17:00 后停止轮询
  const POLL_MAX_ATTEMPTS = 24;   // 轮询次数上限
  const AUTO_CAPTURE_DELAY = 4000; // 页面出现卡片后延迟自动采集

  // ========== 工具函数 ==========
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');

  function beijingParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour') % 24,
      minute: get('minute'),
      second: get('second'),
    };
  }

  function todayStr() {
    const p = beijingParts();
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }

  function daysAgoStr(n) {
    return toBeijingDateStr(new Date(Date.now() - n * 86400000)) || todayStr();
  }

  function dateOffsetStr(dateStr, offset) {
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + offset));
    return toBeijingDateStr(dt);
  }

  function nowTimeStr() {
    const p = beijingParts();
    return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
  }

  function isAfterUpdateStart(date = new Date()) {
    const p = beijingParts(date);
    return p.hour >= UPDATE_START_HOUR;
  }

  // 期望能拿到的最新数据日期：
  // 过了 14:00 → 昨天的数据；还没到 14:00 → 前天的数据
  function expectedDataDate() {
    return isAfterUpdateStart() ? daysAgoStr(1) : daysAgoStr(2);
  }

  function toBeijingDateStr(date) {
    if (!date || isNaN(date.getTime())) return null;
    const p = beijingParts(date);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }

  function normalizeDateValue(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') {
      // 兼容秒级/毫秒级时间戳
      const ms = v > 1e12 ? v : v * 1000;
      const d = new Date(ms);
      return toBeijingDateStr(d);
    }
    const s = String(v).trim();
    // 兼容 2026-08-18 / 2026.08.18 / 2026/08/18
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
    const d = new Date(s);
    return toBeijingDateStr(d);
  }

  // 网站数据是延迟一天发布的：今天/未来的日期不是真实数据日期，而是“暂无数据”的占位
  function isNoDataDate(dateStr) {
    const d = normalizeDateValue(dateStr);
    return !!d && d >= todayStr();
  }

  function isNoDataBook(book) {
    // 今天/未来的日期是占位；没有在读人数也视为“暂无正式数据”，
    // 避免更新窗口前把带未来占位日期（如 8/26 的无效快照）误判成最新有效数据。
    return !!book && (isNoDataDate(book.statDate) || book.readers == null);
  }

  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(/[,，]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function parseChapterNum(text) {
    if (!text) return null;
    const m = String(text).match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  function parseWordsWan(text) {
    if (!text) return null;
    const t = String(text).trim();
    const m = t.match(/(\d+(?:\.\d+)?)\s*万字/);
    if (m) return parseFloat(m[1]);
    const m2 = t.match(/(\d+(?:\.\d+)?)\s*字/);
    if (m2) return parseFloat(m2[1]) / 10000;
    return null;
  }

  function parseMoneyText(text) {
    const m = String(text).match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }

  // ========== 存储 ==========
  function loadStore() {
    try {
      const v = GM_getValue(STORAGE_KEY, { records: [] });
      if (v && Array.isArray(v.records)) {
        v.pendingBooks = Array.isArray(v.pendingBooks) ? v.pendingBooks : [];
        return v;
      }
    } catch (e) {
      console.error('[WAWA Stats] loadStore failed', e);
    }
    return { records: [], pendingBooks: [] };
  }

  function saveStore(store) {
    try {
      GM_setValue(STORAGE_KEY, store);
    } catch (e) {
      console.error('[WAWA Stats] saveStore failed', e);
      showToast('保存失败：' + e.message, 'error');
    }
  }

  // 按每本书自己的 statDate 写入对应日期的记录；同一天重复采集时只覆盖该书，不影响其他书
  function upsertBooksByDate(date, newBooks, meta = {}) {
    const store = loadStore();
    let rec = store.records.find((r) => r.date === date);
    if (!rec) {
      rec = {
        date,
        localCaptureDate: meta.localCaptureDate || todayStr(),
        timestampSource: meta.timestampSource || 'local',
        capturedAt: new Date().toISOString(),
        capturedAtLocal: nowTimeStr(),
        serverTime: meta.serverTime || '',
        preUpdate: !!meta.preUpdate,
        books: [],
      };
      store.records.push(rec);
    } else {
      rec.capturedAt = new Date().toISOString();
      rec.capturedAtLocal = nowTimeStr();
      if (meta.serverTime) rec.serverTime = meta.serverTime;
      if (meta.timestampSource) rec.timestampSource = meta.timestampSource;
      if (meta.preUpdate !== undefined) rec.preUpdate = meta.preUpdate;
    }

    newBooks.forEach((nb) => {
      const idx = rec.books.findIndex((b) => b.title === nb.title);
      if (idx >= 0) rec.books[idx] = nb;
      else rec.books.push(nb);
    });

    store.records.sort((a, b) => a.date.localeCompare(b.date));
    saveStore(store);
    return store;
  }

  // 新签约/暂无真实数据的书单独留在“书单”里，不写入历史日期记录，避免污染统计
  function upsertPendingBooks(newBooks) {
    const store = loadStore();
    if (!newBooks || !newBooks.length) return store;
    if (!Array.isArray(store.pendingBooks)) store.pendingBooks = [];
    newBooks.forEach((nb) => {
      const item = { ...nb, isPlaceholder: true, statDate: null };
      const idx = store.pendingBooks.findIndex((b) => b.title === item.title);
      if (idx >= 0) store.pendingBooks[idx] = item;
      else store.pendingBooks.push(item);
    });
    saveStore(store);
    return store;
  }

  // 一次性迁移：把历史记录里 statDate 与记录日期不一致的书，移到它自己 statDate 对应的记录里
  function migrateStore() {
    const store = loadStore();
    if ((store.version || 1) >= STORE_VERSION) return;

    const findOrCreateRec = (date, template) => {
      let rec = store.records.find((r) => r.date === date);
      if (!rec) {
        rec = {
          date,
          localCaptureDate: template.localCaptureDate || template.date,
          timestampSource: 'api',
          capturedAt: template.capturedAt || '',
          capturedAtLocal: template.capturedAtLocal || '',
          serverTime: template.serverTime || '',
          preUpdate: false,
          books: [],
        };
        store.records.push(rec);
      }
      return rec;
    };

    let moved = 0;
    for (const rec of store.records.slice()) {
      const misplaced = (rec.books || []).filter((b) => b.statDate && b.statDate !== rec.date);
      if (!misplaced.length) continue;
      rec.books = rec.books.filter((b) => !(b.statDate && b.statDate !== rec.date));
      for (const book of misplaced) {
        const target = findOrCreateRec(book.statDate, rec);
        const idx = target.books.findIndex((b) => b.title === book.title);
        // 目标记录里已有同名书时保留原有（目标记录采集时该书就是这个日期的数据，更可信）
        if (idx < 0) target.books.push(book);
        moved++;
      }
    }
    store.records = store.records.filter((r) => (r.books || []).length > 0);
    store.records.sort((a, b) => a.date.localeCompare(b.date));
    store.version = STORE_VERSION;
    saveStore(store);
    if (moved) console.log(`[WAWA Stats] 数据迁移完成：${moved} 条书籍数据已归位到各自的统计日期`);
  }

  // ========== DOM 解析 ==========
  function parseRevenueFromCard(card) {
    const result = {
      totalRevenue: null,
      dailyRevenue: null,
      yesterdayDelta: null,
      readers: null,
    };
    if (!card) return result;
    card.querySelectorAll('.revenue-card').forEach((rc) => {
      const labelEl = rc.querySelector('.mb-1');
      const label = (labelEl ? labelEl.textContent : rc.textContent).replace(/\s+/g, ' ').trim();
      const valueText = rc.textContent.replace(/\s+/g, ' ').trim();

      if (label.includes('历史总收益')) {
        result.totalRevenue = parseMoneyText(valueText);
      } else if (label.includes('单日收益')) {
        const dailyM = valueText.match(/(\d+(?:\.\d+)?)\s*元/);
        result.dailyRevenue = dailyM ? parseFloat(dailyM[1]) : 0;
        const deltaM = valueText.match(/昨日\s*([+-]\d+(?:\.\d+)?)/);
        result.yesterdayDelta = deltaM ? round2(parseFloat(deltaM[1])) : 0;
      } else if (label.includes('在读人数')) {
        const readerM = valueText.match(/(\d+(?:\.\d+)?)\s*人/);
        result.readers = readerM ? parseFloat(readerM[1]) : null;
      }
    });
    return result;
  }

  function parseDomCards() {
    const cards = Array.from(document.querySelectorAll('.submission-item'));
    return cards.map((card) => {
      const title = (card.querySelector('h3')?.textContent || '').trim();
      const submissionId = card.getAttribute('data-submission-id') || '';
      const text = card.innerText || '';

      const tags = Array.from(card.querySelectorAll('.flex.items-center.gap-2.mb-2 > span'))
        .map((s) => s.textContent.trim())
        .filter(Boolean);

      let lastUpdated = '';
      const lastM = text.match(/最近更新：\s*(.+)/);
      if (lastM) lastUpdated = lastM[1].trim();

      let chapterText = '';
      let wordsText = '';
      let status = '';
      card.querySelectorAll('.submission-item-stats > div').forEach((el) => {
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        if (t.includes('章节')) chapterText = t.replace(/^章节\s*[:：]\s*/, '');
        else if (t.includes('总字数')) wordsText = t.replace(/^总字数\s*[:：]\s*/, '');
        else if (t.includes('状态')) status = t.replace(/^状态\s*[:：]\s*/, '');
      });

      return {
        submissionId,
        title,
        tags,
        lastUpdated,
        chapterText,
        chapterNum: parseChapterNum(chapterText),
        wordsText,
        wordsWan: parseWordsWan(wordsText),
        status,
        ...parseRevenueFromCard(card),
      };
    });
  }

  // ========== 收益 API ==========
  async function fetchRevenueApi() {
    try {
      const res = await fetch(API_REVENUE, {
        credentials: 'include',
        headers: {
          accept: 'application/json, text/plain, */*',
          'x-client-channel': 'web',
          'x-client-platform': 'pc',
        },
      });
      const serverTime = res.headers.get('date') || '';
      const json = await res.json();
      if (!json || json.code !== 200) {
        throw new Error((json && json.message) || 'API 返回异常');
      }
      return { serverTime, data: Array.isArray(json.data) ? json.data : [] };
    } catch (e) {
      console.error('[WAWA Stats] fetchRevenueApi failed', e);
      return { serverTime: '', data: [] };
    }
  }

  // 接口真实结构：
  // { base_novel_id, title, total_revenue,
  //   latest:   { date, revenue, follow_user_cnt, available },
  //   previous: { date, revenue, follow_user_cnt, available } }
  function normalizeApiData(items) {
    return items.map((item) => {
      const latest = item.latest && typeof item.latest === 'object' ? item.latest : null;
      const prevObj = item.previous && typeof item.previous === 'object' ? item.previous : null;

      const dailyRevenue = latest ? toNum(latest.revenue) : 0;
      const readers = latest && latest.follow_user_cnt != null ? toNum(latest.follow_user_cnt) : null;
      const statDate = latest ? normalizeDateValue(latest.date) : null;
      const available = latest ? latest.available !== false : false;

      const prevRevenue = prevObj ? toNum(prevObj.revenue) : null;
      const previousReaders = prevObj && prevObj.follow_user_cnt != null ? toNum(prevObj.follow_user_cnt) : null;
      const previousDate = prevObj ? normalizeDateValue(prevObj.date) : null;

      const yesterdayDelta = prevRevenue == null ? 0 : round2(dailyRevenue - prevRevenue);
      const readerDelta = readers != null && previousReaders != null ? readers - previousReaders : null;

      return {
        baseNovelId: item.base_novel_id ?? item.baseNovelId ?? null,
        title: (item.title || '').trim(),
        totalRevenue: toNum(item.total_revenue ?? item.totalRevenue ?? 0),
        dailyRevenue,
        yesterdayDelta,
        readers,
        readerDelta,
        previousReaders,
        previousDate,
        statDate,
        available,
      };
    });
  }

  // ========== 合并 ==========
  function mergeData(domCards, apiItems) {
    const apiByTitle = new Map();
    const apiById = new Map();
    for (const a of apiItems) {
      if (a.title) apiByTitle.set(a.title, a);
      if (a.baseNovelId != null) apiById.set(String(a.baseNovelId), a);
    }

    const merged = domCards.map((card) => {
      const api = apiByTitle.get(card.title) || apiById.get(String(card.submissionId)) || null;
      return {
        ...card,
        baseNovelId: api ? api.baseNovelId : null,
        totalRevenue: card.totalRevenue ?? api?.totalRevenue ?? 0,
        dailyRevenue: card.dailyRevenue ?? api?.dailyRevenue ?? 0,
        yesterdayDelta: card.yesterdayDelta ?? api?.yesterdayDelta ?? 0,
        readers: card.readers ?? api?.readers ?? null,
        readerDelta: api?.readerDelta ?? null,
        previousReaders: api?.previousReaders ?? null,
        previousDate: api?.previousDate ?? null,
        statDate: api?.statDate ?? null,
        available: api ? api.available : false,
      };
    });

    // API 里有但 DOM 暂未渲染出来的书也保留
    const titles = new Set(merged.map((b) => b.title));
    for (const api of apiItems) {
      if (!titles.has(api.title)) {
        merged.push({
          submissionId: '',
          title: api.title,
          tags: [],
          lastUpdated: '',
          chapterText: '',
          chapterNum: null,
          wordsText: '',
          wordsWan: null,
          status: '',
          baseNovelId: api.baseNovelId,
          totalRevenue: api.totalRevenue,
          dailyRevenue: api.dailyRevenue,
          yesterdayDelta: api.yesterdayDelta,
          readers: api.readers,
          readerDelta: api.readerDelta,
          previousReaders: api.previousReaders,
          previousDate: api.previousDate,
          statDate: api.statDate,
          available: api.available,
        });
        titles.add(api.title);
      }
    }
    return merged;
  }

  // ========== 点开卡片补全（API 缺字段时） ==========
  async function collectReadersFromCards(books) {
    const els = Array.from(document.querySelectorAll('.submission-item'));
    const byTitle = new Map(books.map((b) => [b.title, b]));
    let openedLast = false;

    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const title = (el.querySelector('h3')?.textContent || '').trim();
      const book = byTitle.get(title);
      if (!book) continue;

      const needCollect = book.readers == null || book.dailyRevenue == null || book.totalRevenue == null;
      if (!needCollect) continue;

      if (!el.querySelector('.revenue-card')) {
        const target = el.querySelector('.submission-item-main') || el;
        target.click();
        await sleep(260);
        openedLast = true;
      }

      const rev = parseRevenueFromCard(el);
      if (rev.totalRevenue != null) book.totalRevenue = rev.totalRevenue;
      if (rev.dailyRevenue != null) book.dailyRevenue = rev.dailyRevenue;
      if (rev.yesterdayDelta != null) book.yesterdayDelta = rev.yesterdayDelta;
      if (rev.readers != null) book.readers = rev.readers;

      // 不是最后一个的话，点下一个自然会把上一个收起
      openedLast = true;
    }

    // 把最后展开的卡片收回
    if (openedLast && els.length) {
      const last = els[els.length - 1];
      if (last.querySelector('.revenue-card')) {
        const target = last.querySelector('.submission-item-main') || last;
        target.click();
        await sleep(120);
      }
    }
    return books;
  }

  // ========== 采集 ==========
  async function waitForCards(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (document.querySelectorAll('.submission-item').length > 0) return true;
      await sleep(300);
    }
    return document.querySelectorAll('.submission-item').length > 0;
  }

  async function captureNow(options = {}) {
    const force = !!options.force;
    const quiet = !!options.quiet;

    await waitForCards(8000);

    const domCards = parseDomCards();
    const apiRes = await fetchRevenueApi();
    const apiItems = normalizeApiData(apiRes.data);
    const hasTimestamp = apiItems.some((item) => !isNoDataBook(item));

    let books = mergeData(domCards, apiItems);

    // 仅手动强采且 API 没返回数据时，才点开卡片兜底补全（自动路径完全无感知）
    if (force && !hasTimestamp && books.some((b) => b.readers == null || b.dailyRevenue == null || b.totalRevenue == null)) {
      showBanner('正在展开卡片补全收益/在读数据…');
      try {
        books = await collectReadersFromCards(books);
      } catch (e) {
        console.error('[WAWA Stats] click collect failed', e);
      }
      hideBanner();
    }

    if (!books.length) {
      if (!quiet) showToast('没有采集到任何书籍数据', 'error');
      return null;
    }

    // 按每本书自己的 statDate 分组入库：8-22 的书写进 8-22 的记录，绝不混日期。
    // 今天（或未来）日期、没有在读人数的书是刚签约/还没正式数据的占位书，不进 records，只进 pendingBooks。
    const groups = new Map();
    const pendingBooks = [];
    let saved = 0;
    for (const book of books) {
      if (isNoDataBook(book)) {
        pendingBooks.push(book);
        continue;
      }
      let date = book.statDate;
      if (!date) {
        if (!force) continue; // 自动采集：没有时间戳的书直接跳过
        date = expectedDataDate(); // 手动强采：落到推断的数据日期
      }
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date).push(book);
      saved++;
    }

    upsertPendingBooks(pendingBooks);
    const pendingCount = pendingBooks.length;

    if (!groups.size && !pendingCount) {
      const msg = '接口没有返回带日期的统计数据，本次跳过';
      if (!quiet) showToast(msg, 'warn');
      console.log('[WAWA Stats]', msg);
      return null;
    }

    const dates = Array.from(groups.keys()).sort();
    for (const [date, group] of groups) {
      upsertBooksByDate(date, group, {
        localCaptureDate: todayStr(),
        timestampSource: group.some((b) => b.statDate) ? 'api' : 'local',
        serverTime: apiRes.serverTime,
        preUpdate: !isAfterUpdateStart(),
      });
    }

    // 相对期望日期统计同步进度（只看 API 返回的正式数据书）
    const expected = expectedDataDate();
    const validApiItems = apiItems.filter((i) => !isNoDataBook(i));
    const apiTotal = validApiItems.length;
    const freshCount = validApiItems.filter((i) => i.statDate && i.statDate >= expected).length;

    const pendingTip = pendingCount ? `，${pendingCount} 本暂无数据已在书单中` : '';
    const savedTip = saved ? `已记录 ${saved} 本书（${dates.join(' / ')}）` : '没有正式数据入库';
    if (!quiet) showToast(`✅ ${savedTip}${pendingTip}`, 'success');
    console.log(`[WAWA Stats] 已入库 ${saved} 本 → ${dates.join(', ') || '暂无正式日期'}；最新数据 ${freshCount}/${apiTotal} 本${pendingTip}`);
    if (statsModal && statsModal.isOpen()) {
      statsModal.refresh();
    }
    return { dates, books, freshCount, total: apiTotal, saved, pendingCount };
  }

  // ========== 自动触发：智能静默轮询 ==========
  // 服务器数据每天 14:00 起陆续更新（每本书时间不同，可能持续到 14:30+）。
  // 策略：页面打开静默采一次；若有书落后于期望日期，在 14:00~17:00 窗口内
  // 每 5 分钟纯 API 静默重采，直到所有书都拿到最新数据；窗口外等下一个 14:00。
  let autoCapturing = false;
  let pollTimer = null;
  let pollAttempts = 0;

  function debounce(fn, wait) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // 距离下一个北京时间 14:00 的毫秒数（加 1 分钟缓冲）
  function msUntilNextUpdateWindow() {
    const p = beijingParts();
    const nowMins = p.hour * 60 + p.minute;
    let diffMins = UPDATE_START_HOUR * 60 - nowMins;
    if (diffMins <= 0) diffMins += 24 * 60;
    return (diffMins + 1) * 60 * 1000;
  }

  function scheduleSync(delayMs, resetAttempts) {
    if (pollTimer) clearTimeout(pollTimer);
    if (resetAttempts) pollAttempts = 0;
    pollTimer = setTimeout(syncTick, delayMs);
  }

  async function syncTick() {
    pollTimer = null;

    // 后台标签页不发请求，等下个间隔再试
    if (document.visibilityState === 'hidden') {
      scheduleSync(POLL_INTERVAL_MS, false);
      return;
    }
    if (autoCapturing) {
      scheduleSync(POLL_INTERVAL_MS, false);
      return;
    }

    autoCapturing = true;
    let result = null;
    try {
      result = await captureNow({ quiet: true });
    } catch (e) {
      console.error('[WAWA Stats] 自动同步失败', e);
    } finally {
      autoCapturing = false;
    }

    if (result && result.total === 0 && result.pendingCount > 0) {
      console.log('[WAWA Stats] 当前仅有暂无数据的书，等待下一个更新窗口');
      scheduleSync(msUntilNextUpdateWindow(), true);
      return;
    }

    const complete = result && result.total > 0 && result.freshCount >= result.total;
    if (complete) {
      console.log(`[WAWA Stats] ✅ 全部 ${result.total} 本书已同步到最新数据（${result.dates.join(', ')}），等待下一个更新窗口`);
      scheduleSync(msUntilNextUpdateWindow(), true);
      return;
    }

    const p = beijingParts();
    const inWindow = p.hour >= UPDATE_START_HOUR && p.hour < POLL_DEADLINE_HOUR;
    if (!inWindow) {
      // 窗口外数据不齐说明服务器还没出新数据，等下一个 14:00
      console.log(`[WAWA Stats] 同步进度 ${result ? `${result.freshCount}/${result.total}` : '失败'}，等待下一个 14:00 更新窗口`);
      scheduleSync(msUntilNextUpdateWindow(), true);
      return;
    }
    if (pollAttempts >= POLL_MAX_ATTEMPTS) {
      console.log('[WAWA Stats] 轮询达到次数上限，等待下一个更新窗口');
      scheduleSync(msUntilNextUpdateWindow(), true);
      return;
    }
    pollAttempts++;
    console.log(`[WAWA Stats] 同步进度 ${result ? `${result.freshCount}/${result.total}` : '失败'}，${POLL_INTERVAL_MS / 60000} 分钟后静默重试（第 ${pollAttempts} 次）`);
    scheduleSync(POLL_INTERVAL_MS, false);
  }

  function observeCards() {
    let started = false;
    let observer = null;

    const tryStart = debounce(() => {
      if (started) return;
      if (!document.querySelector('.submission-item')) return;
      started = true;
      if (observer) observer.disconnect();
      // 卡片渲染稳定后启动第一次静默同步，后续节奏由 syncTick 自己接管
      scheduleSync(AUTO_CAPTURE_DELAY, true);
    }, 1200);

    observer = new MutationObserver(tryStart);
    observer.observe(document.body, { childList: true, subtree: true });
    tryStart();
  }

  // ========== UI：浮动按钮 / Toast / Banner ==========
  function addFloatingButtons() {
    if (document.getElementById('wawaFab')) return;
    const fab = document.createElement('div');
    fab.id = 'wawaFab';
    fab.innerHTML = `
      <button id="wawaStatsBtn" title="打开统计">📊</button>
      <button id="wawaCaptureBtn" title="立即采集">📥</button>
    `;
    fab.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(fab);

    document.getElementById('wawaStatsBtn').addEventListener('click', openStatsModal);
    document.getElementById('wawaCaptureBtn').addEventListener('click', async () => {
      // 数据按每本书自己的 statDate 入库，任何时间手动采集都不会记错日期
      await captureNow({ force: true });
    });
  }

  function showToast(msg, type = 'info') {
    const id = 'wawaToast';
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:9999999;padding:10px 18px;border-radius:10px;font-size:14px;box-shadow:0 6px 24px rgba(0,0,0,.14);transition:opacity .3s;pointer-events:none;max-width:80vw;';
      document.body.appendChild(el);
    }
    const colors = {
      info: 'background:#1D2129;color:#fff;',
      success: 'background:#00B361;color:#fff;',
      warn: 'background:#FF8F1F;color:#fff;',
      error: 'background:#F53F3F;color:#fff;',
    };
    el.style.cssText += colors[type] || colors.info;
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2600);
  }

  function showBanner(msg) {
    let el = document.getElementById('wawaBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wawaBanner';
      el.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:9999999;padding:10px 18px;border-radius:10px;background:linear-gradient(109deg,#31C47A,#ABE425);color:#fff;font-size:14px;box-shadow:0 6px 24px rgba(0,0,0,.14);';
      document.body.appendChild(el);
    }
    el.textContent = msg;
  }

  function hideBanner() {
    const el = document.getElementById('wawaBanner');
    if (el) el.remove();
  }

  // ========== UI：统计弹窗 ==========
  let statsModal = null;
  let currentView = 'global';

  function openStatsModal() {
    if (!statsModal) {
      statsModal = createStatsModal();
    }
    statsModal.show();
  }

  function deleteBook(title) {
    if (!title) return;
    if (!confirm(`确定删除《${title}》的全部历史数据吗？\n此操作不可恢复。`)) return;
    const store = loadStore();
    store.records.forEach((rec) => {
      rec.books = (rec.books || []).filter((b) => b.title !== title);
    });
    store.records = store.records.filter((rec) => (rec.books || []).length > 0);
    store.pendingBooks = (Array.isArray(store.pendingBooks) ? store.pendingBooks : []).filter((b) => b.title !== title);
    saveStore(store);
    showToast(`已删除《${title}》的全部数据`, 'success');
    if (statsModal && statsModal.isOpen()) {
      populateBookSelect();
      renderStats();
    }
  }

  function createStatsModal() {
    const root = document.createElement('div');
    root.id = 'wawaStatsRoot';
    root.style.cssText = 'position:fixed;inset:0;z-index:9999998;display:none;align-items:center;justify-content:center;';
    root.innerHTML = `
      <div class="wawa-mask"></div>
      <div class="wawa-modal">
        <div class="wawa-modal-header">
          <div class="wawa-title">
            <h2>📊 WAWA 数据中心</h2>
            <span class="wawa-subtitle">投稿数据 · 本地存储 · 每日更新</span>
          </div>
          <div class="wawa-header-actions">
            <button id="wawaExportCsv" class="wawa-btn-ghost">导出 CSV</button>
            <button id="wawaStatsClose" class="wawa-btn-close">×</button>
          </div>
        </div>
        <div class="wawa-tabs">
          <button class="wawa-tab active" data-view="global">全局概览</button>
          <button class="wawa-tab" data-view="book">单书详情</button>
        </div>
        <div class="wawa-modal-body">
          <div id="wawaGlobalView" class="wawa-view">
            <div id="wawaSummary" class="wawa-summary-grid"></div>
            <div class="wawa-dashboard-grid">
              <div class="wawa-card wawa-span-2">
                <div class="wawa-card-title">📈 全站单日收益趋势</div>
                <div id="wawaGlobalTrend" class="wawa-chart-box"></div>
              </div>
              <div class="wawa-card">
                <div class="wawa-card-title">🥧 今日收益占比</div>
                <div id="wawaRevenueDonut" class="wawa-donut-box"></div>
              </div>
              <div class="wawa-card wawa-span-2">
                <div class="wawa-card-title">👥 全站在读趋势</div>
                <div id="wawaReaderTrend" class="wawa-chart-box"></div>
              </div>
              <div class="wawa-card">
                <div class="wawa-card-title">🍩 在读人数分布</div>
                <div id="wawaReaderDonut" class="wawa-donut-box"></div>
              </div>
              <div class="wawa-card wawa-span-2">
                <div class="wawa-card-title">💹 全站累计总收益趋势</div>
                <div id="wawaCumulativeTrend" class="wawa-chart-box"></div>
              </div>
              <div class="wawa-card">
                <div class="wawa-card-title">📅 近7日 vs 前7日</div>
                <div id="wawaWeekCompare" class="wawa-compare-box"></div>
              </div>
              <div class="wawa-card wawa-span-2">
                <div class="wawa-card-title">💰 今日收益</div>
                <div id="wawaEarningList" class="wawa-list-box"></div>
              </div>
              <div class="wawa-card">
                <div class="wawa-card-title">🗓️ 月度统计</div>
                <div id="wawaMonthly" class="wawa-table-box wawa-monthly-box"></div>
              </div>
              <div class="wawa-card wawa-span-all">
                <div class="wawa-card-title">📚 全部书籍总览</div>
                <div id="wawaAllBooks" class="wawa-table-box"></div>
              </div>
            </div>
          </div>
          <div id="wawaBookView" class="wawa-view" style="display:none">
            <div class="wawa-toolbar">
              <select id="wawaBookSelect"></select>
            </div>
            <div id="wawaBookSummary" class="wawa-summary-grid"></div>
            <div class="wawa-card">
              <div class="wawa-card-title">💰 单日收益趋势</div>
              <div id="wawaBookRevenueChart" class="wawa-chart-box"></div>
            </div>
            <div class="wawa-card">
              <div class="wawa-card-title">👥 在读人数趋势</div>
              <div id="wawaBookReaderChart" class="wawa-chart-box"></div>
            </div>
            <div class="wawa-card"><div id="wawaTableWrap" class="wawa-table-box"></div></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    root.querySelector('.wawa-mask').addEventListener('click', () => root.style.display = 'none');
    root.querySelector('#wawaStatsClose').addEventListener('click', () => root.style.display = 'none');
    root.querySelector('#wawaExportCsv').addEventListener('click', exportCsv);

    root.querySelectorAll('.wawa-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    });
    root.querySelector('#wawaBookSelect').addEventListener('change', renderBookView);
    root.addEventListener('click', (e) => {
      const del = e.target.closest('[data-action="delete-book"]');
      if (del) {
        deleteBook(del.getAttribute('data-title'));
        return;
      }
      const btn = e.target.closest('[data-action="view-book"]');
      if (btn) switchToBook(btn.getAttribute('data-title'));
    });

    const api = {
      root,
      show() {
        root.style.display = 'flex';
        switchView('global');
        populateBookSelect();
        renderStats();
      },
      hide() { root.style.display = 'none'; },
      isOpen() { return root.style.display === 'flex'; },
      refresh() {
        if (root.style.display === 'flex') {
          populateBookSelect();
          renderStats();
        }
      },
    };
    return api;
  }

  function switchView(view) {
    currentView = view;
    const root = document.getElementById('wawaStatsRoot');
    if (!root) return;
    root.querySelectorAll('.wawa-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.view === view);
    });
    const globalView = document.getElementById('wawaGlobalView');
    const bookView = document.getElementById('wawaBookView');
    if (globalView) globalView.style.display = view === 'global' ? '' : 'none';
    if (bookView) bookView.style.display = view === 'book' ? '' : 'none';
    renderStats();
  }

  function switchToBook(title) {
    populateBookSelect(title);
    switchView('book');
  }

  function populateBookSelect(preferred) {
    const select = document.getElementById('wawaBookSelect');
    if (!select) return;
    const store = loadStore();
    const titles = new Set();
    store.records.forEach((r) => r.books.forEach((b) => titles.add(b.title)));
    (Array.isArray(store.pendingBooks) ? store.pendingBooks : []).forEach((p) => titles.add(p.title));
    const list = Array.from(titles).sort((a, b) => a.localeCompare(b, 'zh'));
    const current = select.value;
    select.innerHTML = list.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    if (list.length === 0) {
      select.innerHTML = '<option value="">暂无数据</option>';
    } else if (preferred && list.includes(preferred)) {
      select.value = preferred;
    } else if (current && list.includes(current)) {
      select.value = current;
    }
  }

  function getSelectedBook() {
    const select = document.getElementById('wawaBookSelect');
    return select ? select.value : '';
  }

  function renderStats() {
    if (currentView === 'global') renderGlobalView();
    else renderBookView();
  }

  // 每本书的新增在读：优先用接口算好的 readerDelta，老数据回退到 readers - previousReaders
  function bookReaderDelta(b) {
    if (b.readerDelta != null) return toNum(b.readerDelta);
    if (b.readers != null && b.previousReaders != null) return toNum(b.readers) - toNum(b.previousReaders);
    return null;
  }

  function renderGlobalView() {
    const store = loadStore();
    const records = store.records || [];
    const summaryEl = document.getElementById('wawaSummary');
    if (!summaryEl) return;

    const setEmpty = (id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="wawa-empty">暂无数据</div>';
    };

    const pendingBooks = Array.isArray(store.pendingBooks) ? store.pendingBooks : [];

    if (!records.length && !pendingBooks.length) {
      summaryEl.innerHTML = statCard('提示', '还没有数据，请先采集');
      ['wawaGlobalTrend', 'wawaReaderTrend', 'wawaCumulativeTrend', 'wawaRevenueDonut', 'wawaReaderDonut', 'wawaWeekCompare', 'wawaMonthly', 'wawaEarningList', 'wawaAllBooks'].forEach(setEmpty);
      return;
    }

    // 不同书可能在不同日期更新，这里汇总每本书最新的一条真实记录。
    // 今天/未来日期、没有在读人数的占位快照都不参与数据日期与“未更新”判断。
    const latestBooksMap = new Map();
    records.forEach((rec) => {
      (rec.books || []).forEach((b) => {
        if (!b.title || isNoDataBook(b)) return;
        const existing = latestBooksMap.get(b.title);
        if (!existing || rec.date > existing._recDate) {
          latestBooksMap.set(b.title, { ...b, _recDate: rec.date });
        }
      });
    });
    const books = Array.from(latestBooksMap.values());

    // 全站书籍总览/下拉里包含暂无数据的待正式书籍；已有真实数据的同名书优先显示真实数据
    const allBooksMap = new Map(books.map((b) => [b.title, b]));
    pendingBooks.forEach((p) => {
      if (!allBooksMap.has(p.title)) allBooksMap.set(p.title, { ...p, _isPending: true, _recDate: '' });
    });
    const allBooks = Array.from(allBooksMap.values());

    // 当前数据日期 = 各真实书最新记录中最大的日期。
    // 只有更新到这一天的书才计入“今日”类汇总，避免把旧日期的增量混进来。
    const dataDate = books.reduce((max, b) => (b._recDate > max ? b._recDate : max), '');
    books.forEach((b) => { b._isFresh = b._recDate === dataDate; });
    const freshBooks = books.filter((b) => b._isFresh);
    const staleCount = books.length - freshBooks.length;

    const earningBooks = freshBooks.filter((b) => toNum(b.dailyRevenue) > 0);
    const totalDaily = freshBooks.reduce((s, b) => s + toNum(b.dailyRevenue), 0);
    const totalRevenueAll = books.reduce((s, b) => s + toNum(b.totalRevenue), 0);
    const totalReaders = books.reduce((s, b) => s + (b.readers == null ? 0 : toNum(b.readers)), 0);

    // 今日新增在读：只统计已更新到 dataDate 的书。
    // 下降的在读不放进“新增在读”里互相抵消，单独记到“今日在读下降”。
    let newReadersTotal = 0;
    let declinedReadersTotal = 0;
    let hasReaderDelta = false;
    freshBooks.forEach((b) => {
      const d = bookReaderDelta(b);
      if (d == null) return;
      hasReaderDelta = true;
      if (d > 0) newReadersTotal += d;
      else if (d < 0) declinedReadersTotal += Math.abs(d);
    });

    summaryEl.innerHTML = [
      statCard('数据日期', dataDate || '暂无正式数据'),
      statCard('更新进度', books.length ? (staleCount ? `${freshBooks.length}/${books.length} 本` : '已全部更新') : '暂无正式数据', books.length && staleCount ? 'warn' : ''),
      statCard('追踪书籍', String(allBooks.length)),
      statCard('记录天数', String(records.length)),
      statCard('今日总收益', '¥' + totalDaily.toFixed(2)),
      statCard('今日有收益', String(earningBooks.length) + ' 本'),
      statCard('所有书总收益', '¥' + totalRevenueAll.toFixed(2)),
      statCard('总在读', fmtNum(totalReaders)),
      statCard('今日新增在读', hasReaderDelta ? (newReadersTotal > 0 ? '+' : '') + fmtNum(newReadersTotal) : '无'),
      statCard('今日在读下降', declinedReadersTotal > 0 ? '-' + fmtNum(declinedReadersTotal) : '0'),
    ].join('');

    // 只把“真实数据日期快照”画进全站趋势，过滤掉占位快照与零星/伪造日期
    const totalTrackedBooks = books.length;
    const trendRecords = records
      .map((r) => ({ ...r, books: (r.books || []).filter((b) => !isNoDataBook(b)) }))
      .filter((r) => {
        if (!r.books.length) return false;
        if (r.books.length < (totalTrackedBooks > 1 ? 2 : 1)) return false;
        // 快照日期必须至少有一本书的 statDate 与记录日期一致
        return r.books.some((b) => b.statDate === r.date);
      });
    const trendData = trendRecords.map((r) => ({
      date: r.date,
      value: (r.books || []).reduce((s, b) => s + toNum(b.dailyRevenue), 0),
    }));
    drawLineChart(document.getElementById('wawaGlobalTrend'), trendData, '全站单日收益（元）');

    const readerTrendData = trendRecords.map((r) => ({
      date: r.date,
      value: (r.books || []).reduce((s, b) => s + (b.readers == null ? 0 : toNum(b.readers)), 0),
    }));
    drawLineChart(document.getElementById('wawaReaderTrend'), readerTrendData, '全站在读人数（人）');

    // 累计总收益趋势：每个日期对每本书取“当日或之前最近一次”的 totalRevenue（carry-forward），
    // 避免某本书某天缺记录导致曲线下凹
    const trendDates = new Set(trendRecords.map((r) => r.date));
    const lastKnownTotal = new Map();
    const cumulativeData = [];
    records.forEach((rec) => {
      (rec.books || []).forEach((b) => {
        if (isNoDataBook(b)) return;
        if (b.totalRevenue != null) lastKnownTotal.set(b.title, toNum(b.totalRevenue));
      });
      if (trendDates.has(rec.date)) {
        let sum = 0;
        lastKnownTotal.forEach((v) => { sum += v; });
        cumulativeData.push({ date: rec.date, value: Math.round(sum * 100) / 100 });
      }
    });
    drawLineChart(document.getElementById('wawaCumulativeTrend'), cumulativeData, '全站累计总收益（元）');

    renderWeekCompare(document.getElementById('wawaWeekCompare'), trendRecords);
    renderMonthlyStats(document.getElementById('wawaMonthly'), trendRecords);

    const revenueItems = earningBooks
      .map((b) => ({ label: b.title, value: toNum(b.dailyRevenue) }))
      .sort((a, b) => b.value - a.value);
    drawDonutChart(document.getElementById('wawaRevenueDonut'), revenueItems, '今日收益');

    const readerItems = books
      .filter((b) => b.readers != null && toNum(b.readers) > 0)
      .map((b) => ({ label: b.title, value: toNum(b.readers) }))
      .sort((a, b) => b.value - a.value);
    drawDonutChart(document.getElementById('wawaReaderDonut'), readerItems, '在读人数');

    // 今日有收益的书
    const earningEl = document.getElementById('wawaEarningList');
    if (!earningBooks.length) {
      earningEl.innerHTML = books.length ? '<div class="wawa-empty">零蛋！</div>' : '<div class="wawa-empty">暂无正式收益数据</div>';
    } else {
      earningEl.innerHTML = earningBooks.map((b) => {
        const d = bookReaderDelta(b);
        return `
        <div class="wawa-earning-row">
          <div class="wawa-earning-main">
            <div class="wawa-earning-title">${escapeHtml(b.title)}</div>
            <div class="wawa-earning-meta">昨日 ${(round2(b.yesterdayDelta ?? 0) >= 0 ? '+' : '') + round2(b.yesterdayDelta ?? 0)} · 在读 ${b.readers == null ? '-' : b.readers + ' 人'}${d == null ? '' : ` · 新增 ${d > 0 ? '+' : ''}${d}`}</div>
          </div>
          <div class="wawa-earning-amount">+¥${toNum(b.dailyRevenue).toFixed(2)}</div>
        </div>
      `;
      }).join('');
    }

    // 全部书籍总览
    const allBooksEl = document.getElementById('wawaAllBooks');
    if (!allBooks.length) {
      allBooksEl.innerHTML = '<div class="wawa-empty">暂无书籍数据</div>';
      return;
    }
    const head = '<tr><th>书名</th><th>数据日期</th><th>状态</th><th>总字数</th><th>总收益</th><th>今日收益</th><th>昨日</th><th>在读</th><th>新增在读</th><th></th></tr>';
    const rows = allBooks
      .slice()
      .sort((a, b) => {
        if (!!a._isPending !== !!b._isPending) return a._isPending ? 1 : -1;
        return toNum(b.totalRevenue) - toNum(a.totalRevenue) || toNum(b.readers) - toNum(a.readers) || a.title.localeCompare(b.title, 'zh');
      })
      .map((b) => {
        const isPending = !!b._isPending;
        const readerDelta = isPending ? null : bookReaderDelta(b);
        const dateCell = isPending
          ? '<span class="wawa-badge-stale">暂无数据</span>'
          : escapeHtml(b.statDate || b._recDate || '-') + (b._isFresh ? '' : ' <span class="wawa-badge-stale">未更新</span>');
        return `
      <tr class="${isPending || !b._isFresh ? 'wawa-row-stale' : ''}">
        <td class="wawa-book-title">${escapeHtml(b.title)}</td>
        <td>${dateCell}</td>
        <td>${b.status ? `<span class="wawa-badge">${escapeHtml(b.status)}</span>` : '-'}</td>
        <td>${escapeHtml(b.wordsText || '-')}</td>
        <td>${isPending ? '-' : '¥' + toNum(b.totalRevenue).toFixed(2)}</td>
        <td class="${isPending ? '' : (toNum(b.dailyRevenue) > 0 ? 'wawa-money' : '')}">${isPending ? '-' : '¥' + toNum(b.dailyRevenue).toFixed(2)}</td>
        <td class="${isPending ? '' : ((b.yesterdayDelta || 0) >= 0 ? 'wawa-up' : 'wawa-down')}">${isPending ? '-' : ((round2(b.yesterdayDelta ?? 0) >= 0 ? '+' : '') + round2(b.yesterdayDelta ?? 0))}</td>
        <td>${b.readers == null ? '-' : b.readers + ' 人'}</td>
        <td class="${readerDelta == null ? '' : (readerDelta >= 0 ? 'wawa-up' : 'wawa-down')}">${isPending ? '-' : (readerDelta == null ? '无' : (readerDelta > 0 ? '+' : '') + readerDelta)}</td>
        <td>
          <button class="wawa-btn-link" data-action="view-book" data-title="${escapeHtml(b.title)}">查看</button>
          <button class="wawa-btn-link wawa-btn-danger" data-action="delete-book" data-title="${escapeHtml(b.title)}">删除</button>
        </td>
      </tr>
    `;
      }).join('');
    allBooksEl.innerHTML = `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  // 近7日 vs 前7日：收益与新增在读的环比对比
  function renderWeekCompare(container, trendRecords) {
    if (!container) return;
    if (!trendRecords.length) {
      container.innerHTML = '<div class="wawa-empty">暂无数据</div>';
      return;
    }
    const recent = trendRecords.slice(-7);
    const prev = trendRecords.slice(-14, -7);
    const sumRevenue = (recs) => recs.reduce((s, r) => s + (r.books || []).reduce((x, b) => x + toNum(b.dailyRevenue), 0), 0);
    const sumReaderDelta = (recs) => recs.reduce((s, r) => s + (r.books || []).reduce((x, b) => {
      const d = bookReaderDelta(b);
      return x + (d == null ? 0 : d);
    }, 0), 0);

    const blocks = [
      { label: '收益', cur: sumRevenue(recent), pre: prev.length ? sumRevenue(prev) : null, fmt: (v) => '¥' + v.toFixed(2) },
      { label: '新增在读', cur: sumReaderDelta(recent), pre: prev.length ? sumReaderDelta(prev) : null, fmt: (v) => fmtNum(v) + ' 人' },
    ];
    container.innerHTML = blocks.map((blk) => {
      let compareHtml = '<span class="wawa-compare-na">前7日数据不足，暂无对比</span>';
      if (blk.pre != null) {
        const diff = Math.round((blk.cur - blk.pre) * 100) / 100;
        const cls = diff >= 0 ? 'wawa-up' : 'wawa-down';
        const arrow = diff >= 0 ? '▲' : '▼';
        const pct = blk.pre !== 0 ? `（${diff >= 0 ? '+' : ''}${((diff / Math.abs(blk.pre)) * 100).toFixed(1)}%）` : '';
        compareHtml = `<span class="${cls}">${arrow} ${diff >= 0 ? '+' : ''}${fmtNum(diff)}${pct}</span> <span class="wawa-compare-na">vs 前${prev.length}天</span>`;
      }
      return `<div class="wawa-compare-block">
        <div class="wawa-compare-label">近${recent.length}日${blk.label}</div>
        <div class="wawa-compare-value">${blk.fmt(blk.cur)}</div>
        <div class="wawa-compare-diff">${compareHtml}</div>
      </div>`;
    }).join('');
  }

  // 月度统计：按月份汇总每日收益与新增在读（例如查看 7 月总收益）
  function renderMonthlyStats(container, trendRecords) {
    if (!container) return;
    if (!trendRecords.length) {
      container.innerHTML = '<div class="wawa-empty">暂无数据</div>';
      return;
    }
    const byMonth = new Map(); // '2026-07' -> { days, revenue, readerDelta }
    trendRecords.forEach((r) => {
      const month = r.date.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, { days: 0, revenue: 0, readerDelta: 0 });
      const m = byMonth.get(month);
      m.days++;
      (r.books || []).forEach((b) => {
        m.revenue += toNum(b.dailyRevenue);
        const d = bookReaderDelta(b);
        if (d != null) m.readerDelta += d;
      });
    });
    const months = Array.from(byMonth.entries()).sort((a, b) => b[0].localeCompare(a[0])); // 最新月份在前
    const head = '<tr><th>月份</th><th>收益</th><th>新增在读</th><th>记录</th></tr>';
    const rows = months.map(([month, m]) => `<tr>
      <td>${escapeHtml(month)}</td>
      <td class="${m.revenue > 0 ? 'wawa-money' : ''}">¥${m.revenue.toFixed(2)}</td>
      <td class="${m.readerDelta >= 0 ? 'wawa-up' : 'wawa-down'}">${m.readerDelta > 0 ? '+' : ''}${fmtNum(m.readerDelta)}</td>
      <td>${m.days} 天</td>
    </tr>`).join('');
    container.innerHTML = `<table class="wawa-table-compact"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  // 构建单书按 statDate 去重后的时间序列（renderBookView / exportCsv 共用）
  function buildBookSeries(records, bookTitle) {
    const seen = new Map();
    (records || []).forEach((rec) => {
      const book = (rec.books || []).find((b) => b.title === bookTitle);
      if (!book || !book.statDate || isNoDataBook(book)) return;
      const key = book.statDate;
      const existing = seen.get(key);
      if (!existing || rec.date > existing.recDate) {
        seen.set(key, { date: key, book, recDate: rec.date });
      }
    });
    const series = Array.from(seen.values()).sort((a, b) => a.date.localeCompare(b.date));
    // 逐条算新增在读：优先接口给的 readerDelta；老数据回退为与上一条的差值（仅相邻 1 天时才可比）
    series.forEach((s, i) => {
      let delta = bookReaderDelta(s.book);
      if (delta == null && i > 0) {
        const prev = series[i - 1];
        if (dateOffsetStr(s.date, -1) === prev.date && s.book.readers != null && prev.book.readers != null) {
          delta = toNum(s.book.readers) - toNum(prev.book.readers);
        }
      }
      s.delta = delta;
    });
    return series;
  }

  function renderBookView() {
    const store = loadStore();
    const bookTitle = getSelectedBook();
    const summaryEl = document.getElementById('wawaBookSummary');
    const revenueChartEl = document.getElementById('wawaBookRevenueChart');
    const readerChartEl = document.getElementById('wawaBookReaderChart');
    const tableWrap = document.getElementById('wawaTableWrap');
    if (!revenueChartEl || !readerChartEl || !tableWrap) return;

    const series = bookTitle ? buildBookSeries(store.records, bookTitle) : [];

    if (!series.length) {
      const pendingBook = bookTitle && (Array.isArray(store.pendingBooks) ? store.pendingBooks : []).find((p) => p.title === bookTitle);
      if (pendingBook) {
        if (summaryEl) {
          summaryEl.innerHTML = [
            statCard('最新数据日期', '暂无数据'),
            statCard('状态', pendingBook.status || '刚签约，暂无正式数据'),
            statCard('总字数', pendingBook.wordsText || '-'),
          ].join('');
        }
        revenueChartEl.innerHTML = '<div class="wawa-empty">该书暂无正式数据，等站点更新后会自动开始记录</div>';
        readerChartEl.innerHTML = '';
        tableWrap.innerHTML = '';
        return;
      }
      if (summaryEl) summaryEl.innerHTML = '';
      revenueChartEl.innerHTML = '<div class="wawa-empty">请选择一本书查看详情</div>';
      readerChartEl.innerHTML = '<div class="wawa-empty">暂无数据</div>';
      tableWrap.innerHTML = '';
      return;
    }

    const latest = series[series.length - 1];
    if (summaryEl) {
      summaryEl.innerHTML = [
        statCard('最新数据日期', latest.date),
        statCard('累计总收益', '¥' + toNum(latest.book.totalRevenue).toFixed(2)),
        statCard('最新单日收益', '¥' + toNum(latest.book.dailyRevenue).toFixed(2)),
        statCard('在读人数', latest.book.readers == null ? '-' : fmtNum(toNum(latest.book.readers))),
        statCard('最新新增在读', latest.delta == null ? '无' : (latest.delta > 0 ? '+' : '') + fmtNum(latest.delta)),
        statCard('已记录天数', String(series.length)),
      ].join('');
    }

    drawLineChart(
      revenueChartEl,
      series.map((s) => ({ date: s.date, value: toNum(s.book.dailyRevenue) })),
      '单日收益（元）'
    );
    drawLineChart(
      readerChartEl,
      series.map((s) => ({ date: s.date, value: s.book.readers == null ? null : toNum(s.book.readers) })),
      '在读人数（人）'
    );

    const head = '<tr><th>日期</th><th>单日收益</th><th>累计总收益</th><th>在读</th><th>新增在读</th></tr>';
    const rows = series.slice().reverse().map((s) => {
      const b = s.book;
      return `<tr>
        <td>${escapeHtml(s.date)}</td>
        <td class="${toNum(b.dailyRevenue) > 0 ? 'wawa-money' : ''}">¥${toNum(b.dailyRevenue).toFixed(2)}</td>
        <td>¥${toNum(b.totalRevenue).toFixed(2)}</td>
        <td>${b.readers == null ? '-' : fmtNum(toNum(b.readers)) + ' 人'}</td>
        <td class="${s.delta == null ? '' : (s.delta >= 0 ? 'wawa-up' : 'wawa-down')}">${s.delta == null ? '-' : (s.delta > 0 ? '+' : '') + s.delta}</td>
      </tr>`;
    }).join('');
    tableWrap.innerHTML = `<table class="wawa-table-compact"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  function statCard(label, value, variant = '') {
    return `<div class="wawa-stat-card${variant ? ' wawa-stat-' + variant : ''}">
      <div class="wawa-stat-label">${escapeHtml(label)}</div>
      <div class="wawa-stat-value">${escapeHtml(value)}</div>
    </div>`;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ========== SVG 折线图 ==========
  function drawLineChart(container, data, label) {
    const W = 820;
    const H = 280;
    const PL = 60;
    const PR = 24;
    const PT = 24;
    const PB = 40;
    const values = data.map((d) => d.value).filter((v) => v !== null && Number.isFinite(v));

    if (!values.length) {
      container.innerHTML = '<div style="padding:60px;text-align:center;color:#86909C;">暂无数据，请先采集。</div>';
      return;
    }

    const rawMax = Math.max(...values);
    const rawMin = Math.min(0, ...values);
    // 动态上限：取最高点向上取整；全 0 时也至少显示到 1
    const yMax = Math.max(Math.ceil(rawMax), 1);
    const yMin = Math.min(0, Math.floor(rawMin));
    const yRange = yMax - yMin || 1;

    let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;font-family:system-ui,-apple-system,sans-serif;">`;
    svg += `<defs><linearGradient id="wawaArea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#31C47A" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#31C47A" stop-opacity="0.02"/>
    </linearGradient></defs>`;

    // 横网格 + Y 轴
    const gridCount = 4;
    for (let i = 0; i <= gridCount; i++) {
      const y = PT + (H - PT - PB) * i / gridCount;
      const val = yMax - (yRange * i / gridCount);
      svg += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="#EEF0F3" stroke-width="1"/>`;
      svg += `<text x="${PL - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="#86909C">${fmtNum(val)}</text>`;
    }

    // X 轴标签
    const labelStep = Math.max(1, Math.ceil(data.length / 8));
    data.forEach((d, i) => {
      if (i % labelStep !== 0 && i !== data.length - 1) return;
      const x = PL + (data.length === 1 ? 0 : i * (W - PL - PR) / (data.length - 1));
      const shortDate = d.date.length >= 10 ? d.date.slice(5) : d.date;
      svg += `<text x="${x}" y="${H - 14}" text-anchor="middle" font-size="11" fill="#86909C">${escapeHtml(shortDate)}</text>`;
    });

    // 折线 / 面积
    const pts = data.map((d, i) => {
      if (d.value == null || !Number.isFinite(d.value)) return null;
      const x = PL + (data.length === 1 ? 0 : i * (W - PL - PR) / (data.length - 1));
      const y = PT + (H - PT - PB) - ((d.value - yMin) / yRange) * (H - PT - PB);
      return { x, y, d };
    });

    const validPts = pts.filter(Boolean);
    if (validPts.length) {
      const linePath = validPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
      const areaPath = linePath + ` L${validPts[validPts.length - 1].x.toFixed(2)},${H - PB} L${validPts[0].x.toFixed(2)},${H - PB} Z`;
      svg += `<path d="${areaPath}" fill="url(#wawaArea)"/>`;
      svg += `<path d="${linePath}" fill="none" stroke="#31C47A" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      validPts.forEach((p) => {
        svg += `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="3.5" fill="#fff" stroke="#31C47A" stroke-width="2"/>`;
      });
    }

    svg += `<text x="${PL}" y="16" font-size="12" fill="#86909C">${escapeHtml(label)}</text>`;
    svg += '</svg>';
    container.style.position = 'relative';
    container.innerHTML = svg + '<div class="wawa-chart-tip" style="display:none"></div>';
    const svgEl = container.querySelector('svg');
    const tip = container.querySelector('.wawa-chart-tip');
    if (svgEl && tip && validPts.length) {
      svgEl.addEventListener('mousemove', (e) => {
        const rect = svgEl.getBoundingClientRect();
        const scaleX = W / rect.width;
        const x = (e.clientX - rect.left) * scaleX;
        let nearest = null;
        let minDist = Infinity;
        validPts.forEach((p) => {
          const dist = Math.abs(p.x - x);
          if (dist < minDist) {
            minDist = dist;
            nearest = p;
          }
        });
        if (nearest) {
          tip.style.display = 'block';
          tip.textContent = `${nearest.d.date}：${fmtNum(nearest.d.value)}`;
          // 先隐藏测量宽度，避免在容器外渲染造成抖动/滚动条
          tip.style.left = '0px';
          tip.style.visibility = 'hidden';
          const tipWidth = tip.offsetWidth;
          tip.style.visibility = '';
          const offsetX = e.clientX - rect.left;
          const gap = 14;
          const rightPlaceLeft = offsetX + gap;
          let left = rightPlaceLeft;
          // 右侧空间不足时翻转到鼠标左侧，保证最右边的最新数据提示也能完整显示
          if (rightPlaceLeft + tipWidth > rect.width) {
            left = offsetX - tipWidth - gap;
          }
          left = Math.max(0, Math.min(left, rect.width - tipWidth));
          tip.style.left = left + 'px';
          tip.style.top = (e.clientY - rect.top - 8) + 'px';
        }
      });
      svgEl.addEventListener('mouseleave', () => {
        tip.style.display = 'none';
      });
    }
  }

  const DONUT_COLORS = ['#31C47A', '#4E8CF5', '#F7B500', '#F53F3F', '#8B5CF6', '#06B6D4', '#F472B6', '#84CC16', '#F97316', '#64748B'];

  function drawDonutChart(container, items, label) {
    if (!container) return;
    const validItems = (items || []).filter((i) => toNum(i.value) > 0);
    const total = validItems.reduce((s, i) => s + toNum(i.value), 0);
    if (!total) {
      container.innerHTML = '<div class="wawa-empty">暂无数据</div>';
      return;
    }

    // 超过 8 项时合并为“其他”
    const top = validItems.slice(0, 8);
    const restValue = validItems.slice(8).reduce((s, i) => s + toNum(i.value), 0);
    if (restValue > 0) top.push({ label: '其他', value: restValue });

    const R = 62;
    const C = 2 * Math.PI * R;
    let cumulative = 0;
    let svg = `<svg viewBox="0 0 180 180" style="width:170px;height:170px;display:block;">
      <circle cx="90" cy="90" r="${R}" fill="none" stroke="#F1F3F5" stroke-width="20"/>`;
    top.forEach((item, idx) => {
      const frac = toNum(item.value) / total;
      const dash = frac * C;
      const offset = -cumulative * C;
      const color = DONUT_COLORS[idx % DONUT_COLORS.length];
      svg += `<circle cx="90" cy="90" r="${R}" fill="none" stroke="${color}" stroke-width="20"
        stroke-dasharray="${dash.toFixed(3)} ${(C - dash).toFixed(3)}"
        stroke-dashoffset="${offset.toFixed(3)}"
        transform="rotate(-90 90 90)"><title>${escapeHtml(item.label)}：${fmtNum(item.value)}</title></circle>`;
      cumulative += frac;
    });
    svg += `<text x="90" y="85" text-anchor="middle" font-size="20" font-weight="700" fill="#1D2129">${fmtNum(total)}</text>
      <text x="90" y="106" text-anchor="middle" font-size="10" fill="#86909C">${escapeHtml(label)}</text>
      </svg>`;

    const legend = top.map((item, idx) => {
      const color = DONUT_COLORS[idx % DONUT_COLORS.length];
      return `<div class="wawa-legend-item"><span class="wawa-legend-dot" style="background:${color}"></span><span class="wawa-legend-label">${escapeHtml(item.label)}</span><span class="wawa-legend-value">${fmtNum(item.value)}</span></div>`;
    }).join('');

    container.innerHTML = `<div class="wawa-donut-wrap">${svg}<div class="wawa-legend">${legend}</div></div>`;
  }

  function fmtNum(n) {
    if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + '万';
    if (Number.isInteger(n)) return String(n);
    return Number(n).toFixed(2);
  }

  // ========== 导出 CSV ==========
  function exportCsv() {
    const store = loadStore();
    if (!store.records.length) {
      showToast('没有可导出的数据', 'warn');
      return;
    }
    const rows = [];
    rows.push(['日期', '书名', '章节', '总字数(万)', '总字数原文', '状态', '历史总收益', '单日收益', '昨日变化', '在读人数', '新增在读']);

    if (currentView === 'global') {
      store.records.forEach((rec) => {
        (rec.books || []).forEach((book) => {
          if (isNoDataBook(book)) return;
          rows.push([
            rec.date,
            book.title,
            book.chapterText || '',
            book.wordsWan == null ? '' : String(book.wordsWan),
            book.wordsText || '',
            book.status || '',
            book.totalRevenue == null ? '' : String(book.totalRevenue),
            book.dailyRevenue == null ? '' : String(book.dailyRevenue),
            book.yesterdayDelta == null ? '' : String(round2(book.yesterdayDelta)),
            book.readers == null ? '' : String(book.readers),
            bookReaderDelta(book) == null ? '' : String(bookReaderDelta(book)),
          ]);
        });
      });
    } else {
      const bookTitle = getSelectedBook();
      if (!bookTitle) {
        showToast('请先选择一本书', 'warn');
        return;
      }
      buildBookSeries(store.records, bookTitle).forEach((s) => {
        const book = s.book;
        rows.push([
          s.date,
          book.title,
          book.chapterText || '',
          book.wordsWan == null ? '' : String(book.wordsWan),
          book.wordsText || '',
          book.status || '',
          book.totalRevenue == null ? '' : String(book.totalRevenue),
          book.dailyRevenue == null ? '' : String(book.dailyRevenue),
          book.yesterdayDelta == null ? '' : String(round2(book.yesterdayDelta)),
          book.readers == null ? '' : String(book.readers),
          s.delta == null ? '' : String(s.delta),
        ]);
      });
    }

    if (rows.length === 1) {
      showToast('没有可导出的正式数据', 'warn');
      return;
    }

    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const fileName = currentView === 'global' ? 'wawa-all-books' : `wawa-${getSelectedBook().replace(/[\\/:*?"<>|]/g, '_')}`;
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('CSV 已导出', 'success');
  }

  // ========== 样式 ==========
  GM_addStyle(`
    #wawaFab button {
      width: 48px;
      height: 48px;
      border: none;
      border-radius: 50%;
      font-size: 20px;
      cursor: pointer;
      background: linear-gradient(135deg, #31C47A, #ABE425);
      color: #fff;
      box-shadow: 0 6px 18px rgba(49, 196, 122, .35);
      transition: transform .15s, box-shadow .15s;
    }
    #wawaFab button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 24px rgba(49, 196, 122, .45);
    }

    #wawaStatsRoot {
      font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #1D2129;
    }
    #wawaStatsRoot .wawa-mask {
      position: absolute;
      inset: 0;
      background: rgba(17, 24, 39, .5);
      backdrop-filter: blur(4px);
    }
    #wawaStatsRoot .wawa-modal {
      position: relative;
      width: min(1180px, 95vw);
      max-height: 92vh;
      background: #F6F8FA;
      border-radius: 20px;
      box-shadow: 0 24px 80px rgba(15, 23, 42, .28);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #wawaStatsRoot .wawa-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 24px 16px;
      background: #fff;
      border-bottom: 1px solid #EDF0F3;
    }
    #wawaStatsRoot .wawa-title h2 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      color: #111827;
    }
    #wawaStatsRoot .wawa-subtitle {
      font-size: 12px;
      color: #9AA1AB;
      margin-top: 2px;
      display: block;
    }
    #wawaStatsRoot .wawa-header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    #wawaStatsRoot .wawa-btn-ghost {
      border: 1px solid #E5E7EB;
      background: #fff;
      color: #374151;
      padding: 8px 16px;
      border-radius: 10px;
      font-size: 13px;
      cursor: pointer;
      transition: background .15s, border-color .15s;
    }
    #wawaStatsRoot .wawa-btn-ghost:hover {
      background: #F3F4F6;
      border-color: #D1D5DB;
    }
    #wawaStatsRoot .wawa-btn-close {
      width: 34px;
      height: 34px;
      border: none;
      border-radius: 10px;
      background: #F3F4F6;
      color: #6B7280;
      font-size: 18px;
      cursor: pointer;
      transition: background .15s;
    }
    #wawaStatsRoot .wawa-btn-close:hover {
      background: #E5E7EB;
    }

    #wawaStatsRoot .wawa-tabs {
      display: flex;
      gap: 4px;
      padding: 0 24px;
      background: #fff;
      border-bottom: 1px solid #EDF0F3;
    }
    #wawaStatsRoot .wawa-tab {
      padding: 12px 18px;
      border: none;
      background: transparent;
      font-size: 14px;
      color: #6B7280;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color .15s, border-color .15s;
    }
    #wawaStatsRoot .wawa-tab.active {
      color: #0F9D58;
      border-bottom-color: #0F9D58;
      font-weight: 600;
    }

    #wawaStatsRoot .wawa-modal-body {
      padding: 20px 24px 28px;
      overflow: auto;
    }
    #wawaStatsRoot .wawa-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    #wawaStatsRoot .wawa-stat-card {
      background: #fff;
      border: 1px solid #EDF0F3;
      border-radius: 14px;
      padding: 14px 16px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .03);
      transition: transform .15s, box-shadow .15s, border-color .15s;
    }
    #wawaStatsRoot .wawa-stat-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(15, 23, 42, .08);
      border-color: #D7F0E3;
    }
    #wawaStatsRoot .wawa-stat-label {
      font-size: 12px;
      color: #9AA1AB;
      margin-bottom: 4px;
    }
    #wawaStatsRoot .wawa-stat-value {
      font-size: 20px;
      font-weight: 700;
      color: #111827;
      line-height: 1.2;
    }

    #wawaStatsRoot .wawa-dashboard-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }
    #wawaStatsRoot .wawa-span-2 { grid-column: span 2; }
    #wawaStatsRoot .wawa-span-all { grid-column: 1 / -1; }
    @media (max-width: 900px) {
      #wawaStatsRoot .wawa-dashboard-grid {
        grid-template-columns: 1fr;
      }
      #wawaStatsRoot .wawa-span-2 { grid-column: span 1; }
    }

    #wawaStatsRoot .wawa-card {
      background: #fff;
      border: 1px solid #EDF0F3;
      border-radius: 16px;
      padding: 16px 18px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .03);
      min-width: 0;
    }
    #wawaStatsRoot .wawa-card-title {
      font-size: 14px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 12px;
    }
    #wawaStatsRoot .wawa-chart-box {
      overflow-x: auto;
      position: relative;
    }
    #wawaStatsRoot .wawa-chart-tip {
      position: absolute;
      pointer-events: none;
      background: rgba(17, 24, 39, .92);
      color: #fff;
      padding: 4px 9px;
      border-radius: 6px;
      font-size: 12px;
      white-space: nowrap;
      z-index: 10;
      transform: translateY(-100%);
      box-shadow: 0 4px 12px rgba(0, 0, 0, .18);
    }
    #wawaStatsRoot .wawa-donut-box {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 180px;
    }
    #wawaStatsRoot .wawa-compare-box {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 180px;
      justify-content: center;
    }
    #wawaStatsRoot .wawa-compare-block {
      padding: 12px 14px;
      border-radius: 12px;
      background: #F8FAFB;
      border: 1px solid #F1F3F5;
    }
    #wawaStatsRoot .wawa-compare-label {
      font-size: 12px;
      color: #9AA1AB;
      margin-bottom: 4px;
    }
    #wawaStatsRoot .wawa-compare-value {
      font-size: 20px;
      font-weight: 700;
      color: #111827;
      line-height: 1.2;
    }
    #wawaStatsRoot .wawa-compare-diff {
      font-size: 12px;
      margin-top: 4px;
      font-weight: 600;
    }
    #wawaStatsRoot .wawa-compare-na {
      color: #9AA1AB;
      font-weight: 400;
    }
    #wawaStatsRoot .wawa-table-box {
      overflow: auto;
      max-height: 420px;
    }
    #wawaStatsRoot .wawa-monthly-box {
      max-height: 260px;
    }
    #wawaStatsRoot .wawa-table-compact {
      min-width: 0 !important;
    }
    #wawaStatsRoot .wawa-badge-stale {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 6px;
      background: #F3F4F6;
      color: #9AA1AB;
      font-size: 11px;
    }
    #wawaStatsRoot .wawa-row-stale td {
      color: #9AA1AB;
    }
    #wawaStatsRoot .wawa-stat-warn .wawa-stat-value {
      color: #FF8F1F;
    }
    #wawaStatsRoot #wawaBookView .wawa-card {
      margin-bottom: 16px;
    }
    #wawaStatsRoot .wawa-donut-wrap {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
      justify-content: center;
      width: 100%;
    }
    #wawaStatsRoot .wawa-legend {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 110px;
      max-width: 160px;
    }
    #wawaStatsRoot .wawa-legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: #4B5563;
      line-height: 1.2;
    }
    #wawaStatsRoot .wawa-legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    #wawaStatsRoot .wawa-legend-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #wawaStatsRoot .wawa-legend-value {
      font-variant-numeric: tabular-nums;
      color: #111827;
      font-weight: 600;
    }

    #wawaStatsRoot .wawa-list-box {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #wawaStatsRoot .wawa-earning-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 10px;
      background: #F8FAFB;
      border: 1px solid #F1F3F5;
    }
    #wawaStatsRoot .wawa-earning-main {
      min-width: 0;
    }
    #wawaStatsRoot .wawa-earning-title {
      font-size: 13px;
      font-weight: 600;
      color: #111827;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #wawaStatsRoot .wawa-earning-meta {
      font-size: 11px;
      color: #9AA1AB;
      margin-top: 2px;
    }
    #wawaStatsRoot .wawa-earning-amount {
      font-size: 15px;
      font-weight: 700;
      color: #0F9D58;
      white-space: nowrap;
    }

    #wawaStatsRoot table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      min-width: 760px;
    }
    #wawaStatsRoot th, #wawaStatsRoot td {
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid #EEF0F3;
      white-space: nowrap;
    }
    #wawaStatsRoot th {
      background: #F8FAFB;
      color: #6B7280;
      font-weight: 600;
      font-size: 12px;
      position: sticky;
      top: 0;
    }
    #wawaStatsRoot tbody tr {
      transition: background .12s;
    }
    #wawaStatsRoot tbody tr:hover td {
      background: #F8FAFB;
    }
    #wawaStatsRoot .wawa-book-title {
      font-weight: 600;
      color: #111827;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #wawaStatsRoot .wawa-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      background: #EAF7EF;
      color: #0F9D58;
      font-size: 12px;
    }
    #wawaStatsRoot .wawa-money {
      color: #0F9D58;
      font-weight: 600;
    }
    #wawaStatsRoot .wawa-btn-link {
      border: none;
      background: #F3F4F6;
      color: #374151;
      padding: 5px 12px;
      border-radius: 8px;
      font-size: 12px;
      cursor: pointer;
      transition: background .15s;
    }
    #wawaStatsRoot .wawa-btn-link:hover {
      background: #E5E7EB;
    }
    #wawaStatsRoot .wawa-btn-danger {
      color: #F53F3F;
      background: #FEF1F1;
      margin-left: 6px;
    }
    #wawaStatsRoot .wawa-btn-danger:hover {
      background: #FDE3E3;
      color: #D92D20;
    }

    #wawaStatsRoot .wawa-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-bottom: 16px;
    }
    #wawaStatsRoot .wawa-toolbar select {
      padding: 9px 14px;
      border-radius: 10px;
      border: 1px solid #E5E7EB;
      background: #fff;
      font-size: 13px;
      color: #374151;
      outline: none;
      transition: border-color .15s;
    }
    #wawaStatsRoot .wawa-toolbar select:focus {
      border-color: #0F9D58;
    }
    #wawaStatsRoot .wawa-toolbar select:first-child {
      flex: 1;
      min-width: 220px;
      max-width: 480px;
    }

    #wawaStatsRoot .wawa-empty {
      padding: 40px 20px;
      text-align: center;
      color: #9AA1AB;
      font-size: 13px;
    }
    #wawaStatsRoot .wawa-up { color: #0F9D58; }
    #wawaStatsRoot .wawa-down { color: #F53F3F; }
  `);

  // ========== 初始化 ==========
  function init() {
    migrateStore();
    addFloatingButtons();
    observeCards();
    try {
      GM_registerMenuCommand('📥 立即采集今日数据', () => captureNow({ force: true }));
      GM_registerMenuCommand('📊 打开数据统计', openStatsModal);
    } catch (e) {
      // 某些环境不支持菜单命令，忽略
    }
    console.log('[WAWA Stats] 脚本已加载，今日：' + todayStr() + '，将在数据更新窗口内静默同步');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
