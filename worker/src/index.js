import { sendPush } from './push.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function res(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function endpointKey(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function diffDays(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// 날짜별 맵(memos, memoColors, intimateCounts)을 항목별 수정 시각(tsMap) 기준으로 병합.
// 양쪽 다 해당 항목의 타임스탬프가 없는 레거시 데이터는 전체 블록 기준 newer 값을 우선한다.
function mergeTimedMap(newerMap = {}, newerTsMap = {}, olderMap = {}, olderTsMap = {}) {
  const result = {};
  const resultTs = {};
  const keys = new Set([
    ...Object.keys(newerMap), ...Object.keys(olderMap),
    ...Object.keys(newerTsMap), ...Object.keys(olderTsMap),
  ]);
  for (const key of keys) {
    const nt = newerTsMap[key] || 0;
    const ot = olderTsMap[key] || 0;
    if (nt === 0 && ot === 0) {
      if (key in newerMap) result[key] = newerMap[key];
      else if (key in olderMap) result[key] = olderMap[key];
      continue;
    }
    if (nt >= ot) {
      if (key in newerMap) result[key] = newerMap[key];
      resultTs[key] = nt;
    } else {
      if (key in olderMap) result[key] = olderMap[key];
      resultTs[key] = ot;
    }
  }
  return { map: result, ts: resultTs };
}

// 날짜 토글 배열(intimateDates 등)을 항목별 토글 시각(tsMap) 기준으로 병합.
// 양쪽 다 해당 날짜의 타임스탬프가 없는 레거시 데이터는 합집합으로 처리한다.
function mergeTimedSet(newerArr = [], newerTsMap = {}, olderArr = [], olderTsMap = {}) {
  const toMap = arr => Object.fromEntries(arr.map(d => [d, true]));
  const merged = mergeTimedMap(toMap(newerArr), newerTsMap, toMap(olderArr), olderTsMap);
  return { arr: Object.keys(merged.map).sort(), ts: merged.ts };
}

const TS_MAP_KEYS = ['memoTs', 'memoColorTs', 'intimateCountTs', 'intimateDatesTs', 'exerciseDatesTs', 'gameDatesTs', 'cyclesTs'];

// 기기 시계가 서로 달라도 항목별 수정 순서가 어긋나지 않도록,
// 이전 저장본과 비교해 새로 추가/변경된 항목의 *Ts 값만 서버 시각으로 재기록한다.
// (이전 저장본과 값이 같은, 즉 이번에 수정되지 않은 항목은 기존 서버 타임스탬프를 유지)
function normalizeTimestamps(data, prevData, serverNow) {
  const result = { ...data };
  for (const tsKey of TS_MAP_KEYS) {
    const incoming = data[tsKey] || {};
    const prevTs = (prevData && prevData[tsKey]) || {};
    const normalizedTs = {};
    for (const [k, v] of Object.entries(incoming)) {
      normalizedTs[k] = prevTs[k] === v ? v : serverNow;
    }
    result[tsKey] = normalizedTs;
  }
  return result;
}

function mergeData(a, aTs, b, bTs) {
  const [newer, older] = bTs >= aTs ? [b, a] : [a, b];

  const result = {
    cycleLength:    newer.cycleLength    ?? older.cycleLength,
    periodLength:   newer.periodLength   ?? older.periodLength,
    fertileMethod:  newer.fertileMethod  ?? older.fertileMethod,
    intimateIcon:   newer.intimateIcon   ?? older.intimateIcon,
    notifications:  newer.notifications  ?? older.notifications,
  };

  // 날짜 토글 배열: 항목별 토글 시각 기준으로 병합 (삭제가 합집합으로 되살아나는 것 방지)
  for (const [arrKey, tsKey] of [['intimateDates', 'intimateDatesTs'], ['exerciseDates', 'exerciseDatesTs'], ['gameDates', 'gameDatesTs']]) {
    const merged = mergeTimedSet(newer[arrKey], newer[tsKey], older[arrKey], older[tsKey]);
    result[arrKey] = merged.arr;
    result[tsKey] = merged.ts;
  }

  // 날짜 키 객체: 항목별 수정 시각 기준으로 병합 (전체 블록 타임스탬프로 인한 덮어쓰기 방지)
  for (const [mapKey, tsKey] of [['intimateCounts', 'intimateCountTs'], ['memos', 'memoTs'], ['memoColors', 'memoColorTs']]) {
    const merged = mergeTimedMap(newer[mapKey], newer[tsKey], older[mapKey], older[tsKey]);
    result[mapKey] = merged.map;
    result[tsKey] = merged.ts;
  }

  // cycles: startDate 기준, 항목별 수정 시각(cyclesTs)으로 병합 (삭제가 되살아나는 것 방지)
  const toCycleMap = cycles => Object.fromEntries((cycles || []).map(c => [c.startDate, c]));
  const mergedCycles = mergeTimedMap(toCycleMap(newer.cycles), newer.cyclesTs, toCycleMap(older.cycles), older.cyclesTs);
  result.cycles = Object.values(mergedCycles.map).sort((x, y) => x.startDate.localeCompare(y.startDate));
  result.cyclesTs = mergedCycles.ts;

  return result;
}

