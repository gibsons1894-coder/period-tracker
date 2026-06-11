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

function mergeData(a, aTs, b, bTs) {
  const [newer, older] = bTs >= aTs ? [b, a] : [a, b];

  const result = {
    cycleLength:    newer.cycleLength    ?? older.cycleLength,
    periodLength:   newer.periodLength   ?? older.periodLength,
    fertileMethod:  newer.fertileMethod  ?? older.fertileMethod,
    intimateIcon:   newer.intimateIcon   ?? older.intimateIcon,
    notifications:  newer.notifications  ?? older.notifications,
  };

  // 날짜 배열: 합집합
  for (const key of ['intimateDates', 'exerciseDates', 'gameDates']) {
    result[key] = [...new Set([...(a[key] || []), ...(b[key] || [])])].sort();
  }

  // 날짜 키 객체: 같은 날 충돌 시 newer 우선
  for (const key of ['intimateCounts', 'memos', 'memoColors']) {
    result[key] = { ...(older[key] || {}), ...(newer[key] || {}) };
  }

  // cycles: startDate 기준 병합, 같은 날 충돌 시 newer 우선
  const cycleMap = new Map();
  for (const c of [...(older.cycles || []), ...(newer.cycles || [])]) {
    cycleMap.set(c.startDate, c);
  }
  result.cycles = [...cycleMap.values()].sort((x, y) => x.startDate.localeCompare(y.startDate));

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
      const { code, data, lastModified, knownServerTs = 0 } = await request.json();
      if (!code || code.length !== 10) return res({ error: 'invalid code' }, 400);
      const key = `sync-${code}`;
      const existing = await env.SUBSCRIPTIONS.get(key);
      if (existing) {
        const prev = JSON.parse(existing);
        if (prev.lastModified > knownServerTs) {
          const merged = mergeData(data, lastModified, prev.data, prev.lastModified);
          const mergedTs = Math.max(lastModified, prev.lastModified);
          await env.SUBSCRIPTIONS.put(key, JSON.stringify({ data: merged, lastModified: mergedTs }));
          return res({ merged: true, data: merged, lastModified: mergedTs });
        }
      }
      await env.SUBSCRIPTIONS.put(key, JSON.stringify({ data, lastModified }));
      return res({ ok: true });
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
