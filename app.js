'use strict';

// ── Push server config (Worker 배포 후 채워주세요) ──────
const PUSH_SERVER_URL  = 'https://period-tracker-push.life-app.workers.dev';
const VAPID_PUBLIC_KEY = 'URfnrL_y-iMmUH5-Ebz6VAIbAE8mep3lr8H2wClZZqw';

// ── State ──────────────────────────────────────────────
let currentYear, currentMonth;
let selectedDate = null;
let data = {};
let _pushSubscription = null;

const STORAGE_KEY = 'periodTrackerData_v1';

const INTIMATE_ICONS = ['💟','❤️','🩷','🧡','💛','💚','💙','💜','🖤','🤍','💕','💞','💓','💗','💖','💝','💘','🌸','🍓','💋','🌹','🦋'];
const RED_HEARTS = new Set(['❤️','🩷','🧡','💕','💞','💓','💗','💖','💝','💘','🌸','🍓','💋','🌹','🦋']);
const SYNC_CODE_KEY = 'syncCode';
const SYNC_TS_KEY   = 'syncLastModified';

// ── Sync ───────────────────────────────────────────────
let syncCode = localStorage.getItem(SYNC_CODE_KEY) || null;
let _syncTimer = null;
let _isSyncing = false;

function generateSyncCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function setSyncCode(code) {
  syncCode = code.toUpperCase().trim();
  localStorage.setItem(SYNC_CODE_KEY, syncCode);
}

function clearSyncCode() {
  syncCode = null;
  localStorage.removeItem(SYNC_CODE_KEY);
  localStorage.removeItem(SYNC_TS_KEY);
}

function getLocalTs() {
  return parseInt(localStorage.getItem(SYNC_TS_KEY) || '0');
}

function scheduleSyncSave() {
  if (!PUSH_SERVER_URL || !syncCode || _isSyncing) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(syncSave, 2000);
}

