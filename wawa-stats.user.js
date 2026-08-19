// ==UserScript==
// @name         WAWA 小说数据记录与统计
// @namespace    local.wawa-stats
// @version      0.4.0
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
  const API_REVENUE = '/wrhp-api/api/v1/submission/novel/my_revenue';
  const UPDATE_HOUR = 14;
  const UPDATE_MINUTE = 30;
  const AUTO_CAPTURE_DELAY = 4000; // 页面出现卡片后延迟自动采集
  const ENABLE_CLICK_COLLECT = true; // API 缺少在读人数/收益时，自动点开卡片补全（会短暂展开卡片）

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

  function isAfterUpdate(date = new Date()) {
    const p = beijingParts(date);
    return p.hour > UPDATE_HOUR || (p.hour === UPDATE_HOUR && p.minute >= UPDATE_MINUTE);
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

  function firstDefined(...args) {
    for (const a of args) {
      if (a !== undefined && a !== null && a !== '') return a;
    }
    return undefined;
  }

  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(/[,，]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
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
      if (v && Array.isArray(v.records)) return v;
    } catch (e) {
      console.error('[WAWA Stats] loadStore failed', e);
    }
    return { records: [] };
  }

  function saveStore(store) {
    try {
      GM_setValue(STORAGE_KEY, store);
    } catch (e) {
      console.error('[WAWA Stats] saveStore failed', e);
      showToast('保存失败：' + e.message, 'error');
    }
  }

  function upsertRecord(record) {
    const store = loadStore();
    const idx = store.records.findIndex((r) => r.date === record.date);
    if (idx >= 0) store.records[idx] = record;
    else store.records.push(record);
    store.records.sort((a, b) => a.date.localeCompare(b.date));
    saveStore(store);
    return store;
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

  function shouldAutoCaptureToday() {
    // 不再判断“今天该不该采”。
    // 每本书有自己的 statDate，采集后按各自时间戳写入对应日期即可。
    // 同一个页面会话只自动采一次（由 observeCards 控制），不会轮询。
    return true;
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
        result.yesterdayDelta = deltaM ? parseFloat(deltaM[1]) : 0;
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

  function normalizeApiData(items) {
    return items.map((item) => {
      const latest = item.latest && typeof item.latest === 'object' ? item.latest : null;
      const prevObj = item.previous && typeof item.previous === 'object' ? item.previous : null;
      const pick = (obj, keys) => {
        for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
        return undefined;
      };

      let dailyRevenue = 0;
      let readers = null;
      let previousReaders = null;
      let previousDate = null;
      let yesterdayDelta = 0;
      let statDate = null;

      if (latest) {
        dailyRevenue = toNum(
          firstDefined(
            pick(latest, ['revenue', 'daily_revenue', 'today_revenue', 'amount', 'income']),
            0
          )
        );
        readers = firstDefined(
          pick(latest, ['reader_count', 'readers', 'reading_count', 'read_num', 'read_count', 'follow_user_cnt', 'uv']),
          null
        );
        readers = readers === null || readers === undefined ? null : toNum(readers);
        yesterdayDelta = toNum(
          firstDefined(
            pick(latest, ['delta', 'yesterday_delta', 'diff', 'change']),
            0
          )
        );
        statDate = normalizeDateValue(
          firstDefined(
            pick(latest, ['date', 'stat_date', 'statDate', 'day', 'biz_date', 'updated_at', 'created_at']),
            null
          )
        );
      } else if (typeof item.latest === 'number') {
        dailyRevenue = item.latest;
      }

      if (prevObj) {
        const prevValue = toNum(
          firstDefined(
            pick(prevObj, ['revenue', 'daily_revenue', 'today_revenue', 'amount', 'income']),
            0
          )
        );
        if (!yesterdayDelta) yesterdayDelta = dailyRevenue - prevValue;
        const prevReaderRaw = firstDefined(
          pick(prevObj, ['reader_count', 'readers', 'reading_count', 'read_num', 'read_count', 'follow_user_cnt', 'uv']),
          null
        );
        previousReaders = prevReaderRaw == null ? null : toNum(prevReaderRaw);
        previousDate = normalizeDateValue(
          firstDefined(
            pick(prevObj, ['date', 'stat_date', 'statDate', 'day', 'biz_date', 'updated_at', 'created_at']),
            null
          )
        );
      } else if (typeof item.previous === 'number') {
        yesterdayDelta = dailyRevenue - item.previous;
      }

      return {
        baseNovelId: item.base_novel_id ?? item.baseNovelId ?? null,
        title: (item.title || '').trim(),
        totalRevenue: toNum(item.total_revenue ?? item.totalRevenue ?? 0),
        dailyRevenue,
        yesterdayDelta,
        readers,
        previousReaders,
        previousDate,
        statDate,
        raw: item,
      };
    });
  }

  function detectStatDate(apiItems) {
    const counts = new Map();
    for (const item of apiItems) {
      if (!item.statDate) continue;
      counts.set(item.statDate, (counts.get(item.statDate) || 0) + 1);
    }
    if (!counts.size) return null;
    let best = null;
    let bestCount = 0;
    for (const [d, c] of counts) {
      if (c > bestCount) {
        best = d;
        bestCount = c;
      }
    }
    return best;
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
        previousReaders: api?.previousReaders ?? null,
        previousDate: api?.previousDate ?? null,
        statDate: api?.statDate ?? null,
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
          previousReaders: api.previousReaders,
          previousDate: api.previousDate,
          statDate: api.statDate,
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
    const afterUpdate = isAfterUpdate();
    const hasTimestamp = apiItems.some((item) => item.statDate);

    // 没有任何时间戳且未到 14:30 时，无法确认数据日期，跳过自动记录
    if (!force && !afterUpdate && !hasTimestamp) {
      const msg = `接口没有返回统计数据日期，且现在未到 ${UPDATE_HOUR}:${pad(UPDATE_MINUTE)}，为避免把前一天数据记成今天，已跳过`;
      if (!quiet) showToast(msg, 'warn');
      console.log('[WAWA Stats]', msg);
      return null;
    }

    let books = mergeData(domCards, apiItems);

    if (ENABLE_CLICK_COLLECT && books.some((b) => b.readers == null || b.dailyRevenue == null || b.totalRevenue == null)) {
      showBanner('正在展开卡片补全收益/在读数据…');
      try {
        books = await collectReadersFromCards(books);
      } catch (e) {
        console.error('[WAWA Stats] click collect failed', e);
      }
      hideBanner();
    }

    if (!books.length) {
      showToast('没有采集到任何书籍数据', 'error');
      return null;
    }

    // 按每本书自己的 statDate 分组写入，不再把所有书强行塞进同一个日期
    const grouped = new Map();
    books.forEach((b) => {
      const date = b.statDate || todayStr();
      if (!grouped.has(date)) grouped.set(date, []);
      grouped.get(date).push(b);
    });

    const savedDates = [];
    for (const [date, groupBooks] of grouped) {
      upsertBooksByDate(date, groupBooks, {
        localCaptureDate: todayStr(),
        timestampSource: hasTimestamp ? 'api' : 'local',
        serverTime: apiRes.serverTime,
        preUpdate: !afterUpdate,
      });
      savedDates.push(date);
    }

    if (!quiet) showToast(`✅ 已记录 ${books.length} 本书（${savedDates.join(', ')}）`, 'success');
    console.log('[WAWA Stats] records saved', savedDates, books);
    if (window.__wawaStatsModal && window.__wawaStatsModal.isOpen()) {
      window.__wawaStatsModal.refresh();
    }
    return { dates: savedDates, books };
  }

  // ========== 自动触发 ==========
  let autoCapturing = false;

  function debounce(fn, wait) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function observeCards() {
    let autoCaptureSessionDone = false;
    let observer = null;

    const tryAuto = debounce(() => {
      if (autoCapturing) return;
      // 同一个页面会话只自动采集一次，避免 MutationObserver 导致反复轮询
      if (autoCaptureSessionDone) return;
      if (!document.querySelector('.submission-item')) return;
      if (!shouldAutoCaptureToday()) {
        // 当前没有需要自动采集的新数据，直接断开监听，不再遍历页面元素
        if (observer) observer.disconnect();
        return;
      }

      autoCapturing = true;
      setTimeout(async () => {
        try {
          await captureNow({ quiet: true });
        } catch (e) {
          console.error('[WAWA Stats] auto capture failed', e);
        } finally {
          autoCapturing = false;
          // 无论成功、跳过还是失败，本会话都不再自动重试；14:30 的定时任务仍会触发一次
          autoCaptureSessionDone = true;
          if (observer) observer.disconnect();
        }
      }, AUTO_CAPTURE_DELAY);
    }, 1200);

    observer = new MutationObserver(tryAuto);
    observer.observe(document.body, { childList: true, subtree: true });
    tryAuto();
  }

  function scheduleBeforeUpdate() {
    if (isAfterUpdate()) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(UPDATE_HOUR, UPDATE_MINUTE, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = Math.max(1000, next - now);
    setTimeout(async () => {
      if (!isAfterUpdate()) return;
      if (!shouldAutoCaptureToday()) {
        console.log('[WAWA Stats] 已是最新数据，14:30 跳过重复采集');
        return;
      }
      showToast('⏰ 已到 14:30，开始自动采集今日数据…');
      try {
        await captureNow({});
      } catch (e) {
        console.error(e);
      }
    }, delay);
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
      if (!isAfterUpdate()) {
        if (!confirm('当前还未到 14:30，网站数据可能还没更新。\n仍要强制记录当前快照吗？')) return;
      }
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
              <div class="wawa-card">
                <div class="wawa-card-title">👥 在读人数分布</div>
                <div id="wawaReaderDonut" class="wawa-donut-box"></div>
              </div>
              <div class="wawa-card wawa-span-2">
                <div class="wawa-card-title">💰 今日收益</div>
                <div id="wawaEarningList" class="wawa-list-box"></div>
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
              <select id="wawaMetricSelect">
                <option value="totalRevenue">历史总收益</option>
                <option value="dailyRevenue">单日收益</option>
                <option value="readers">在读人数</option>
                <option value="readerDelta">今日新增在读</option>
                <option value="wordsWan">总字数（万字）</option>
                <option value="chapterNum">章节数</option>
              </select>
            </div>
            <div class="wawa-card"><div id="wawaChart" class="wawa-chart-box"></div></div>
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
    root.querySelector('#wawaMetricSelect').addEventListener('change', renderBookView);
    root.addEventListener('click', (e) => {
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

  function getSelectedMetric() {
    const select = document.getElementById('wawaMetricSelect');
    return select ? select.value : 'totalRevenue';
  }

  function renderStats() {
    if (currentView === 'global') renderGlobalView();
    else renderBookView();
  }

  function renderGlobalView() {
    const store = loadStore();
    const records = store.records || [];
    const latest = records[records.length - 1];
    const summaryEl = document.getElementById('wawaSummary');
    if (!summaryEl) return;

    if (!latest) {
      summaryEl.innerHTML = statCard('提示', '还没有数据，请先采集');
      document.getElementById('wawaGlobalTrend').innerHTML = '<div class="wawa-empty">暂无数据</div>';
      document.getElementById('wawaRevenueDonut').innerHTML = '<div class="wawa-empty">暂无数据</div>';
      document.getElementById('wawaReaderDonut').innerHTML = '<div class="wawa-empty">暂无数据</div>';
      document.getElementById('wawaEarningList').innerHTML = '<div class="wawa-empty">暂无数据</div>';
      document.getElementById('wawaAllBooks').innerHTML = '<div class="wawa-empty">暂无数据</div>';
      return;
    }

    // 不同书可能在不同日期更新，这里汇总每本书最新的一条记录
    const latestBooksMap = new Map();
    records.forEach((rec) => {
      (rec.books || []).forEach((b) => {
        const existing = latestBooksMap.get(b.title);
        if (!existing || rec.date > existing._recDate) {
          latestBooksMap.set(b.title, { ...b, _recDate: rec.date });
        }
      });
    });
    const books = Array.from(latestBooksMap.values());
    const earningBooks = books.filter((b) => toNum(b.dailyRevenue) > 0);
    const totalDaily = books.reduce((s, b) => s + toNum(b.dailyRevenue), 0);
    const totalRevenueAll = books.reduce((s, b) => s + toNum(b.totalRevenue), 0);
    const totalReaders = books.reduce((s, b) => s + (b.readers == null ? 0 : toNum(b.readers)), 0);

    // 每本书使用接口返回的 previousReaders（各自对应的前一条数据），不混用日期
    let newReadersTotal = null;
    let hasPreviousReaders = false;
    books.forEach((b) => {
      if (b.readers == null || b.previousReaders == null) return;
      hasPreviousReaders = true;
      newReadersTotal = (newReadersTotal || 0) + (toNum(b.readers) - toNum(b.previousReaders));
    });

    summaryEl.innerHTML = [
      statCard('数据日期', latest.date),
      statCard('记录天数', String(records.length)),
      statCard('追踪书籍', String(books.length)),
      statCard('今日有收益', String(earningBooks.length)),
      statCard('今日总收益', '¥' + totalDaily.toFixed(2)),
      statCard('所有书总收益', '¥' + totalRevenueAll.toFixed(2)),
      statCard('今日总在读', fmtNum(totalReaders)),
      statCard('今日新增总在读', hasPreviousReaders ? (newReadersTotal > 0 ? '+' : '') + fmtNum(newReadersTotal) : '无'),
    ].join('');

    const trendData = records.map((r) => ({
      date: r.date,
      value: (r.books || []).reduce((s, b) => s + toNum(b.dailyRevenue), 0),
    }));
    drawLineChart(document.getElementById('wawaGlobalTrend'), trendData, '全站单日收益（元）');

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
      earningEl.innerHTML = '<div class="wawa-empty">零蛋！</div>';
    } else {
      earningEl.innerHTML = earningBooks.map((b) => `
        <div class="wawa-earning-row">
          <div class="wawa-earning-main">
            <div class="wawa-earning-title">${escapeHtml(b.title)}</div>
            <div class="wawa-earning-meta">昨日 ${(b.yesterdayDelta ?? 0) >= 0 ? '+' : ''}${b.yesterdayDelta ?? 0} · 在读 ${b.readers == null ? '-' : b.readers + ' 人'}</div>
          </div>
          <div class="wawa-earning-amount">+¥${toNum(b.dailyRevenue).toFixed(2)}</div>
        </div>
      `).join('');
    }

    // 全部书籍总览
    const allBooksEl = document.getElementById('wawaAllBooks');
    if (!books.length) {
      allBooksEl.innerHTML = '<div class="wawa-empty">暂无书籍数据</div>';
      return;
    }
    const head = '<tr><th>书名</th><th>数据日期</th><th>状态</th><th>总字数</th><th>总收益</th><th>今日收益</th><th>昨日</th><th>在读</th><th>新增在读</th><th></th></tr>';
    const rows = books.map((b) => {
      const readerDelta = b.readers != null && b.previousReaders != null ? toNum(b.readers) - toNum(b.previousReaders) : null;
      return `
      <tr>
        <td class="wawa-book-title">${escapeHtml(b.title)}</td>
        <td>${escapeHtml(b.statDate || '-')}</td>
        <td>${b.status ? `<span class="wawa-badge">${escapeHtml(b.status)}</span>` : '-'}</td>
        <td>${escapeHtml(b.wordsText || '-')}</td>
        <td>¥${toNum(b.totalRevenue).toFixed(2)}</td>
        <td class="${toNum(b.dailyRevenue) > 0 ? 'wawa-money' : ''}">¥${toNum(b.dailyRevenue).toFixed(2)}</td>
        <td class="${(b.yesterdayDelta || 0) >= 0 ? 'wawa-up' : 'wawa-down'}">${(b.yesterdayDelta ?? 0) >= 0 ? '+' : ''}${b.yesterdayDelta ?? 0}</td>
        <td>${b.readers == null ? '-' : b.readers + ' 人'}</td>
        <td class="${readerDelta == null ? '' : (readerDelta >= 0 ? 'wawa-up' : 'wawa-down')}">${readerDelta == null ? '无' : (readerDelta > 0 ? '+' : '') + readerDelta}</td>
        <td><button class="wawa-btn-link" data-action="view-book" data-title="${escapeHtml(b.title)}">查看</button></td>
      </tr>
    `;
    }).join('');
    allBooksEl.innerHTML = `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  function renderBookView() {
    const store = loadStore();
    const bookTitle = getSelectedBook();
    const metric = getSelectedMetric();
    const chartEl = document.getElementById('wawaChart');
    const tableWrap = document.getElementById('wawaTableWrap');
    if (!chartEl || !tableWrap) return;

    const series = store.records
      .map((rec) => {
        const book = rec.books.find((b) => b.title === bookTitle);
        return book ? { date: rec.date, rec, book } : null;
      })
      .filter(Boolean);

    if (!series.length) {
      chartEl.innerHTML = '<div class="wawa-empty">请选择一本书查看详情</div>';
      tableWrap.innerHTML = '';
      return;
    }

    const data = series.map((s) => {
      let value;
      if (metric === 'readerDelta') {
        // 每本书用接口返回的 previousReaders，和它自己的时间戳一一对应
        if (s.book.readers == null || s.book.previousReaders == null) {
          value = 0;
        } else {
          value = toNum(s.book.readers) - toNum(s.book.previousReaders);
        }
      } else {
        value = s.book[metric] == null ? 0 : toNum(s.book[metric]);
      }
      return { date: s.date, value };
    });
    const metricLabels = {
      totalRevenue: '历史总收益（元）',
      dailyRevenue: '单日收益（元）',
      readers: '在读人数（人）',
      readerDelta: '今日新增在读（人）',
      wordsWan: '总字数（万字）',
      chapterNum: '章节数（章）',
    };
    drawLineChart(chartEl, data, metricLabels[metric] || metric);

    const head = '<tr><th>日期</th><th>章节</th><th>总字数</th><th>状态</th><th>历史总收益</th><th>单日收益</th><th>昨日</th><th>在读</th></tr>';
    const rows = series.map((s) => {
      const b = s.book;
      return `<tr>
        <td>${escapeHtml(s.date)}</td>
        <td>${escapeHtml(b.chapterText || '-')}</td>
        <td>${escapeHtml(b.wordsText || '-')}</td>
        <td>${escapeHtml(b.status || '-')}</td>
        <td>¥${toNum(b.totalRevenue).toFixed(2)}</td>
        <td>¥${toNum(b.dailyRevenue).toFixed(2)}</td>
        <td class="${(b.yesterdayDelta || 0) >= 0 ? 'wawa-up' : 'wawa-down'}">${(b.yesterdayDelta ?? 0) >= 0 ? '+' : ''}${b.yesterdayDelta ?? 0}</td>
        <td>${b.readers == null ? '-' : b.readers + ' 人'}</td>
      </tr>`;
    }).join('');
    tableWrap.innerHTML = `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  function statCard(label, value) {
    return `<div class="wawa-stat-card">
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
  function niceStep(raw) {
    if (!raw || raw <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

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
        svg += `<title>${escapeHtml(p.d.date)}：${fmtNum(p.d.value)}</title>`;
      });
    }

    svg += `<text x="${PL}" y="16" font-size="12" fill="#86909C">${escapeHtml(label)}</text>`;
    svg += '</svg>';
    container.innerHTML = svg;
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
    rows.push(['日期', '书名', '章节', '总字数(万)', '总字数原文', '状态', '历史总收益', '单日收益', '昨日变化', '在读人数']);

    if (currentView === 'global') {
      store.records.forEach((rec) => {
        (rec.books || []).forEach((book) => {
          rows.push([
            rec.date,
            book.title,
            book.chapterText || '',
            book.wordsWan == null ? '' : String(book.wordsWan),
            book.wordsText || '',
            book.status || '',
            book.totalRevenue == null ? '' : String(book.totalRevenue),
            book.dailyRevenue == null ? '' : String(book.dailyRevenue),
            book.yesterdayDelta == null ? '' : String(book.yesterdayDelta),
            book.readers == null ? '' : String(book.readers),
          ]);
        });
      });
    } else {
      const bookTitle = getSelectedBook();
      if (!bookTitle) {
        showToast('请先选择一本书', 'warn');
        return;
      }
      store.records.forEach((rec) => {
        const book = rec.books.find((b) => b.title === bookTitle);
        if (!book) return;
        rows.push([
          rec.date,
          book.title,
          book.chapterText || '',
          book.wordsWan == null ? '' : String(book.wordsWan),
          book.wordsText || '',
          book.status || '',
          book.totalRevenue == null ? '' : String(book.totalRevenue),
          book.dailyRevenue == null ? '' : String(book.dailyRevenue),
          book.yesterdayDelta == null ? '' : String(book.yesterdayDelta),
          book.readers == null ? '' : String(book.readers),
        ]);
      });
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
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 18px;
    }
    @media (max-width: 1100px) {
      #wawaStatsRoot .wawa-summary-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }
    @media (max-width: 600px) {
      #wawaStatsRoot .wawa-summary-grid {
        grid-template-columns: 1fr;
      }
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
    }
    #wawaStatsRoot .wawa-donut-box {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 180px;
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
    addFloatingButtons();
    observeCards();
    scheduleBeforeUpdate();
    try {
      GM_registerMenuCommand('📥 立即采集今日数据', () => captureNow({ force: true }));
      GM_registerMenuCommand('📊 打开数据统计', openStatsModal);
    } catch (e) {
      // 某些环境不支持菜单命令，忽略
    }
    console.log('[WAWA Stats] 脚本已加载，今日：' + todayStr() + '，14:30 后自动采集');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
