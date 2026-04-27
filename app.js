'use strict';

// ── State ──────────────────────────────────────────────
let currentYear, currentMonth;
let selectedDate = null;
let data = {};

const STORAGE_KEY = 'periodTrackerData_v1';

// ── Data ───────────────────────────────────────────────
function loadData() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    data = saved ? JSON.parse(saved) : defaultData();
  } catch {
    data = defaultData();
  }
}

function defaultData() {
  return {
    cycleLength: 28,
    periodLength: 5,
    cycles: [],           // [{startDate: 'YYYY-MM-DD'}]
    intimateDates: [],    // ['YYYY-MM-DD']
    memos: {},            // {'YYYY-MM-DD': 'text'}
    notifications: { enabled: false, daysBefore: 2 }
  };
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ── Date utilities ─────────────────────────────────────
function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fromDateStr(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(dateStr, days) {
  const d = fromDateStr(dateStr);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

function diffDays(a, b) {
  return Math.round((fromDateStr(b) - fromDateStr(a)) / 86400000);
}

function formatDate(dateStr) {
  const d = fromDateStr(dateStr);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
}

// ── Cycle calculations ─────────────────────────────────
function getActualPeriodDays() {
  const set = new Set();
  for (const c of data.cycles) {
    for (let i = 0; i < data.periodLength; i++) set.add(addDays(c.startDate, i));
  }
  return set;
}

function getPredictedCycles() {
  // Predict next 3 cycles from last recorded
  if (!data.cycles.length) return [];
  const sorted = [...data.cycles].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const last = sorted[sorted.length - 1];
  const today = toDateStr(new Date());
  const result = [];
  for (let i = 1; i <= 3; i++) {
    const start = addDays(last.startDate, data.cycleLength * i);
    if (diffDays(today, start) < -data.periodLength) continue; // already passed
    result.push(start);
  }
  return result;
}

function getPredictedPeriodDays() {
  const set = new Set();
  for (const start of getPredictedCycles()) {
    for (let i = 0; i < data.periodLength; i++) set.add(addDays(start, i));
  }
  return set;
}

function getFertileAndOvulationDays() {
  const fertile = new Set();
  const ovulation = new Set();
  const predictedFertile = new Set();
  const predictedOvulation = new Set();

  for (const c of data.cycles) {
    const ov = addDays(c.startDate, data.cycleLength - 14);
    ovulation.add(ov);
    for (let i = -5; i <= 1; i++) {
      if (i !== 0) fertile.add(addDays(ov, i));
    }
  }

  for (const start of getPredictedCycles()) {
    const ov = addDays(start, data.cycleLength - 14);
    predictedOvulation.add(ov);
    for (let i = -5; i <= 1; i++) {
      if (i !== 0) predictedFertile.add(addDays(ov, i));
    }
  }

  return { fertile, ovulation, predictedFertile, predictedOvulation };
}

function getNextPeriodInfo() {
  if (!data.cycles.length) return null;
  const sorted = [...data.cycles].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const last = sorted[sorted.length - 1];
  const today = toDateStr(new Date());

  // Check if currently in period
  for (let i = 0; i < data.periodLength; i++) {
    if (addDays(last.startDate, i) === today) return { type: 'inPeriod', day: i + 1 };
  }

  // Next predicted period
  const nextStart = addDays(last.startDate, data.cycleLength);
  const daysUntil = diffDays(today, nextStart);

  if (daysUntil < 0) {
    // Next cycle prediction
    for (let i = 1; i <= 3; i++) {
      const futureStart = addDays(last.startDate, data.cycleLength * i);
      const d = diffDays(today, futureStart);
      if (d >= 0) return { type: 'upcoming', days: d, date: futureStart };
    }
    return { type: 'overdue', days: Math.abs(daysUntil) };
  }
  return { type: 'upcoming', days: daysUntil, date: nextStart };
}

function getOvulationInfo() {
  if (!data.cycles.length) return null;
  const sorted = [...data.cycles].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const last = sorted[sorted.length - 1];
  const today = toDateStr(new Date());

  for (let i = 0; i <= 3; i++) {
    const cycleStart = addDays(last.startDate, data.cycleLength * i);
    const ov = addDays(cycleStart, data.cycleLength - 14);
    const d = diffDays(today, ov);
    if (d >= -1) return { days: d, date: ov };
  }
  return null;
}

// ── Cycle info bar ─────────────────────────────────────
function updateCycleInfoBar() {
  const el = document.getElementById('cycleStatus');
  if (!data.cycles.length) {
    el.textContent = '달력에서 생리 시작일을 탭해서 기록하세요';
    el.style.color = '#aaa';
    return;
  }
  el.style.color = '';

  const periodInfo = getNextPeriodInfo();
  const ovInfo = getOvulationInfo();
  const parts = [];

  if (periodInfo) {
    if (periodInfo.type === 'inPeriod') parts.push(`🩸 생리 중 D+${periodInfo.day}`);
    else if (periodInfo.type === 'upcoming') {
      if (periodInfo.days === 0) parts.push('🩸 오늘 생리 예정');
      else parts.push(`🩸 생리까지 ${periodInfo.days}일`);
    } else if (periodInfo.type === 'overdue') {
      parts.push(`🩸 생리 ${periodInfo.days}일 지남`);
    }
  }

  if (ovInfo) {
    if (ovInfo.days === 0) parts.push('🌸 오늘 배란일');
    else if (ovInfo.days > 0 && ovInfo.days <= 7) parts.push(`🌸 배란까지 ${ovInfo.days}일`);
    else if (ovInfo.days < 0 && ovInfo.days >= -5) parts.push('💙 가임기 중');
  }

  el.textContent = parts.join('  ·  ') || '주기 정보 계산 중...';
}

// ── Calendar rendering ─────────────────────────────────
function renderCalendar(year, month) {
  currentYear = year;
  currentMonth = month;

  const MONTH_NAMES = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
  document.getElementById('monthTitle').textContent = `${year}년 ${MONTH_NAMES[month]}`;

  const today = toDateStr(new Date());
  const actualPeriod = getActualPeriodDays();
  const predictedPeriod = getPredictedPeriodDays();
  const { fertile, ovulation, predictedFertile, predictedOvulation } = getFertileAndOvulationDays();
  const intimate = new Set(data.intimateDates);

  const firstDow = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();

  const grid = document.getElementById('calendar');
  grid.innerHTML = '';

  for (let i = 0; i < firstDow; i++) {
    const blank = document.createElement('div');
    blank.className = 'calendar-cell empty';
    grid.appendChild(blank);
  }

  for (let day = 1; day <= totalDays; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const cell = document.createElement('div');

    const classes = ['calendar-cell'];
    if (dateStr === today) classes.push('today');

    if (actualPeriod.has(dateStr)) {
      classes.push('period');
    } else if (predictedPeriod.has(dateStr)) {
      classes.push('period-predicted');
    } else if (ovulation.has(dateStr)) {
      classes.push('ovulation');
    } else if (predictedOvulation.has(dateStr)) {
      classes.push('ovulation-predicted');
    } else if (fertile.has(dateStr)) {
      classes.push('fertile');
    } else if (predictedFertile.has(dateStr)) {
      classes.push('fertile-predicted');
    }

    cell.className = classes.join(' ');

    const num = document.createElement('span');
    num.className = 'day-number';
    num.textContent = day;
    cell.appendChild(num);

    const ind = document.createElement('div');
    ind.className = 'indicators';

    if (intimate.has(dateStr)) {
      const h = document.createElement('span');
      h.className = 'indicator-heart';
      h.textContent = '❤️';
      ind.appendChild(h);
    }

    if (data.memos[dateStr]) {
      const m = document.createElement('span');
      m.className = 'indicator-memo';
      m.textContent = '📝';
      ind.appendChild(m);
    }

    if (ind.children.length) cell.appendChild(ind);

    cell.addEventListener('click', () => openDayModal(dateStr));
    grid.appendChild(cell);
  }
}

// ── Day modal ──────────────────────────────────────────
function openDayModal(dateStr) {
  selectedDate = dateStr;

  document.getElementById('modalDate').textContent = formatDate(dateStr);

  // Status text
  const actualPeriod = getActualPeriodDays();
  const { fertile, ovulation, predictedFertile, predictedOvulation } = getFertileAndOvulationDays();
  const predictedPeriod = getPredictedPeriodDays();

  let statusParts = [];
  if (actualPeriod.has(dateStr)) statusParts.push('🩸 생리 중');
  if (predictedPeriod.has(dateStr)) statusParts.push('🩸 생리 예정일');
  if (ovulation.has(dateStr)) statusParts.push('🌸 배란일');
  if (predictedOvulation.has(dateStr)) statusParts.push('🌸 배란일 예정');
  if (fertile.has(dateStr) || predictedFertile.has(dateStr)) statusParts.push('💙 가임기');

  document.getElementById('modalStatus').textContent = statusParts.join('  ') || '';

  // Period button state
  const isCycleStart = data.cycles.some(c => c.startDate === dateStr);
  const periodBtn = document.getElementById('togglePeriod');
  periodBtn.textContent = isCycleStart ? '🩸 생리 시작일 해제' : '🩸 생리 시작일로 설정';
  periodBtn.classList.toggle('active', isCycleStart);

  // Intimate button state
  const isIntimate = data.intimateDates.includes(dateStr);
  const intimateBtn = document.getElementById('toggleIntimate');
  intimateBtn.textContent = isIntimate ? '❤️ 사랑한 날 해제' : '❤️ 사랑한 날 기록';
  intimateBtn.classList.toggle('active', isIntimate);

  // Memo
  document.getElementById('memoInput').value = data.memos[dateStr] || '';

  document.getElementById('dayModal').classList.remove('hidden');
}

function closeDayModal() {
  document.getElementById('dayModal').classList.add('hidden');
  selectedDate = null;
}

// ── Toggle actions ─────────────────────────────────────
function togglePeriodStart() {
  if (!selectedDate) return;
  const idx = data.cycles.findIndex(c => c.startDate === selectedDate);
  if (idx >= 0) {
    data.cycles.splice(idx, 1);
    showToast('생리 시작일이 해제되었어요');
  } else {
    data.cycles.push({ startDate: selectedDate });
    data.cycles.sort((a, b) => a.startDate.localeCompare(b.startDate));
    showToast('생리 시작일이 기록되었어요 🩸');
  }
  saveData();
  renderCalendar(currentYear, currentMonth);
  updateCycleInfoBar();
  checkAndNotify();
  openDayModal(selectedDate); // refresh modal state
}

function toggleIntimate() {
  if (!selectedDate) return;
  const idx = data.intimateDates.indexOf(selectedDate);
  if (idx >= 0) {
    data.intimateDates.splice(idx, 1);
    showToast('기록이 해제되었어요');
  } else {
    data.intimateDates.push(selectedDate);
    showToast('사랑한 날이 기록되었어요 ❤️');
  }
  saveData();
  renderCalendar(currentYear, currentMonth);
  openDayModal(selectedDate);
}

function saveMemo() {
  if (!selectedDate) return;
  const text = document.getElementById('memoInput').value.trim();
  if (text) {
    data.memos[selectedDate] = text;
    showToast('메모가 저장되었어요 📝');
  } else {
    delete data.memos[selectedDate];
    showToast('메모가 삭제되었어요');
  }
  saveData();
  renderCalendar(currentYear, currentMonth);
}

// ── Settings modal ─────────────────────────────────────
function openSettings() {
  document.getElementById('cycleLength').value = data.cycleLength;
  document.getElementById('periodLength').value = data.periodLength;
  document.getElementById('notifyDaysBefore').value = data.notifications.daysBefore;
  updateNotifStatus();
  renderCycleList();
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.add('hidden');
}

function saveSettings() {
  const cl = parseInt(document.getElementById('cycleLength').value);
  const pl = parseInt(document.getElementById('periodLength').value);
  const nb = parseInt(document.getElementById('notifyDaysBefore').value);

  if (cl >= 21 && cl <= 45) data.cycleLength = cl;
  if (pl >= 2 && pl <= 10) data.periodLength = pl;
  if (nb >= 0 && nb <= 7) data.notifications.daysBefore = nb;

  saveData();
  renderCalendar(currentYear, currentMonth);
  updateCycleInfoBar();
  closeSettings();
  showToast('설정이 저장되었어요');
}

function renderCycleList() {
  const container = document.getElementById('cycleList');
  const sorted = [...data.cycles].sort((a, b) => b.startDate.localeCompare(a.startDate));

  if (!sorted.length) {
    container.innerHTML = '<div class="no-data-hint">기록된 생리 주기가 없어요.<br>달력에서 시작일을 탭해 기록하세요.</div>';
    return;
  }

  container.innerHTML = sorted.map((c, i) => {
    const actualIdx = data.cycles.findIndex(x => x.startDate === c.startDate);
    const endDate = addDays(c.startDate, data.periodLength - 1);
    return `
      <div class="cycle-item">
        <div>
          <div class="cycle-item-date">${formatDate(c.startDate)}</div>
          <div class="cycle-item-info">~ ${formatDate(endDate)} · ${data.periodLength}일간</div>
        </div>
        <button class="cycle-delete-btn" onclick="deleteCycle(${actualIdx})">✕</button>
      </div>`;
  }).join('');
}

function deleteCycle(idx) {
  if (!confirm('이 주기 기록을 삭제할까요?')) return;
  data.cycles.splice(idx, 1);
  saveData();
  renderCalendar(currentYear, currentMonth);
  updateCycleInfoBar();
  renderCycleList();
  showToast('삭제되었어요');
}

// ── Notifications ──────────────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    updateNotifStatus('이 브라우저는 알림을 지원하지 않아요');
    return;
  }

  // iOS requires the app to be added to home screen first
  const result = await Notification.requestPermission();
  data.notifications.enabled = result === 'granted';
  saveData();
  updateNotifStatus();

  if (result === 'granted') {
    showToast('알림이 허용되었어요 🔔');
    checkAndNotify();
  } else {
    showToast('알림 권한이 거부되었어요');
  }

  const btn = document.getElementById('enableNotifications');
  btn.classList.toggle('granted', result === 'granted');
}

function updateNotifStatus() {
  const statusEl = document.getElementById('notificationStatus');
  const btn = document.getElementById('enableNotifications');
  if (!('Notification' in window)) {
    statusEl.textContent = '알림 미지원 브라우저';
    return;
  }
  const perm = Notification.permission;
  if (perm === 'granted') {
    statusEl.textContent = '✅ 알림 허용됨 (홈 화면 추가 후 작동)';
    btn.textContent = '✅ 알림 허용됨';
    btn.classList.add('granted');
  } else if (perm === 'denied') {
    statusEl.textContent = '❌ 알림 거부됨 — 설정에서 변경해주세요';
  } else {
    statusEl.textContent = '⚠️ 홈 화면에 추가한 뒤 알림을 허용하세요';
    btn.classList.remove('granted');
  }
}

function checkAndNotify() {
  if (!data.cycles.length) return;
  if (Notification.permission !== 'granted') return;

  const lastShown = localStorage.getItem('lastNotifDate');
  const today = toDateStr(new Date());
  if (lastShown === today) return;

  const info = getNextPeriodInfo();
  if (!info) return;

  let title = '생리 트래커';
  let body = null;

  if (info.type === 'upcoming' && info.days <= data.notifications.daysBefore) {
    if (info.days === 0) body = '오늘 생리 예정일이에요! 미리 준비하세요 💊';
    else body = `생리 예정일까지 ${info.days}일 남았어요! 미리 준비하세요 🩸`;
  }

  if (body) {
    localStorage.setItem('lastNotifDate', today);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(reg => {
        reg.showNotification(title, {
          body,
          icon: './icon-192.png',
          badge: './icon-192.png',
          tag: 'period-reminder',
          renotify: true,
          vibrate: [200, 100, 200]
        });
      });
    }
  }
}