async function syncSave() {
  if (!PUSH_SERVER_URL || !syncCode) return;
  const ts = Date.now();
  localStorage.setItem(SYNC_TS_KEY, ts);
  try {
    const r = await fetch(`${PUSH_SERVER_URL}/data/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: syncCode, data, lastModified: ts })
    });
    const json = await r.json();
    if (json.conflict) {
      _applyServerData(json.data, json.lastModified);
    }
  } catch (e) {
    console.warn('syncSave failed:', e);
  }
}

async function syncLoad() {
  if (!PUSH_SERVER_URL || !syncCode) return;
  try {
    const r = await fetch(`${PUSH_SERVER_URL}/data/load?code=${syncCode}`);
    const json = await r.json();
    if (!json.data) return;
    if (json.lastModified > getLocalTs()) {
      _applyServerData(json.data, json.lastModified);
      showToast('✓ 동기화됨');
    }
  } catch (e) {
    console.warn('syncLoad failed:', e);
  }
}

function _applyServerData(serverData, ts) {
  _isSyncing = true;
  data = serverData;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  localStorage.setItem(SYNC_TS_KEY, ts);
  _isSyncing = false;
  renderCalendar(currentYear, currentMonth);
  updateCycleInfoBar();
}

function updateSyncStatus() {
  const el = document.getElementById('syncStatus');
  const shareBtn = document.getElementById('syncShareBtn');
  if (!el) return;
  if (syncCode) {
    el.textContent = `연결됨 · ${syncCode}`;
    el.style.color = '#27AE60';
    if (shareBtn) shareBtn.classList.remove('hidden');
  } else {
    el.textContent = '동기화 꺼짐';
    el.style.color = '';
    if (shareBtn) shareBtn.classList.add('hidden');
  }
}

async function shareSyncCode() {
  if (!syncCode) return;

  if (navigator.share) {
    try {
      await navigator.share({ text: syncCode });
    } catch (e) {
      if (e.name === 'AbortError') return;
      fallbackCopy(syncCode);
      return;
    }
    try {
      await navigator.share({ text: '① 달력 앱 열기\n② 설정 → 기기 동기화\n③ 코드 입력 후 연결 탭' });
    } catch (e) {
      // 두 번째 공유는 취소해도 무시
    }
  } else {
    fallbackCopy(syncCode);
  }
}

async function fallbackCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('코드가 클립보드에 복사됐어요 📋');
  } catch {
    showToast('복사에 실패했어요');
  }
}

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
    cycleLength: 30,
    periodLength: 5,
    fertileMethod: 'standard',
    cycles: [],           // [{startDate: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD'}]
    intimateIcon: '💟',
    intimateDates: [],    // ['YYYY-MM-DD']
    memos: {},            // {'YYYY-MM-DD': 'text'}
    notifications: { enabled: false, daysBefore: 1, notifyTime: '08:00' }
  };
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  scheduleSyncSave();
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
function getEffectiveCycleLength() {
  if (data.cycles.length < 2) return data.cycleLength;
  const sorted = [...data.cycles].sort((a, b) => a.startDate.localeCompare(b.startDate));
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    total += diffDays(sorted[i - 1].startDate, sorted[i].startDate);
  }
  return Math.round(total / (sorted.length - 1));
}

function getActualPeriodDays() {
  const set = new Set();
  for (const c of data.cycles) {
    const len = c.endDate ? diffDays(c.startDate, c.endDate) + 1 : data.periodLength;
    for (let i = 0; i < len; i++) set.add(addDays(c.startDate, i));
  }
  return set;
}

function getCycleForEndDate(dateStr) {
  return [...data.cycles]
    .filter(c => c.startDate <= dateStr && diffDays(c.startDate, dateStr) < data.cycleLength)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0] || null;
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
    for (let i = -5; i <= 2; i++) {
      if (i !== 0) fertile.add(addDays(ov, i));
    }
  }

  for (const start of getPredictedCycles()) {
    const ov = addDays(start, data.cycleLength - 14);
    predictedOvulation.add(ov);
    for (let i = -5; i <= 2; i++) {
      if (i !== 0) predictedFertile.add(addDays(ov, i));
    }
  }

  return { fertile, ovulation, predictedFertile, predictedOvulation };
}

function getShortestLongestCycleLengths() {
  const sorted = [...data.cycles].sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (sorted.length < 2) return { shortest: data.cycleLength, longest: data.cycleLength };
  const lengths = [];
  for (let i = 1; i < sorted.length; i++) {
    lengths.push(diffDays(sorted[i - 1].startDate, sorted[i].startDate));
  }
  return { shortest: Math.min(...lengths), longest: Math.max(...lengths) };
}

function getFertileDaysCombined() {
  const { shortest, longest } = getShortestLongestCycleLengths();
  const actualStarts = data.cycles.map(c => c.startDate);
  const predictedStarts = getPredictedCycles();

  const fertileAll = new Set();
  const highRisk = new Set();
  const ovulationActual = new Set();
  const ovulationPredicted = new Set();

  for (const [starts, ovSet] of [[actualStarts, ovulationActual], [predictedStarts, ovulationPredicted]]) {
    for (const start of starts) {
      const ovDate = addDays(start, data.cycleLength - 14);
      ovSet.add(ovDate);

      // 표준일 피임법: 생리 시작일 기준 8~19일째
      const standard = new Set();
      for (let i = 7; i <= 18; i++) standard.add(addDays(start, i));

      // 크나우스 오기노법: (최단주기-19) ~ (최장주기-10)일째
      const knaus = new Set();
      const kFrom = Math.max(0, shortest - 20);
      const kTo = longest - 11;
      for (let i = kFrom; i <= kTo; i++) knaus.add(addDays(start, i));

      // ACOG 가이드: 배란일(추정) 전5일~후2일
      const acog = new Set();
      for (let i = -5; i <= 2; i++) acog.add(addDays(ovDate, i));

      for (const d of standard) fertileAll.add(d);
      for (const d of knaus)    fertileAll.add(d);
      for (const d of acog)     fertileAll.add(d);

      // 3가지 모두 해당되는 날 = 고위험
      for (const d of standard) {
        if (knaus.has(d) && acog.has(d)) highRisk.add(d);
      }
    }
  }

  return { fertileAll, highRisk, ovulationActual, ovulationPredicted };
}

function getNextPeriodInfo() {
  if (!data.cycles.length) return null;
  const sorted = [...data.cycles].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const last = sorted[sorted.length - 1];
  const today = toDateStr(new Date());
  // Check if currently in period
  const lastLen = last.endDate ? diffDays(last.startDate, last.endDate) + 1 : data.periodLength;
  for (let i = 0; i < lastLen; i++) {
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
  const ov0 = addDays(last.startDate, data.cycleLength - 14);
  const d0 = diffDays(today, ov0);
  if (d0 >= -1) return { days: d0, date: ov0 };

  // Predicted future cycles
  for (let i = 1; i <= 3; i++) {
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
  const intimate = new Set(data.intimateDates);

  const isCombined = (data.fertileMethod || 'standard') === 'combined';
  let fertileAll, fertileAllPredicted, ovulation, predictedOvulation;
  let fertileCombined, highRisk, ovulationActual, ovulationPredicted;

  if (isCombined) {
    const r = getFertileDaysCombined();
    fertileCombined = r.fertileAll;
    highRisk = r.highRisk;
    ovulationActual = r.ovulationActual;
    ovulationPredicted = r.ovulationPredicted;
    fertileAll = new Set(); fertileAllPredicted = new Set();
    ovulation = new Set(); predictedOvulation = new Set();
  } else {
    const fert = getFertileAndOvulationDays();
    ovulation = fert.ovulation;
    predictedOvulation = fert.predictedOvulation;
    fertileAll = new Set([...fert.fertile, ...fert.ovulation]);
    fertileAllPredicted = new Set([...fert.predictedFertile, ...fert.predictedOvulation]);
    fertileCombined = new Set(); highRisk = new Set();
    ovulationActual = new Set(); ovulationPredicted = new Set();
  }

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
    } else if (isCombined && fertileCombined.has(dateStr)) {
      const dow = fromDateStr(dateStr).getDay();
      classes.push(highRisk.has(dateStr) ? 'fertile-line-high' : 'fertile-line');
      if (!fertileCombined.has(addDays(dateStr, -1)) || dow === 0) classes.push('fertile-line-start');
      if (!fertileCombined.has(addDays(dateStr, 1))  || dow === 6) classes.push('fertile-line-end');
      if (ovulationActual.has(dateStr))    classes.push(highRisk.has(dateStr) ? 'ovulation-dot-high' : 'ovulation-dot');
      if (ovulationPredicted.has(dateStr)) classes.push('ovulation-dot-predicted');
    } else if (fertileAll.has(dateStr)) {
      const dow = fromDateStr(dateStr).getDay();
      classes.push('fertile-line');
      if (!fertileAll.has(addDays(dateStr, -1)) || dow === 0) classes.push('fertile-line-start');
      if (!fertileAll.has(addDays(dateStr, 1))  || dow === 6) classes.push('fertile-line-end');
      if (ovulation.has(dateStr)) classes.push('ovulation-dot');
    } else if (fertileAllPredicted.has(dateStr)) {
      const dow = fromDateStr(dateStr).getDay();
      classes.push('fertile-line-predicted');
      if (!fertileAllPredicted.has(addDays(dateStr, -1)) || dow === 0) classes.push('fertile-line-start');
      if (!fertileAllPredicted.has(addDays(dateStr, 1))  || dow === 6) classes.push('fertile-line-end');
      if (predictedOvulation.has(dateStr)) classes.push('ovulation-dot-predicted');
    }

    cell.className = classes.join(' ');

    const num = document.createElement('span');
    num.className = 'day-number';
    num.textContent = day;
    cell.appendChild(num);

    const ind = document.createElement('div');
    ind.className = 'indicators';

    if (intimate.has(dateStr)) {
      const icon = data.intimateIcon || '💟';
      const h = document.createElement('span');
      h.className = 'indicator-heart' + (RED_HEARTS.has(icon) ? ' indicator-heart-bg' : '');
      h.textContent = icon;
      cell.appendChild(h);
    }

    if (data.memos[dateStr]) {
      const m = document.createElement('div');
      m.className = 'memo-preview';
      m.textContent = data.memos[dateStr];
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
  if ((data.fertileMethod || 'standard') === 'combined') {
    const { fertileAll: fa, highRisk: hr, ovulationActual: oa, ovulationPredicted: op } = getFertileDaysCombined();
    if (hr.has(dateStr)) statusParts.push('🔴 고위험 가임기');
    else if (fa.has(dateStr)) statusParts.push('💙 가임기');
    if (oa.has(dateStr)) statusParts.push('🌸 배란일 (추정)');
    if (op.has(dateStr)) statusParts.push('🌸 배란일 예정 (추정)');
  } else {
    if (ovulation.has(dateStr)) statusParts.push('🌸 배란일');
    if (predictedOvulation.has(dateStr)) statusParts.push('🌸 배란일 예정');
    if (fertile.has(dateStr) || predictedFertile.has(dateStr)) statusParts.push('💙 가임기');
  }

  document.getElementById('modalStatus').textContent = statusParts.join('  ') || '';

  // Period start button state
  const isCycleStart = data.cycles.some(c => c.startDate === dateStr);
  const periodBtn = document.getElementById('togglePeriod');
  periodBtn.textContent = isCycleStart ? '🩸 생리 시작일 해제' : '🩸 생리 시작일로 설정';
  periodBtn.classList.toggle('active', isCycleStart);

  // Period end button state
  const relatedCycle = getCycleForEndDate(dateStr);
  const endBtn = document.getElementById('togglePeriodEnd');
  if (relatedCycle) {
    endBtn.classList.remove('hidden');
    const isEndDate = relatedCycle.endDate === dateStr;
    endBtn.textContent = isEndDate ? '🩸 생리 종료일 해제' : '🩸 생리 종료일로 설정';
    endBtn.classList.toggle('active', isEndDate);
  } else {
    endBtn.classList.add('hidden');
  }

  // Intimate button state
  const isIntimate = data.intimateDates.includes(dateStr);
  const intimateBtn = document.getElementById('toggleIntimate');
  const intimateIcon = data.intimateIcon || '💟';
  intimateBtn.textContent = isIntimate ? `${intimateIcon} 사랑한 날 해제` : `${intimateIcon} 사랑한 날 기록`;
  intimateBtn.classList.toggle('active', isIntimate);
  document.getElementById('iconPicker').classList.add('hidden');

  // Memo
  document.getElementById('memoInput').value = data.memos[dateStr] || '';

  document.getElementById('dayModal').classList.remove('hidden');
}

function closeDayModal() {
  document.getElementById('dayModal').classList.add('hidden');
  document.getElementById('iconPicker').classList.add('hidden');
  selectedDate = null;
}

function openIconPicker() {
  const picker = document.getElementById('iconPicker');
  if (!picker.classList.contains('hidden')) {
    picker.classList.add('hidden');
    return;
  }
  const current = data.intimateIcon || '💟';
  picker.innerHTML = INTIMATE_ICONS.map((e, i) =>
    `<button class="icon-picker-btn${e === current ? ' selected' : ''}" onclick="selectIntimateIcon(${i})">${e}</button>`
  ).join('');
  picker.classList.remove('hidden');
}

function selectIntimateIcon(idx) {
  const icon = INTIMATE_ICONS[idx];
  data.intimateIcon = icon;
  saveData();

  const intimateBtn = document.getElementById('toggleIntimate');
  const isActive = intimateBtn.classList.contains('active');
  intimateBtn.textContent = isActive ? `${icon} 사랑한 날 해제` : `${icon} 사랑한 날 기록`;

  document.querySelectorAll('.icon-picker-btn').forEach((btn, i) => {
    btn.classList.toggle('selected', i === idx);
  });

  renderCalendar(currentYear, currentMonth);
}

// ── Toggle actions ─────────────────────────────────────
function togglePeriodStart() {
  if (!selectedDate) return;
  const idx = data.cycles.findIndex(c => c.startDate === selectedDate);
  if (idx >= 0) {
    data.cycles.splice(idx, 1);
    showToast('생리 시작일이 해제되었어요');
  } else {
    // 가까운 날짜(생리 기간 + 2일 이내)에 기존 시작일이 있으면 교체 (날짜 수정)
    const threshold = data.periodLength + 2;
    const nearbyIdx = data.cycles.findIndex(
      c => Math.abs(diffDays(c.startDate, selectedDate)) <= threshold
    );
    if (nearbyIdx >= 0) {
      const old = data.cycles[nearbyIdx];
      const updated = { startDate: selectedDate };
      if (old.endDate && old.endDate >= selectedDate) updated.endDate = old.endDate;
      data.cycles.splice(nearbyIdx, 1, updated);
      showToast('생리 시작일이 수정되었어요 🩸');
    } else {
      data.cycles.push({ startDate: selectedDate });
      showToast('생리 시작일이 기록되었어요 🩸');
    }
    data.cycles.sort((a, b) => a.startDate.localeCompare(b.startDate));
  }
  saveData();
  renderCalendar(currentYear, currentMonth);
  updateCycleInfoBar();
  checkAndNotify();
  updatePushServer();
  openDayModal(selectedDate); // refresh modal state
}

function togglePeriodEnd() {
  if (!selectedDate) return;
  const cycle = getCycleForEndDate(selectedDate);
  if (!cycle) return;

  if (cycle.endDate === selectedDate) {
    delete cycle.endDate;
    showToast('생리 종료일이 해제되었어요');
  } else {
    cycle.endDate = selectedDate;
    showToast('생리 종료일이 기록되었어요 🩸');
  }
  saveData();
  renderCalendar(currentYear, currentMonth);
  updateCycleInfoBar();
  openDayModal(selectedDate);
}

function toggleIntimate() {
  if (!selectedDate) return;
  const idx = data.intimateDates.indexOf(selectedDate);
  if (idx >= 0) {
    data.intimateDates.splice(idx, 1);
    showToast('기록이 해제되었어요');
  } else {
    data.intimateDates.push(selectedDate);
    showToast(`사랑한 날이 기록되었어요 ${data.intimateIcon || '💟'}`);
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

// ── Stats modal ────────────────────────────────────────
function openStats() {
  renderStatsModal();
  document.getElementById('statsModal').classList.remove('hidden');
}

function closeStats() {
  document.getElementById('statsModal').classList.add('hidden');
}

function renderStatsModal() {
  renderSummaryCards();
  renderCycleList();
}

function renderSummaryCards() {
  const container = document.getElementById('statsSummaryCards');
  if (!data.cycles.length) {
    container.innerHTML = '';
    return;
  }
  const sorted = [...data.cycles].sort((a, b) => a.startDate.localeCompare(b.startDate));

  // 주기 길이들
  const cycleLengths = [];
  for (let i = 1; i < sorted.length; i++) {
    cycleLengths.push(diffDays(sorted[i - 1].startDate, sorted[i].startDate));
  }

  // 생리 기간들 (종료일 있는 것만)
  const periodLengths = sorted
    .filter(c => c.endDate)
    .map(c => diffDays(c.startDate, c.endDate) + 1);

  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const minVal = arr => arr.length ? Math.min(...arr) : null;
  const maxVal = arr => arr.length ? Math.max(...arr) : null;

  const avgCycle = avg(cycleLengths);
  const avgPeriod = avg(periodLengths);

  const cards = [
    {
      label: '평균 주기',
      value: avgCycle ?? data.cycleLength,
      unit: '일',
      sub: cycleLengths.length >= 2
        ? `${minVal(cycleLengths)}~${maxVal(cycleLengths)}일`
        : cycleLengths.length === 1 ? `${cycleLengths[0]}일 (1회)` : '설정값 기준'
    },
    {
      label: '평균 생리 기간',
      value: avgPeriod ?? data.periodLength,
      unit: '일',
      sub: periodLengths.length >= 2
        ? `${minVal(periodLengths)}~${maxVal(periodLengths)}일`
        : periodLengths.length === 1 ? `${periodLengths[0]}일 (1회)` : '설정값 기준'
    },
    {
      label: '총 기록',
      value: sorted.length,
      unit: '회',
      sub: `${formatDate(sorted[0].startDate).slice(0, 8)} ~`
    },
    {
      label: '설정 주기',
      value: data.cycleLength,
      unit: '일',
      sub: `생리 기간 ${data.periodLength}일`
    }
  ];

  container.innerHTML = cards.map(c => `
    <div class="stats-card">
      <div class="stats-card-label">${c.label}</div>
      <div class="stats-card-value">${c.value}<span class="stats-card-unit"> ${c.unit}</span></div>
      <div class="stats-card-label">${c.sub}</div>
    </div>
  `).join('');
}

// ── Settings modal ─────────────────────────────────────
function openSettings() {
  document.getElementById('cycleLength').value = data.cycleLength;
  document.getElementById('periodLength').value = data.periodLength;
  document.getElementById('notifyDaysBefore').value = data.notifications.daysBefore;
  document.getElementById('notifyTime').value = data.notifications.notifyTime ?? '08:00';
  const method = data.fertileMethod || 'standard';
  document.querySelectorAll('input[name="fertileMethod"]').forEach(r => { r.checked = r.value === method; });
  updateNotifStatus();
  updateSyncStatus();
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.add('hidden');
}

function saveSettings() {
  const cl = parseInt(document.getElementById('cycleLength').value);
  const pl = parseInt(document.getElementById('periodLength').value);
  const nb = parseInt(document.getElementById('notifyDaysBefore').value);

  const nt = document.getElementById('notifyTime').value;
  if (cl >= 21 && cl <= 45) data.cycleLength = cl;
  if (pl >= 2 && pl <= 10) data.periodLength = pl;
  if (nb >= 0 && nb <= 7) data.notifications.daysBefore = nb;
  if (nt) data.notifications.notifyTime = nt;
  const selectedMethod = document.querySelector('input[name="fertileMethod"]:checked');
  if (selectedMethod) data.fertileMethod = selectedMethod.value;

  saveData();
  renderCalendar(currentYear, currentMonth);
  updateCycleInfoBar();
  updateLegend();
  updatePushServer();
  closeSettings();
  showToast('설정이 저장되었어요');
}

function renderCycleList() {
  const container = document.getElementById('statsCycleList');
  const sorted = [...data.cycles].sort((a, b) => b.startDate.localeCompare(a.startDate));

  if (!sorted.length) {
    container.innerHTML = '<div class="no-data-hint">기록된 생리 주기가 없어요.<br>달력에서 시작일을 탭해 기록하세요.</div>';
    return;
  }

  // 주기 간격 계산 (오름차순으로 계산)
  const asc = [...sorted].reverse();
  const cycleLengths = [];
  for (let i = 1; i < asc.length; i++) {
    cycleLengths.push(diffDays(asc[i - 1].startDate, asc[i].startDate));
  }
  const avgCycle = cycleLengths.length
    ? Math.round(cycleLengths.reduce((a, b) => a + b, 0) / cycleLengths.length)
    : null;

  const summary = avgCycle !== null
    ? `<div class="cycle-summary">📊 평균 주기 <strong>${avgCycle}일</strong> · 총 ${sorted.length}회 기록</div>`
    : '';

  const items = sorted.map((c, i) => {
    const actualIdx = data.cycles.findIndex(x => x.startDate === c.startDate);
    const endDate = c.endDate || addDays(c.startDate, data.periodLength - 1);
    const periodLen = c.endDate ? diffDays(c.startDate, c.endDate) + 1 : data.periodLength;
    const endLabel = c.endDate ? formatDate(endDate) : `${formatDate(endDate)} (예정)`;
    // sorted는 내림차순이므로 i-1이 다음 주기(더 최근)
    // 이전 시작일 → 이 시작일 간격 (sorted는 내림차순이므로 i+1이 이전 주기)
    const cycleLen = i < sorted.length - 1
      ? diffDays(sorted[i + 1].startDate, sorted[i].startDate)
      : null;
    const cycleLenLabel = cycleLen !== null
      ? `<span class="cycle-length-badge">${cycleLen}일 주기</span>`
      : '';
    return `
      <div class="cycle-item">
        <div class="cycle-item-body">
          <div class="cycle-item-top">
            <span class="cycle-item-date">${formatDate(c.startDate)}</span>
            ${cycleLenLabel}
          </div>
          <div class="cycle-item-info">~ ${endLabel} · 생리 ${periodLen}일</div>
        </div>
        <button class="cycle-delete-btn" onclick="deleteCycle(${actualIdx})">✕</button>
      </div>`;
  }).join('');

  container.innerHTML = summary + items;
}

function deleteCycle(idx) {
  if (!confirm('이 주기 기록을 삭제할까요?')) return;
  data.cycles.splice(idx, 1);
  saveData();
  renderCalendar(currentYear, currentMonth);
  updateCycleInfoBar();
  renderStatsModal();
  showToast('삭제되었어요');
}

// ── Notifications ──────────────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    updateNotifStatus();
    return;
  }

  // 권한이 이미 허용된 경우 → 활성화/비활성화 토글
  if (Notification.permission === 'granted') {
    data.notifications.enabled = !data.notifications.enabled;
    saveData();
    updateNotifStatus();
    if (data.notifications.enabled) {
      showToast('알림이 켜졌어요 🔔');
      subscribeToPush();
    } else {
      showToast('알림이 꺼졌어요 🔕');
      unregisterPushFromServer();
    }
    return;
  }

  const result = await Notification.requestPermission();
  data.notifications.enabled = result === 'granted';
  saveData();
  updateNotifStatus();

  if (result === 'granted') {
    showToast('알림이 허용되었어요 🔔');
    checkAndNotify();
    subscribeToPush();
  } else {
    showToast('알림 권한이 거부되었어요');
  }
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
    if (data.notifications.enabled) {
      statusEl.textContent = PUSH_SERVER_URL ? '✅ 알림 켜짐 (백그라운드 알림 활성)' : '✅ 알림 켜짐 (홈 화면 추가 후 작동)';
      btn.textContent = '🔔 알림 켜짐 (탭하면 끄기)';
      btn.classList.add('granted');
      btn.classList.remove('muted');
    } else {
      statusEl.textContent = '🔕 알림 꺼짐 — 버튼을 눌러 다시 켜세요';
      btn.textContent = '🔕 알림 꺼짐 (탭하면 켜기)';
      btn.classList.remove('granted');
      btn.classList.add('muted');
    }
  } else if (perm === 'denied') {
    statusEl.textContent = '❌ 알림 거부됨 — 설정에서 변경해주세요';
    btn.classList.remove('granted', 'muted');
  } else {
    statusEl.textContent = '⚠️ 홈 화면에 추가한 뒤 알림을 허용하세요';
    btn.classList.remove('granted', 'muted');
  }
}

function checkAndNotify() {
  if (!data.cycles.length) return;
  if (Notification.permission !== 'granted') return;
  if (!data.notifications.enabled) return;

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

// ── Push helpers ──────────────────────────────────────
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function getNextPeriodDate() {
  const info = getNextPeriodInfo();
  if (!info) return null;
  if (info.type === 'upcoming') return info.date;
  // inPeriod or overdue: next predicted cycle
  const sorted = [...data.cycles].sort((a, b) => a.startDate.localeCompare(b.startDate));
  return addDays(sorted[sorted.length - 1].startDate, data.cycleLength);
}

async function initPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    _pushSubscription = await reg.pushManager.getSubscription();
  } catch (e) {
    console.warn('getSubscription failed:', e);
  }
}

async function subscribeToPush() {
  if (!PUSH_SERVER_URL || !VAPID_PUBLIC_KEY) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    _pushSubscription = sub;
    await fetch(`${PUSH_SERVER_URL}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        nextPeriodDate: getNextPeriodDate(),
        daysBefore: data.notifications.daysBefore,
        notifyTime: data.notifications.notifyTime ?? '08:00'
      })
    });
  } catch (e) {
    console.warn('subscribeToPush failed:', e);
  }
}