// "HH:MM" KST → UTC 분 (0~1439)
function kstTimeToUtcMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return ((h * 60 + m) - 9 * 60 + 24 * 60) % (24 * 60);
}

export default {
  // ── HTTP routes ───────────────────────────────────────
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const { pathname } = new URL(request.url);

    // POST /subscribe  { subscription, nextPeriodDate, daysBefore, notifyTime }
    if (request.method === 'POST' && pathname === '/subscribe') {
      const { subscription, nextPeriodDate, daysBefore, notifyTime } = await request.json();
      const key = await endpointKey(subscription.endpoint);
      await env.SUBSCRIPTIONS.put(key, JSON.stringify({
        subscription,
        nextPeriodDate,
        daysBefore: daysBefore ?? 1,
        notifyTime: notifyTime ?? '08:00',
      }));
      return res({ ok: true });
    }

    // POST /update  { endpoint, nextPeriodDate, daysBefore?, notifyTime? }
    if (request.method === 'POST' && pathname === '/update') {
      const { endpoint, nextPeriodDate, daysBefore, notifyTime } = await request.json();
      const key = await endpointKey(endpoint);
      const raw = await env.SUBSCRIPTIONS.get(key);
      if (raw) {
        const record = JSON.parse(raw);
        record.nextPeriodDate = nextPeriodDate;
        if (daysBefore !== undefined) record.daysBefore = daysBefore;
        if (notifyTime !== undefined) record.notifyTime = notifyTime;
        await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));
      }
      return res({ ok: true });
    }

    // DELETE /unsubscribe  { endpoint }
    if (request.method === 'DELETE' && pathname === '/unsubscribe') {
      const { endpoint } = await request.json();
      const key = await endpointKey(endpoint);
      await env.SUBSCRIPTIONS.delete(key);
      return res({ ok: true });
    }

    // POST /data/save  { code, data, lastModified }
    if (request.method === 'POST' && pathname === '/data/save') {
      const { code, data, knownServerTs = 0 } = await request.json();
      if (!code || code.length !== 10) return res({ error: 'invalid code' }, 400);
      const key = `sync-${code}`;
      const existing = await env.SUBSCRIPTIONS.get(key);
      const prev = existing ? JSON.parse(existing) : null;
      const serverNow = Date.now();
      const normalized = normalizeTimestamps(data, prev?.data, serverNow);

      if (prev && prev.lastModified > knownServerTs) {
        const merged = mergeData(normalized, serverNow, prev.data, prev.lastModified);
        await env.SUBSCRIPTIONS.put(key, JSON.stringify({ data: merged, lastModified: serverNow }));
        return res({ merged: true, data: merged, lastModified: serverNow });
      }
      await env.SUBSCRIPTIONS.put(key, JSON.stringify({ data: normalized, lastModified: serverNow }));
      return res({ data: normalized, lastModified: serverNow });
    }

    // GET /data/load?code=XXXXXXXXXX
    if (request.method === 'GET' && pathname === '/data/load') {
      const code = new URL(request.url).searchParams.get('code');
      if (!code || code.length !== 10) return res({ error: 'invalid code' }, 400);
      const raw = await env.SUBSCRIPTIONS.get(`sync-${code}`);
      if (!raw) return res({ data: null });
      return res(JSON.parse(raw));
    }

    return res({ error: 'not found' }, 404);
  },

  // ── 15분 주기 cron ────────────────────────────────────
  async scheduled(_event, env) {
    const now = new Date();

    // KST 기준 오늘 날짜 (UTC+9)
    const kstNow = new Date(now.getTime() + 9 * 3600 * 1000);
    const todayStr = kstNow.toISOString().slice(0, 10);

    // 현재 UTC 분과 15분 윈도우 계산
    const currentUtcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const windowStart = Math.floor(currentUtcMinutes / 15) * 15;
    const windowEnd = windowStart + 15;

    const { keys } = await env.SUBSCRIPTIONS.list();

    for (const { name } of keys) {
      if (name.startsWith('sync-')) continue;
      try {
        const raw = await env.SUBSCRIPTIONS.get(name);
        if (!raw) continue;

        const { subscription, nextPeriodDate, daysBefore, notifyTime } = JSON.parse(raw);
        if (!subscription || !nextPeriodDate) continue;

        // 이 사용자의 알림 시각(UTC 분)이 현재 15분 윈도우 안에 없으면 건너뜀
        const targetUtcMinutes = kstTimeToUtcMinutes(notifyTime ?? '08:00');
        if (targetUtcMinutes < windowStart || targetUtcMinutes >= windowEnd) continue;

        const diff = diffDays(todayStr, nextPeriodDate);
        if (diff < 0 || diff > (daysBefore ?? 1)) continue;

        const body = diff === 0
          ? '오늘 생리 예정일이에요 💊 미리 준비하세요'
          : `생리 예정일까지 ${diff}일 남았어요 🩸`;

        const result = await sendPush(
          subscription,
          JSON.stringify({ title: '달력', body }),
          env
        );

        if (result.status === 410 || result.status === 404) {
          await env.SUBSCRIPTIONS.delete(name);
        }
      } catch (e) {
        console.error('push failed for', name, e.message);
      }
    }
  },
};