// ── Toast ──────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Navigation ─────────────────────────────────────────
function prevMonth() {
  if (currentMonth === 0) { currentYear--; currentMonth = 11; }
  else currentMonth--;
  renderCalendar(currentYear, currentMonth);
}

function nextMonth() {
  if (currentMonth === 11) { currentYear++; currentMonth = 0; }
  else currentMonth++;
  renderCalendar(currentYear, currentMonth);
}

// Touch swipe for month navigation
function initSwipe() {
  let startX = 0;
  const cal = document.getElementById('calendarContainer');

  cal.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  cal.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 60) dx < 0 ? nextMonth() : prevMonth();
  }, { passive: true });
}

// ── PWA install ────────────────────────────────────────
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
});

// ── Service Worker registration ────────────────────────
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    console.warn('SW registration failed:', err);
  }
}

// ── Init ───────────────────────────────────────────────
function init() {
  loadData();

  const now = new Date();
  renderCalendar(now.getFullYear(), now.getMonth());
  updateCycleInfoBar();

  // Bind events
  document.getElementById('prevMonth').addEventListener('click', prevMonth);
  document.getElementById('nextMonth').addEventListener('click', nextMonth);
  document.getElementById('settingsBtn').addEventListener('click', openSettings);

  document.getElementById('closeModal').addEventListener('click', closeDayModal);
  document.getElementById('togglePeriod').addEventListener('click', togglePeriodStart);
  document.getElementById('toggleIntimate').addEventListener('click', toggleIntimate);
  document.getElementById('saveMemo').addEventListener('click', saveMemo);

  document.getElementById('closeSettings').addEventListener('click', closeSettings);
  document.getElementById('saveSettings').addEventListener('click', saveSettings);
  document.getElementById('enableNotifications').addEventListener('click', requestNotificationPermission);

  // Close modal on backdrop click
  document.getElementById('dayModal').addEventListener('click', function(e) {
    if (e.target === this) closeDayModal();
  });
  document.getElementById('settingsModal').addEventListener('click', function(e) {
    if (e.target === this) closeSettings();
  });

  initSwipe();
  registerSW();

  // Check notifications after a short delay
  setTimeout(checkAndNotify, 1500);
}

document.addEventListener('DOMContentLoaded', init);