async function unregisterPushFromServer() {
  if (!PUSH_SERVER_URL || !_pushSubscription) return;
  try {
    await fetch(`${PUSH_SERVER_URL}/unsubscribe`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: _pushSubscription.endpoint })
    });
    await _pushSubscription.unsubscribe();
    _pushSubscription = null;
  } catch (e) {
    console.warn('unregisterPushFromServer failed:', e);
  }
}

async function updatePushServer() {
  if (!PUSH_SERVER_URL || !_pushSubscription) return;
  const nextDate = getNextPeriodDate();
  try {
    await fetch(`${PUSH_SERVER_URL}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: _pushSubscription.endpoint,
        nextPeriodDate: nextDate,
        daysBefore: data.notifications.daysBefore,
        notifyTime: data.notifications.notifyTime ?? '08:00'
      })
    });
  } catch (e) {
    console.warn('updatePushServer failed:', e);
  }
}

// ── Backup / Restore ───────────────────────────────────
function exportData() {
  try {
    const json = JSON.stringify(data, null, 2);
    const date = toDateStr(new Date()).replace(/-/g, '');
    const a = document.createElement('a');
    a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
    a.download = `달력_백업_${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('백업 파일이 저장되었어요 📤');
  } catch (err) {
    alert('백업 오류: ' + err.message);
  }
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed.cycles || !parsed.intimateDates) throw new Error('invalid');
      if (!confirm('현재 데이터가 백업 파일로 교체됩니다. 계속할까요?')) return;
      data = parsed;
      saveData();
      renderCalendar(currentYear, currentMonth);
      updateCycleInfoBar();
      updateLegend();
      showToast('복원되었어요 📥');
    } catch {
      showToast('올바른 백업 파일이 아니에요');
    }
  };
  reader.readAsText(file);
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

