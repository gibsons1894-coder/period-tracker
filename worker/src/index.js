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

// "HH:MM" KST → UTC hour (0~23)
function kstTimeToUtcHour(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return ((h - 9) + 24) % 24;
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

    return res({ error: 'not found' }, 404);
  },

  // ── Hourly cron ───────────────────────────────────────
  async scheduled(_event, env) {
    const now = new Date();
    const currentUtcHour = now.getUTCHours();
    const todayStr = now.toISOString().slice(0, 10);
    const { keys } = await env.SUBSCRIPTIONS.list();

    for (const { name } of keys) {
      try {
        const raw = await env.SUBSCRIPTIONS.get(name);
        if (!raw) continue;

        const { subscription, nextPeriodDate, daysBefore, notifyTime } = JSON.parse(raw);
        if (!nextPeriodDate) continue;

        // 이 사용자의 알림 시각(UTC)이 현재 시각과 다르면 건너뜀
        const targetUtcHour = kstTimeToUtcHour(notifyTime ?? '08:00');
        if (currentUtcHour !== targetUtcHour) continue;

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