// ── Fertile Info Modal ─────────────────────────────────
function openFertileInfo() {
  document.getElementById('fertileInfoModal').classList.remove('hidden');
}

function closeFertileInfo() {
  document.getElementById('fertileInfoModal').classList.add('hidden');
}

// ── Install Guide modal ────────────────────────────────
function openInstallGuide() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isAndroid = /android/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  document.getElementById('installGuideIOS').classList.add('hidden');
  document.getElementById('installGuideAndroid').classList.add('hidden');
  document.getElementById('installGuideAlreadyInstalled').classList.add('hidden');

  if (isStandalone) {
    document.getElementById('installGuideAlreadyInstalled').classList.remove('hidden');
  } else if (isIOS) {
    document.getElementById('installGuideIOS').classList.remove('hidden');
  } else if (isAndroid) {
    document.getElementById('installGuideAndroid').classList.remove('hidden');
  } else {
    document.getElementById('installGuideIOS').classList.remove('hidden');
    document.getElementById('installGuideAndroid').classList.remove('hidden');
  }

  document.getElementById('installGuideModal').classList.remove('hidden');
}

function closeInstallGuide() {
  document.getElementById('installGuideModal').classList.add('hidden');
}

// ── Legend ─────────────────────────────────────────────
function updateLegend() {
  const isCombined = (data.fertileMethod || 'standard') === 'combined';
  const highRiskEl = document.getElementById('legendHighRisk');
  const ovulationEl = document.getElementById('legendOvulation');
  if (highRiskEl) highRiskEl.classList.toggle('hidden', !isCombined);
  if (ovulationEl) ovulationEl.classList.toggle('hidden', isCombined);
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

// ── Month Picker ───────────────────────────────────────
let pickerYear = new Date().getFullYear();

function openMonthPicker() {
  pickerYear = currentYear;
  renderMonthPicker();
  document.getElementById('monthPicker').classList.remove('hidden');
  document.getElementById('pickerBackdrop').classList.remove('hidden');
}

function closeMonthPicker() {
  document.getElementById('monthPicker').classList.add('hidden');
  document.getElementById('pickerBackdrop').classList.add('hidden');
}

function renderMonthPicker() {
  document.getElementById('pickerYear').textContent = `${pickerYear}년`;
  const today = new Date();
  const MONTHS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
  document.getElementById('pickerMonths').innerHTML = MONTHS.map((m, i) => {
    const isCurrent = pickerYear === currentYear && i === currentMonth;
    const isToday = pickerYear === today.getFullYear() && i === today.getMonth();
    const cls = ['picker-month-btn', isCurrent ? 'current' : '', isToday && !isCurrent ? 'today-month' : ''].join(' ').trim();
    return `<button class="${cls}" onclick="selectPickerMonth(${i})">${m}</button>`;
  }).join('');
}

function selectPickerMonth(month) {
  currentYear = pickerYear;
  currentMonth = month;
  renderCalendar(currentYear, currentMonth);
  closeMonthPicker();
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

    // 새 SW가 활성화되면 자동 새로고침 (첫 설치 제외)
    let isFirstInstall = !navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!isFirstInstall) window.location.reload();
      isFirstInstall = false;
    });
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
  document.getElementById('monthTitle').addEventListener('click', openMonthPicker);
  document.getElementById('pickerBackdrop').addEventListener('click', closeMonthPicker);
  document.getElementById('pickerPrevYear').addEventListener('click', () => { pickerYear--; renderMonthPicker(); });
  document.getElementById('pickerNextYear').addEventListener('click', () => { pickerYear++; renderMonthPicker(); });
  document.getElementById('statsBtn').addEventListener('click', openStats);
  document.getElementById('settingsBtn').addEventListener('click', openSettings);

  document.getElementById('closeModal').addEventListener('click', closeDayModal);
  document.getElementById('togglePeriod').addEventListener('click', togglePeriodStart);
  document.getElementById('togglePeriodEnd').addEventListener('click', togglePeriodEnd);
  document.getElementById('toggleIntimate').addEventListener('click', toggleIntimate);
  document.getElementById('editIntimateIcon').addEventListener('click', openIconPicker);
  document.getElementById('saveMemo').addEventListener('click', saveMemo);

  document.getElementById('closeSettings').addEventListener('click', closeSettings);
  document.getElementById('saveSettings').addEventListener('click', saveSettings);
  document.getElementById('enableNotifications').addEventListener('click', requestNotificationPermission);
  document.getElementById('exportData').addEventListener('click', exportData);
  document.getElementById('importFile').addEventListener('change', e => {
    importData(e.target.files[0]);
    e.target.value = '';
  });

  // Close modal on backdrop click
  document.getElementById('dayModal').addEventListener('click', function(e) {
    if (e.target === this) closeDayModal();
  });
  document.getElementById('settingsModal').addEventListener('click', function(e) {
    if (e.target === this) closeSettings();
  });
  document.getElementById('statsModal').addEventListener('click', function(e) {
    if (e.target === this) closeStats();
  });
  document.getElementById('closeStats').addEventListener('click', closeStats);
  document.getElementById('closeFertileInfo').addEventListener('click', closeFertileInfo);
  document.getElementById('fertileInfoModal').addEventListener('click', function(e) {
    if (e.target === this) closeFertileInfo();
  });
  document.getElementById('installGuideBtn').addEventListener('click', openInstallGuide);
  document.getElementById('closeInstallGuide').addEventListener('click', closeInstallGuide);
  document.getElementById('installGuideModal').addEventListener('click', function(e) {
    if (e.target === this) closeInstallGuide();
  });

  // Sync events
  document.getElementById('syncShareBtn').addEventListener('click', shareSyncCode);
  document.getElementById('syncCreateBtn').addEventListener('click', () => {
    if (syncCode && !confirm('새 코드를 만들면 기존 연결이 끊어집니다. 계속할까요?')) return;
    setSyncCode(generateSyncCode());
    updateSyncStatus();
    syncSave();
    showToast(`코드 생성됨: ${syncCode}`);
  });
  document.getElementById('syncConnectBtn').addEventListener('click', () => {
    const input = document.getElementById('syncCodeInput').value.toUpperCase().trim();
    if (input.length !== 10) { showToast('코드는 10자리여야 해요'); return; }
    setSyncCode(input);
    document.getElementById('syncCodeInput').value = '';
    updateSyncStatus();
    syncLoad().then(() => showToast('연결되었어요 ✓'));
  });
  document.getElementById('syncDisconnectBtn').addEventListener('click', () => {
    if (!confirm('동기화 연결을 해제할까요?')) return;
    clearSyncCode();
    updateSyncStatus();
    showToast('동기화 해제됨');
  });

  updateLegend();
  initSwipe();
  registerSW();

  // Check notifications after a short delay
  setTimeout(checkAndNotify, 1500);
  setTimeout(initPushSubscription, 2000);

  // 동기화: 시작 시 로드, 이후 30초마다 체크
  setTimeout(syncLoad, 3000);
  setInterval(syncLoad, 30000);
}

document.addEventListener('DOMContentLoaded', init);
