'use strict';

// ── Push server config (Worker 배포 후 채워주세요) ──────
const PUSH_SERVER_URL  = 'https://period-tracker-push.life-app.workers.dev';
const VAPID_PUBLIC_KEY = 'URfnrL_y-iMmUH5-Ebz6VAIbAE8mep3lr8H2wClZZqw';

// ── Android PWA install prompt ─────────────────────────
let _installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _installPrompt = e;
});

// ── State ──────────────────────────────────────────────
let currentYear, currentMonth;
let selectedDate = null;
let data = {};
let _pushSubscription = null;
let memoDebounceTimer = null;
let _memoOriginalText = '';
let _pendingAnniversaryLabel = null;
let _pendingCalType = 'solar';
let _pendingLunarMonth = 1;
let _pendingLunarDay = 1;
let _pendingLunarLeap = false;
let _newMemoDates = new Set(); // 상대방이 변경한 메모가 있는 날짜

const STORAGE_KEY = 'periodTrackerData_v1';

const INTIMATE_ICONS = ['💟','❤️','🩷','🧡','💛','💚','💙','💜','🖤','🤍','💕','💞','💓','💗','💖','💝','💘','🌸','🍓','💋','🌹','🦋'];
const RED_HEARTS = new Set(['❤️','🩷','🧡','💕','💞','💓','💗','💖','💝','💘','🌸','🍓','💋','🌹','🦋']);

// ── 한국 공휴일 ────────────────────────────────────────
const FIXED_HOLIDAYS_NAMED = {
  '01-01': '신정',
  '03-01': '삼일절',
  '05-01': '근로자의 날',
  '05-05': '어린이날',
  '06-06': '현충일',
  '07-17': '제헌절',
  '08-15': '광복절',
  '10-03': '개천절',
  '10-09': '한글날',
  '12-25': '성탄절',
};
// 음력 공휴일, 선거일, 음력 관련 대체공휴일 (연도별)
// 고정 공휴일 대체공휴일은 getSubstituteHolidays()가 자동 계산
const YEAR_HOLIDAYS = {
  2023: {
    '01-21': '설날 전날', '01-22': '설날', '01-23': '설날 다음날', '01-24': '대체공휴일',
    '05-27': '부처님오신날', '05-29': '부처님오신날 대체공휴일',
    '09-28': '추석 전날', '09-29': '추석', '09-30': '추석 다음날', '10-02': '대체공휴일',
  },
  2024: {
    '02-09': '설날 전날', '02-10': '설날', '02-11': '설날 다음날', '02-12': '대체공휴일',
    '04-10': '제22대 국회의원선거일',
    '05-15': '부처님오신날',
    '09-16': '추석 전날', '09-17': '추석', '09-18': '추석 다음날',
  },
  2025: {
    '01-28': '설날 전날', '01-29': '설날', '01-30': '설날 다음날',
    '05-05': '어린이날·부처님오신날', '05-06': '대체공휴일',
    '06-03': '제21대 대통령선거일',
    '10-05': '추석 전날', '10-06': '추석', '10-07': '추석 다음날', '10-08': '대체공휴일',
  },
  2026: {
    '02-16': '설날 전날', '02-17': '설날', '02-18': '설날 다음날',
    '05-24': '부처님오신날', '05-25': '부처님오신날 대체공휴일',
    '06-03': '제9회 전국동시지방선거일',
    '09-24': '추석 전날', '09-25': '추석', '09-26': '추석 다음날', '09-28': '대체공휴일',
  },
  2027: {
    '02-06': '설날 전날', '02-07': '설날', '02-08': '설날 다음날', '02-09': '대체공휴일',
    '05-13': '부처님오신날',
    '09-14': '추석 전날', '09-15': '추석', '09-16': '추석 다음날',
  },
  2028: {
    '01-26': '설날 전날', '01-27': '설날', '01-28': '설날 다음날',
    '04-12': '제23대 국회의원선거일',
    '05-02': '부처님오신날',
    '10-02': '추석 전날', '10-03': '추석·개천절', '10-04': '추석 다음날', '10-05': '대체공휴일',
  },
  2029: {
    '02-12': '설날 전날', '02-13': '설날', '02-14': '설날 다음날',
    '05-20': '부처님오신날',
    '09-21': '추석 전날', '09-22': '추석', '09-23': '추석 다음날',
  },
  2030: {
    '02-02': '설날 전날', '02-03': '설날', '02-04': '설날 다음날',
    '05-09': '부처님오신날',
    '06-04': '제10회 전국동시지방선거일',
    '09-11': '추석 전날', '09-12': '추석', '09-13': '추석 다음날',
  },
};

// 고정 공휴일이 주말이면 다음 평일을 대체공휴일로 자동 계산 (2100년까지)
const _subCache = {};
function getSubstituteHolidays(year) {
  if (_subCache[year]) return _subCache[year];
  const result = {};
  const ys = YEAR_HOLIDAYS[year] || {};
  function mmddOf(d) {
    return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function occupied(mmdd) {
    return mmdd in FIXED_HOLIDAYS_NAMED || mmdd in ys || mmdd in result;
  }
  // 대체공휴일 미적용 공휴일 (현충일, 제헌절 등 법정 제외)
  const NO_SUBSTITUTE = new Set(['06-06']);
  for (const [mmdd, name] of Object.entries(FIXED_HOLIDAYS_NAMED)) {
    if (NO_SUBSTITUTE.has(mmdd)) continue;
    const [m, d] = mmdd.split('-').map(Number);
    const dow = new Date(year, m - 1, d).getDay();
    if (dow === 0 || dow === 6) {
      const sub = new Date(year, m - 1, d);
      sub.setDate(sub.getDate() + (dow === 6 ? 2 : 1));
      while (occupied(mmddOf(sub)) || sub.getDay() === 0 || sub.getDay() === 6)
        sub.setDate(sub.getDate() + 1);
      result[mmddOf(sub)] = name + ' 대체공휴일';
    }
  }
  _subCache[year] = result;
  return result;
}

function getHolidayName(dateStr) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const mmdd = dateStr.slice(5);
  return (YEAR_HOLIDAYS[year] || {})[mmdd]
    || FIXED_HOLIDAYS_NAMED[mmdd]
    || getSubstituteHolidays(year)[mmdd]
    || null;
}
function isKoreanHoliday(dateStr) {
  return getHolidayName(dateStr) !== null;
}

// ── 음력 ⇄ 양력 변환 (1900~2100) ─────────────────────────
const LUNAR_INFO = [
0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,
0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,
0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,
0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,
0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,
0x06ca0,0x0b550,0x15355,0x04da0,0x0a5d0,0x14573,0x052d0,0x0a9a8,0x0e950,0x06aa0,
0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,
0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b5a0,0x195a6,
0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,
0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x055c0,0x0ab60,0x096d5,0x092e0,
0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,
0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,
0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,
0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,
0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0,
0x14b63,0x09370,0x049f8,0x04970,0x064b0,0x168a6,0x0ea50,0x06b20,0x1a6c4,0x0aae0,
0x0a2e0,0x0d2e3,0x0c960,0x0d557,0x0d4a0,0x0da50,0x05d55,0x056a0,0x0a6d0,0x055d4,
0x052d0,0x0a9b8,0x0a950,0x0b4a0,0x0b6a6,0x0ad50,0x055a0,0x0aba4,0x0a5b0,0x052b0,
0x0b273,0x06930,0x07337,0x06aa0,0x0ad50,0x14b55,0x04b60,0x0a570,0x054e4,0x0d160,
0x0e968,0x0d520,0x0daa0,0x16aa6,0x056d0,0x04ae0,0x0a9d4,0x0a2d0,0x0d150,0x0f252,
0x0d520
];
const LUNAR_BASE_YEAR = 1900;

// 표준 음력 변환 알고리즘은 극히 드물게(신월 발생 시각이 한국·중국 시간대 경계에
// 걸치는 해) 한국 공식(KASI) 음력과 하루 어긋난다. 이 파일의 YEAR_HOLIDAYS(설날/
// 추석/부처님오신날, KASI 기준)로 검증해 발견된 어긋남만 보정한다.
const LUNAR_KR_DAY_OVERRIDE = new Set(['2023-4-8', '2027-1-1', '2028-1-1']);

function _lunarLeapMonth(y) { return LUNAR_INFO[y - LUNAR_BASE_YEAR] & 0xf; }
function _lunarLeapDays(y) {
  if (_lunarLeapMonth(y)) return (LUNAR_INFO[y - LUNAR_BASE_YEAR] & 0x10000) ? 30 : 29;
  return 0;
}
function _lunarMonthDays(y, m) {
  return (LUNAR_INFO[y - LUNAR_BASE_YEAR] & (0x10000 >> m)) ? 30 : 29;
}
function _lunarYearDays(y) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - LUNAR_BASE_YEAR] & i) ? 1 : 0;
  return sum + _lunarLeapDays(y);
}

// 음력 날짜 → 'YYYY-MM-DD' 양력 날짜
function lunarToSolar(lYear, lMonth, lDay, isLeap) {
  if (lYear < LUNAR_BASE_YEAR || lYear > 2100) return null;
  let offset = 0;
  for (let y = LUNAR_BASE_YEAR; y < lYear; y++) offset += _lunarYearDays(y);
  const leap = _lunarLeapMonth(lYear);
  for (let m = 1; m < lMonth; m++) {
    offset += _lunarMonthDays(lYear, m);
    if (m === leap) offset += _lunarLeapDays(lYear);
  }
  if (isLeap) offset += _lunarMonthDays(lYear, lMonth);
  offset += lDay - 1;
  const base = new Date(1900, 0, 31);
  const result = new Date(base.getTime() + offset * 86400000);
  let dateStr = toDateStr(result);
  if (!isLeap && LUNAR_KR_DAY_OVERRIDE.has(`${lYear}-${lMonth}-${lDay}`)) {
    dateStr = addDays(dateStr, 1);
  }
  return dateStr;
}

// 양력 'YYYY-MM-DD' → {year, month, day, isLeap} 음력 날짜 (근사치, 음력 선택 시 초기값 제안용)
function solarToLunar(dateStr) {
  const d = fromDateStr(dateStr);
  const base = new Date(1900, 0, 31);
  let offset = Math.round((d - base) / 86400000);

  let lYear = LUNAR_BASE_YEAR, daysOfYear = 0;
  for (; lYear < 2101 && offset > 0; lYear++) {
    daysOfYear = _lunarYearDays(lYear);
    offset -= daysOfYear;
  }
  if (offset < 0) { offset += daysOfYear; lYear--; }

  const leap = _lunarLeapMonth(lYear);
  let isLeap = false, lMonth = 1, daysOfMonth = 0;
  for (; lMonth < 13 && offset > 0; lMonth++) {
    if (leap > 0 && lMonth === leap + 1 && !isLeap) {
      lMonth--; isLeap = true; daysOfMonth = _lunarLeapDays(lYear);
    } else {
      daysOfMonth = _lunarMonthDays(lYear, lMonth);
    }
    if (isLeap && lMonth === leap + 1) isLeap = false;
    offset -= daysOfMonth;
  }
  if (offset === 0 && leap > 0 && lMonth === leap + 1) {
    if (isLeap) isLeap = false; else { isLeap = true; lMonth--; }
  }
  if (offset < 0) { offset += daysOfMonth; lMonth--; }
  return { year: lYear, month: lMonth, day: offset + 1, isLeap };
}

function lunarMonthLength(lYear, lMonth, isLeap) {
  if (isLeap) return _lunarLeapDays(lYear);
  return _lunarMonthDays(lYear, lMonth);
}

const SYNC_CODE_KEY = 'syncCode';
const SYNC_TS_KEY   = 'syncLastModified';

// ── Diary mode ────────────────────────────────────────
let isDiaryMode = false;
let _suppressClick = false;
const DAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];
let _dTY = 0, _dTScrolled = false, _dLpFired = false;

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

// 디바운스를 건너뛰고 즉시 서버에 저장 (예: 모달을 닫아 편집이 끝난 시점)
function syncSaveNow() {
  if (!PUSH_SERVER_URL || !syncCode || _isSyncing) return;
  clearTimeout(_syncTimer);
  syncSave();
}

// 앱이 백그라운드로 가거나 종료되기 직전, 대기 중인 메모 저장/서버 동기화를 강제로 실행
function flushPendingChanges() {
  // 디바운스 중이던 메모 입력을 즉시 저장 (로컬 + data 객체)
  if (memoDebounceTimer) {
    clearTimeout(memoDebounceTimer);
    memoDebounceTimer = null;
    saveMemo();
  }

  if (!PUSH_SERVER_URL || !syncCode || _isSyncing) return;
  if (_syncTimer === null) return; // 보낼 변경사항 없음

  clearTimeout(_syncTimer);
  _syncTimer = null;

  // 페이지가 곧 닫힐 수 있으므로 응답을 기다리지 않는 sendBeacon/keepalive로 전송
  const payload = JSON.stringify({ code: syncCode, data, lastModified: Date.now() });
  if (navigator.sendBeacon) {
    navigator.sendBeacon(`${PUSH_SERVER_URL}/data/save`, new Blob([payload], { type: 'application/json' }));
  } else {
    fetch(`${PUSH_SERVER_URL}/data/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(() => {});
  }
}

async function syncSave() {
  if (!PUSH_SERVER_URL || !syncCode) return;
  const ts = Date.now();
  try {
    const r = await fetch(`${PUSH_SERVER_URL}/data/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: syncCode, data, lastModified: ts })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    localStorage.setItem(SYNC_TS_KEY, ts);
  } catch (e) {
    console.warn('syncSave failed:', e);
  } finally {
    _syncTimer = null;
  }
}

async function syncLoad() {
  if (!PUSH_SERVER_URL || !syncCode) return false;
  try {
    const r = await fetch(`${PUSH_SERVER_URL}/data/load?code=${syncCode}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    if (!json.data) return false;
    if (json.lastModified > getLocalTs()) {
      if (_syncTimer !== null) return false; // 로컬 변경 대기 중 — 이번 syncSave가 곧 서버를 덮어씀
      _applyServerData(json.data, json.lastModified);
      showToast('✓ 동기화됨');
      return true;
    }
    return false;
  } catch (e) {
    console.warn('syncLoad failed:', e);
    return false;
  }
}

function _applyServerData(serverData, ts) {
  _isSyncing = true;
  const prevMemos = data.memos || {};
  const nextMemos = serverData.memos || {};
  Object.keys(nextMemos).forEach(d => {
    if (nextMemos[d] && nextMemos[d] !== prevMemos[d]) _newMemoDates.add(d);
  });
  data = serverData;
  ensureTsMaps(data);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  localStorage.setItem(SYNC_TS_KEY, ts);
  renderCalendar(currentYear, currentMonth);
  updateCycleInfoBar();
  _isSyncing = false;
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
  ensureTsMaps(data);
}

function defaultData() {
  return {
    cycleLength: 30,
    periodLength: 5,
    fertileMethod: 'standard',
    cycles: [],           // [{startDate: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD'}]
    intimateIcon: '💟',
    intimateDates: [],    // ['YYYY-MM-DD']
    intimateCounts: {},   // {'YYYY-MM-DD': number}
    exerciseDates: [],    // ['YYYY-MM-DD']
    gameDates: [],        // ['YYYY-MM-DD']
    memos: {},            // {'YYYY-MM-DD': 'text'}
    anniversaries: [],    // [{id, label, calendarType:'solar'|'lunar', month, day, leap, sourceDate}]
    memoColors: {},       // {'YYYY-MM-DD': '#hexcolor'}
    memoTs: {},           // {'YYYY-MM-DD': timestamp} — memos 항목별 수정 시각 (병합용)
    memoColorTs: {},      // {'YYYY-MM-DD': timestamp} — memoColors 항목별 수정 시각 (병합용)
    intimateCountTs: {},  // {'YYYY-MM-DD': timestamp} — intimateCounts 항목별 수정 시각 (병합용)
    intimateDatesTs: {},  // {'YYYY-MM-DD': timestamp} — intimateDates 토글 시각 (병합용)
    exerciseDatesTs: {},  // {'YYYY-MM-DD': timestamp} — exerciseDates 토글 시각 (병합용)
    gameDatesTs: {},      // {'YYYY-MM-DD': timestamp} — gameDates 토글 시각 (병합용)
    cyclesTs: {},         // {'YYYY-MM-DD': timestamp} — cycles(startDate 기준) 수정 시각 (병합용)
    notifications: { enabled: false, daysBefore: 1, notifyTime: '08:00' }
  };
}

// 레거시 데이터 호환: 병합용 항목별 수정 시각 맵이 없으면 추가
function ensureTsMaps(d) {
  d.anniversaries = d.anniversaries || [];
  d.memoTs = d.memoTs || {};
  d.memoColorTs = d.memoColorTs || {};
  d.intimateCountTs = d.intimateCountTs || {};
  d.intimateDatesTs = d.intimateDatesTs || {};
  d.exerciseDatesTs = d.exerciseDatesTs || {};
  d.gameDatesTs = d.gameDatesTs || {};
  d.cyclesTs = d.cyclesTs || {};
  return d;
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  scheduleSyncSave();
}

// ── Color utilities ────────────────────────────────────
function getContrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.35 ? '#1C1C1E' : '#ffffff';
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
  const anniversaryMap = getAnniversaryMapForMonth(year, month);
  const actualPeriod = getActualPeriodDays();
  const predictedPeriod = getPredictedPeriodDays();
  const intimate = new Set(data.intimateDates);
  const exercise = new Set(data.exerciseDates || []);
  const game = new Set(data.gameDates || []);

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
  if (_slideDir !== 0) {
    const cls = _slideDir > 0 ? 'slide-right' : 'slide-left';
    grid.classList.add(cls);
    grid.addEventListener('animationend', () => grid.classList.remove(cls), { once: true });
    _slideDir = 0;
  }

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
    if (isKoreanHoliday(dateStr)) classes.push('holiday');

    if (actualPeriod.has(dateStr)) {
      classes.push('period');
      const dow = fromDateStr(dateStr).getDay();
      const isStart = !actualPeriod.has(addDays(dateStr, -1)) || dow === 0;
      const isEnd   = !actualPeriod.has(addDays(dateStr, 1))  || dow === 6;
      if (isStart) classes.push('period-start');
      if (isEnd)   classes.push('period-end');
      if (!isStart && !isEnd) classes.push('period-middle');
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

    const activityList = [];
    if (intimate.has(dateStr)) activityList.push({ icon: data.intimateIcon || '💟', redBg: RED_HEARTS.has(data.intimateIcon || '💟') });
    if (exercise.has(dateStr)) activityList.push({ icon: '🏃', redBg: false });
    if (game.has(dateStr))     activityList.push({ icon: '🎮', redBg: false });
    if (anniversaryMap.has(dateStr)) activityList.push({ icon: '🎂', redBg: false });

    if (activityList.length > 0) {
      const wrap = document.createElement('div');
      wrap.className = activityList.length === 1 ? 'activity-icons single' : 'activity-icons multi';
      activityList.forEach(({ icon, redBg }) => {
        const s = document.createElement('span');
        s.textContent = icon;
        if (redBg) s.className = 'indicator-heart-bg';
        wrap.appendChild(s);
      });
      cell.appendChild(wrap);
    }

    if (data.memos[dateStr]) {
      const m = document.createElement('div');
      m.className = 'memo-preview';
      m.textContent = data.memos[dateStr];
      const mc = (data.memoColors || {})[dateStr];
      if (mc) {
        m.style.background = mc;
        m.style.color = getContrastColor(mc);
        m.classList.add('memo-preview-hl');
      }
      if (_newMemoDates.has(dateStr)) {
        const dot = document.createElement('span');
        dot.className = 'memo-new-dot';
        m.appendChild(dot);
      }
      ind.appendChild(m);
    }

    if (ind.children.length) cell.appendChild(ind);

    cell.dataset.date = dateStr;
    cell.addEventListener('click', () => { if (!_suppressClick) openDayModal(dateStr); });
    grid.appendChild(cell);
  }

  if (isDiaryMode) renderDiary(year, month);
}

// ── Diary ──────────────────────────────────────────────
function toggleDiaryMode(scrollToDate = null) {
  isDiaryMode = !isDiaryMode;
  document.getElementById('diaryBtn').classList.toggle('diary-btn-active', isDiaryMode);
  document.getElementById('calendarContainer').classList.toggle('hidden', isDiaryMode);
  document.getElementById('legend').classList.toggle('hidden', isDiaryMode);
  document.getElementById('diaryContainer').classList.toggle('hidden', !isDiaryMode);
  if (isDiaryMode) renderDiary(currentYear, currentMonth, scrollToDate);
}

function _chip(text, cls) {
  const c = document.createElement('span');
  c.className = 'diary-chip ' + cls;
  c.textContent = text;
  return c;
}

function renderDiary(year, month, forceScrollDate = null) {
  const container = document.getElementById('diaryContainer');
  container.innerHTML = '';

  const totalDays = new Date(year, month + 1, 0).getDate();
  const todayStr = toDateStr(new Date());

  const actualPeriod = getActualPeriodDays();
  const predictedPeriod = getPredictedPeriodDays();
  const { fertile, ovulation } = getFertileAndOvulationDays();
  const intimate = new Set(data.intimateDates || []);
  const exercise = new Set(data.exerciseDates || []);
  const game     = new Set(data.gameDates || []);
  const anniversaryMap = getAnniversaryMapForMonth(year, month);

  for (let day = 1; day <= totalDays; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dow = new Date(year, month, day).getDay();
    const isSun = dow === 0, isSat = dow === 6;
    const isToday    = dateStr === todayStr;
    const holidayName = getHolidayName(dateStr);
    const memo       = data.memos[dateStr] || '';
    const anniversaries = anniversaryMap.get(dateStr) || [];
    const hasActivity = intimate.has(dateStr) || exercise.has(dateStr) || game.has(dateStr);
    const hasPeriod   = actualPeriod.has(dateStr) || predictedPeriod.has(dateStr);
    const hasFertile  = fertile.has(dateStr) || ovulation.has(dateStr);
    const memoColor   = (data.memoColors || {})[dateStr] || null;
    const hasContent  = memo || hasActivity || hasPeriod || hasFertile || anniversaries.length > 0;
    const isCompact   = !hasContent && !isToday && !holidayName;

    const card = document.createElement('div');
    card.className = 'diary-card' + (isToday ? ' diary-today' : '') + (isCompact ? ' diary-compact' : '');
    if (memoColor) card.style.borderLeftColor = memoColor;
    card.addEventListener('touchstart', e => { _dTY = e.touches[0].clientY; _dTScrolled = false; }, { passive: true });
    card.addEventListener('touchmove', e => { if (Math.abs(e.touches[0].clientY - _dTY) > 8) _dTScrolled = true; }, { passive: true });
    card.addEventListener('touchend', e => { if (!_dTScrolled && !_dLpFired) { e.preventDefault(); openDayModal(dateStr); } }, { passive: false });
    card.addEventListener('click', () => { if (!_suppressClick && !_dLpFired) openDayModal(dateStr); });

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'diary-header';

    const numEl = document.createElement('span');
    numEl.className = 'diary-date-num' + (isSun || holidayName ? ' diary-red' : isSat ? ' diary-blue' : '');
    numEl.textContent = day;

    const meta = document.createElement('div');
    meta.className = 'diary-meta';

    const dowEl = document.createElement('span');
    dowEl.className = 'diary-dow' + (isSun || holidayName ? ' diary-red' : isSat ? ' diary-blue' : '');
    dowEl.textContent = DAYS_KO[dow] + '요일';
    meta.appendChild(dowEl);

    if (isToday) {
      const badge = document.createElement('span');
      badge.className = 'diary-badge-today';
      badge.textContent = '오늘';
      meta.appendChild(badge);
    }
    // 칩 — 요일 오른쪽에 인라인, 줄바꿈 허용
    if (actualPeriod.has(dateStr))          meta.appendChild(_chip('🩸 생리', 'chip-health'));
    else if (predictedPeriod.has(dateStr))  meta.appendChild(_chip('🩸 생리 예정', 'chip-predicted'));
    if (ovulation.has(dateStr))             meta.appendChild(_chip('🌸 배란일', 'chip-health'));
    else if (fertile.has(dateStr))          meta.appendChild(_chip('💙 가임기', 'chip-health'));
    if (intimate.has(dateStr)) {
      const cnt = data.intimateCounts[dateStr] || 1;
      meta.appendChild(_chip((data.intimateIcon || '💟') + (cnt > 1 ? ` ×${cnt}` : ''), 'chip-activity'));
    }
    if (exercise.has(dateStr)) meta.appendChild(_chip('🏃 운동', 'chip-activity'));
    if (game.has(dateStr))     meta.appendChild(_chip('🎮 게임', 'chip-activity'));
    anniversaries.forEach(a => meta.appendChild(_chip('🎂 ' + a.label, 'chip-anniversary')));

    // 공휴일 이름 — width:100% 로 항상 단독 줄
    if (holidayName) {
      const hn = document.createElement('span');
      hn.className = 'diary-holiday-name';
      hn.textContent = holidayName;
      meta.appendChild(hn);
    }

    hdr.appendChild(numEl);
    hdr.appendChild(meta);
    card.appendChild(hdr);

    if (!isCompact) {
      // 메모
      if (memo) {
        const memoEl = document.createElement('div');
        memoEl.className = 'diary-memo';
        memoEl.textContent = memo;
        if (memoColor) {
          memoEl.style.background = memoColor;
          memoEl.style.color = getContrastColor(memoColor);
          memoEl.style.borderTop = 'none';
          memoEl.style.borderRadius = '8px';
          memoEl.style.padding = '8px 10px';
        }
        card.appendChild(memoEl);
      } else if (isToday) {
        const memoEl = document.createElement('div');
        memoEl.className = 'diary-memo diary-memo-hint';
        memoEl.textContent = '오늘의 기록을 남겨보세요...';
        card.appendChild(memoEl);
      }
    }

    container.appendChild(card);
  }

  // 스크롤: 길게 눌러 진입한 날짜 > 선택된 날짜 > 오늘
  const now = new Date();
  const mmPrefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  const scrollTarget = (forceScrollDate && forceScrollDate.startsWith(mmPrefix)) ? forceScrollDate
    : (selectedDate && selectedDate.startsWith(mmPrefix)) ? selectedDate : null;
  if (scrollTarget) {
    const day = parseInt(scrollTarget.slice(8), 10);
    const targetCard = container.children[day - 1];
    const scrollBehavior = forceScrollDate ? 'center' : 'nearest';
    if (targetCard) setTimeout(() => targetCard.scrollIntoView({ block: scrollBehavior, behavior: 'smooth' }), 60);
  } else if (year === now.getFullYear() && month === now.getMonth()) {
    const todayCard = container.querySelector('.diary-today');
    if (todayCard) setTimeout(() => todayCard.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
  }
}

// ── Day modal ──────────────────────────────────────────
function openDayModal(dateStr) {
  selectedDate = dateStr;
  if (_newMemoDates.has(dateStr)) {
    _newMemoDates.delete(dateStr);
    const cell = document.querySelector(`.calendar-cell[data-date="${dateStr}"] .memo-new-dot`);
    if (cell) cell.remove();
  }

  // Cancel any in-progress close animation so re-open works cleanly
  const _dm = document.getElementById('dayModal');
  const _dmc = _dm.querySelector('.modal-content');
  _dm.classList.remove('closing');
  _dmc.classList.remove('closing');

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

  const statusEl = document.getElementById('modalStatus');
  const chipContainer = document.getElementById('modalActivityChips');
  const _ma = document.querySelector('.modal-actions');
  if (_ma) _ma.classList.toggle('hidden', isDiaryMode);

  if (isDiaryMode) {
    // 다이어리 모드: 생리+활동 칩 한 줄, 텍스트 상태 숨김
    statusEl.textContent = '';
    statusEl.classList.add('hidden');
    const chips = [];
    if (getActualPeriodDays().has(dateStr))     chips.push({ text: '🩸 생리', cls: 'chip-health' });
    else if (getPredictedPeriodDays().has(dateStr)) chips.push({ text: '🩸 생리 예정', cls: 'chip-predicted' });
    if ((data.intimateDates || []).includes(dateStr)) {
      const cnt = (data.intimateCounts || {})[dateStr] || 1;
      chips.push({ text: (data.intimateIcon || '💟') + (cnt > 1 ? ` ×${cnt}` : ''), cls: 'chip-activity' });
    }
    if ((data.exerciseDates || []).includes(dateStr)) chips.push({ text: '🏃 운동', cls: 'chip-activity' });
    if ((data.gameDates || []).includes(dateStr))     chips.push({ text: '🎮 게임', cls: 'chip-activity' });
    if (chips.length) {
      chipContainer.innerHTML = chips.map(c => `<span class="modal-act-chip ${c.cls}">${c.text}</span>`).join('');
      chipContainer.classList.remove('hidden');
    } else {
      chipContainer.innerHTML = '';
      chipContainer.classList.add('hidden');
    }
  } else {
    statusEl.textContent = statusParts.join('  ') || '';
    statusEl.classList.remove('hidden');
    chipContainer.innerHTML = '';
    chipContainer.classList.add('hidden');
  }

  const holidayEl = document.getElementById('modalHoliday');
  const holidayName = getHolidayName(dateStr);
  if (holidayName) {
    holidayEl.textContent = holidayName;
    holidayEl.classList.remove('hidden');
  } else {
    holidayEl.classList.add('hidden');
  }

  renderDayModalAnniversaries(dateStr);

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
  if (isIntimate) {
    if (!data.intimateCounts) data.intimateCounts = {};
    const cnt = data.intimateCounts[dateStr] || 1;
    data.intimateCounts[dateStr] = cnt;
    intimateBtn.textContent = `${intimateIcon} 사랑한 날 해제 · ${cnt}번`;
    document.getElementById('intimateDecBtn').classList.remove('hidden');
    document.getElementById('intimateIncBtn').classList.remove('hidden');
  } else {
    document.getElementById('intimateDecBtn').classList.add('hidden');
    document.getElementById('intimateIncBtn').classList.add('hidden');
  }
  document.getElementById('iconPicker').classList.add('hidden');

  // Exercise button state
  const isExercise = (data.exerciseDates || []).includes(dateStr);
  const exerciseBtn = document.getElementById('toggleExercise');
  exerciseBtn.textContent = isExercise ? '🏃 운동 해제' : '🏃 운동 기록';
  exerciseBtn.classList.toggle('active', isExercise);

  // Game button state
  const isGame = (data.gameDates || []).includes(dateStr);
  const gameBtn = document.getElementById('toggleGame');
  gameBtn.textContent = isGame ? '🎮 게임 해제' : '🎮 게임 기록';
  gameBtn.classList.toggle('active', isGame);

  // Memo
  const memoInput = document.getElementById('memoInput');
  memoInput.value = data.memos[dateStr] || '';
  _memoOriginalText = memoInput.value;
  _pendingAnniversaryLabel = null;
  updateMemoAnniversaryChips();

  // 색상 피커
  const mcp = document.getElementById('memoColorPicker');
  mcp.classList.remove('hidden');
  const curColor = (data.memoColors || {})[dateStr] || '';
  mcp.querySelectorAll('.mcp-btn').forEach(btn => {
    btn.classList.toggle('mcp-active', btn.dataset.color === curColor);
  });
  memoInput.style.background = curColor || '';
  memoInput.style.borderColor = curColor || '';

  _dm.classList.remove('hidden');
}

function _closeModal(id, callback) {
  const modal = document.getElementById(id);
  const content = modal.querySelector('.modal-content');
  modal.classList.add('closing');
  content.classList.add('closing');
  setTimeout(() => {
    modal.classList.remove('closing');
    content.classList.remove('closing');
    modal.classList.add('hidden');
    if (callback) callback();
  }, 220);
}

function closeDayModal() {
  clearTimeout(memoDebounceTimer);
  // 메모를 실제로 수정한 경우에만 저장 + 서버 동기화 (그냥 열고 닫기만 한 경우는 건너뜀)
  const memoChanged = document.getElementById('memoInput').value.trim() !== _memoOriginalText;
  if (memoChanged) {
    saveMemo();
    syncSaveNow();
  }
  _closeModal('dayModal', () => {
    document.getElementById('iconPicker').classList.add('hidden');
    const mi = document.getElementById('memoInput');
    mi.style.background = '';
    mi.style.borderColor = '';
    selectedDate = null;
  });
}

function selectMemoColor(color) {
  if (!selectedDate) return;
  if (!data.memoColors) data.memoColors = {};
  if (color) {
    data.memoColors[selectedDate] = color;
  } else {
    delete data.memoColors[selectedDate];
  }
  data.memoColorTs[selectedDate] = Date.now();
  saveData();
  syncSaveNow();
  const mi = document.getElementById('memoInput');
  mi.style.background = color || '';
  mi.style.borderColor = color || '';
  document.querySelectorAll('#memoColorPicker .mcp-btn').forEach(btn => {
    btn.classList.toggle('mcp-active', btn.dataset.color === color);
  });
  renderCalendar(currentYear, currentMonth);
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
  syncSaveNow();

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
    data.cyclesTs[selectedDate] = Date.now();
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
      data.cyclesTs[old.startDate] = Date.now();
      data.cyclesTs[selectedDate] = Date.now();
      showToast('생리 시작일이 수정되었어요 🩸');
    } else {
      data.cycles.push({ startDate: selectedDate });
      data.cyclesTs[selectedDate] = Date.now();
      showToast('생리 시작일이 기록되었어요 🩸');
    }
    data.cycles.sort((a, b) => a.startDate.localeCompare(b.startDate));
  }
  saveData();
  syncSaveNow();
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
  data.cyclesTs[cycle.startDate] = Date.now();
  saveData();
  syncSaveNow();
  renderCalendar(currentYear, currentMonth);
  updateCycleInfoBar();
  updatePushServer();
  openDayModal(selectedDate);
}

function toggleIntimate() {
  if (!selectedDate) return;
  const idx = data.intimateDates.indexOf(selectedDate);
  if (idx >= 0) {
    data.intimateDates.splice(idx, 1);
    if (!data.intimateCounts) data.intimateCounts = {};
    delete data.intimateCounts[selectedDate];
    data.intimateCountTs[selectedDate] = Date.now();
    data.intimateDatesTs[selectedDate] = Date.now();
    showToast('기록이 해제되었어요');
  } else {
    data.intimateDates.push(selectedDate);
    if (!data.intimateCounts) data.intimateCounts = {};
    data.intimateCounts[selectedDate] = 1;
    data.intimateCountTs[selectedDate] = Date.now();
    data.intimateDatesTs[selectedDate] = Date.now();
    showToast(`사랑한 날이 기록되었어요 ${data.intimateIcon || '💟'}`);
  }
  saveData();
  syncSaveNow();
  renderCalendar(currentYear, currentMonth);
  openDayModal(selectedDate);
}

function changeIntimateCount(delta) {
  if (!selectedDate) return;
  if (!data.intimateCounts) data.intimateCounts = {};
  const current = data.intimateCounts[selectedDate] || 1;
  const next = Math.max(1, current + delta);
  data.intimateCounts[selectedDate] = next;
  data.intimateCountTs[selectedDate] = Date.now();
  const icon = data.intimateIcon || '💟';
  document.getElementById('toggleIntimate').textContent = `${icon} 사랑한 날 해제 · ${next}번`;
  saveData();
  syncSaveNow();
}

function toggleExercise() {
  if (!selectedDate) return;
  if (!data.exerciseDates) data.exerciseDates = [];
  const idx = data.exerciseDates.indexOf(selectedDate);
  if (idx >= 0) {
    data.exerciseDates.splice(idx, 1);
    showToast('운동 기록이 해제되었어요');
  } else {
    data.exerciseDates.push(selectedDate);
    showToast('운동이 기록되었어요 🏃');
  }
  data.exerciseDatesTs[selectedDate] = Date.now();
  saveData();
  syncSaveNow();
  renderCalendar(currentYear, currentMonth);
  openDayModal(selectedDate);
}

function toggleGame() {
  if (!selectedDate) return;
  if (!data.gameDates) data.gameDates = [];
  const idx = data.gameDates.indexOf(selectedDate);
  if (idx >= 0) {
    data.gameDates.splice(idx, 1);
    showToast('게임 기록이 해제되었어요');
  } else {
    data.gameDates.push(selectedDate);
    showToast('게임이 기록되었어요 🎮');
  }
  data.gameDatesTs[selectedDate] = Date.now();
  saveData();
  syncSaveNow();
  renderCalendar(currentYear, currentMonth);
  openDayModal(selectedDate);
}

function saveMemo() {
  if (!selectedDate) return;
  const text = document.getElementById('memoInput').value.trim();
  if (text) {
    data.memos[selectedDate] = text;
  } else {
    delete data.memos[selectedDate];
  }
  data.memoTs[selectedDate] = Date.now();
  saveData();
  renderCalendar(currentYear, currentMonth);
}

function autoSaveMemo() {
  clearTimeout(memoDebounceTimer);
  memoDebounceTimer = setTimeout(saveMemo, 600);
}

// ── 기념일(매년 반복) ───────────────────────────────────
// "OO 생일" / "OO생일" / "OO 생신" 패턴만 매칭 — 한글 음절만 허용해 HTML 특수문자가
// 끼어들 수 없으므로 아래에서 별도 escape 없이 innerHTML에 사용해도 안전함.
const ANNIVERSARY_RE = /[가-힣]{1,6}\s?(?:생일|생신)/g;

function detectAnniversaryMatches(text) {
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(ANNIVERSARY_RE)) {
    const label = m[0].trim();
    if (!seen.has(label)) { seen.add(label); out.push(label); }
  }
  return out;
}

function findAnniversaryByLabel(label) {
  return (data.anniversaries || []).find(a => a.label === label);
}

// 특정 연도에 이 기념일이 실제로 떨어지는 양력 날짜 ('YYYY-MM-DD' | null)
function getAnniversaryOccurrence(entry, year) {
  if (entry.calendarType === 'solar') {
    const maxDay = new Date(year, entry.month, 0).getDate();
    const day = Math.min(entry.day, maxDay); // 2/29 등 윤년 전용 날짜는 2/28로 폴백
    return `${year}-${String(entry.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  // 음력: 화면에 보이는 연도를 음력 연도로 삼아 환산. 늦은 달(11~12월)은 그 해에
  // 해당하는 양력 날짜가 없을 수 있어 전년도 음력으로도 시도한다.
  for (const lY of [year, year - 1]) {
    if (lY < LUNAR_BASE_YEAR || lY > 2100) continue;
    let leap = entry.leap;
    if (leap && _lunarLeapMonth(lY) !== entry.month) leap = false; // 그 해엔 윤달이 없으면 평달로 폴백
    if (entry.day > lunarMonthLength(lY, entry.month, leap)) continue;
    const solar = lunarToSolar(lY, entry.month, entry.day, leap);
    if (solar && solar.slice(0, 4) === String(year)) return solar;
  }
  return null;
}

function getAnniversaryMapForMonth(year, month) {
  const map = new Map();
  (data.anniversaries || []).forEach(entry => {
    const dateStr = getAnniversaryOccurrence(entry, year);
    if (!dateStr) return;
    if (parseInt(dateStr.slice(5, 7), 10) !== month + 1) return;
    if (!map.has(dateStr)) map.set(dateStr, []);
    map.get(dateStr).push(entry);
  });
  return map;
}

function getAnniversariesForDate(dateStr) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(5, 7), 10) - 1;
  return getAnniversaryMapForMonth(year, month).get(dateStr) || [];
}

function updateMemoAnniversaryChips() {
  const box = document.getElementById('memoAnniversaryChips');
  if (!box) return;
  const text = document.getElementById('memoInput').value;
  const labels = detectAnniversaryMatches(text);
  if (_pendingAnniversaryLabel && !labels.includes(_pendingAnniversaryLabel)) _pendingAnniversaryLabel = null;

  if (!labels.length) {
    box.innerHTML = '';
    box.classList.add('hidden');
    return;
  }

  const chipsHtml = labels.map(label => {
    const existing = findAnniversaryByLabel(label);
    if (existing) {
      return `<span class="anniv-chip anniv-chip-registered">✓ ${label} 매년 반복 등록됨<button class="anniv-chip-remove" onclick="removeAnniversary('${existing.id}')" aria-label="삭제">✕</button></span>`;
    }
    const active = label === _pendingAnniversaryLabel;
    return `<button type="button" class="anniv-chip anniv-chip-add${active ? ' active' : ''}" onclick="openAnniversaryPicker('${label}')">🎂 '${label}' 매년 반복 등록하기</button>`;
  }).join('');

  let pickerHtml = '';
  if (_pendingAnniversaryLabel) {
    const [, sm, sd] = selectedDate.split('-');
    const monthOptions = Array.from({ length: 12 }, (_, i) => i + 1)
      .map(m => `<option value="${m}" ${m === _pendingLunarMonth ? 'selected' : ''}>${m}월</option>`).join('');
    const dayOptions = Array.from({ length: 30 }, (_, i) => i + 1)
      .map(d => `<option value="${d}" ${d === _pendingLunarDay ? 'selected' : ''}>${d}일</option>`).join('');
    pickerHtml = `
      <div class="anniv-picker">
        <div class="anniv-picker-row">
          <button type="button" class="anniv-type-btn${_pendingCalType === 'solar' ? ' active' : ''}" onclick="setAnniversaryCalType('solar')">양력</button>
          <button type="button" class="anniv-type-btn${_pendingCalType === 'lunar' ? ' active' : ''}" onclick="setAnniversaryCalType('lunar')">음력</button>
        </div>
        ${_pendingCalType === 'solar'
          ? `<div class="anniv-picker-hint">매년 양력 ${parseInt(sm, 10)}월 ${parseInt(sd, 10)}일</div>`
          : `<div class="anniv-picker-row">
               <select onchange="setAnniversaryLunarField('month', this.value)">${monthOptions}</select>
               <select onchange="setAnniversaryLunarField('day', this.value)">${dayOptions}</select>
               <label class="anniv-leap-label"><input type="checkbox" ${_pendingLunarLeap ? 'checked' : ''} onchange="setAnniversaryLunarField('leap', this.checked)"> 윤달</label>
             </div>`}
        <div class="anniv-picker-actions">
          <button type="button" class="anniv-picker-cancel" onclick="closeAnniversaryPicker()">취소</button>
          <button type="button" class="anniv-picker-confirm" onclick="confirmAnniversary()">등록</button>
        </div>
      </div>`;
  }

  box.innerHTML = chipsHtml + pickerHtml;
  box.classList.remove('hidden');
}

function openAnniversaryPicker(label) {
  _pendingAnniversaryLabel = label;
  _pendingCalType = 'solar';
  const lunar = solarToLunar(selectedDate);
  _pendingLunarMonth = lunar.month;
  _pendingLunarDay = lunar.day;
  _pendingLunarLeap = lunar.isLeap;
  updateMemoAnniversaryChips();
}

function closeAnniversaryPicker() {
  _pendingAnniversaryLabel = null;
  updateMemoAnniversaryChips();
}

function setAnniversaryCalType(type) {
  _pendingCalType = type;
  updateMemoAnniversaryChips();
}

function setAnniversaryLunarField(field, value) {
  if (field === 'month') _pendingLunarMonth = parseInt(value, 10);
  if (field === 'day') _pendingLunarDay = parseInt(value, 10);
  if (field === 'leap') _pendingLunarLeap = !!value;
  updateMemoAnniversaryChips();
}

function confirmAnniversary() {
  if (!_pendingAnniversaryLabel || !selectedDate) return;
  const entry = {
    id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    label: _pendingAnniversaryLabel,
    sourceDate: selectedDate,
  };
  if (_pendingCalType === 'lunar') {
    entry.calendarType = 'lunar';
    entry.month = _pendingLunarMonth;
    entry.day = _pendingLunarDay;
    entry.leap = !!_pendingLunarLeap;
  } else {
    entry.calendarType = 'solar';
    entry.month = parseInt(selectedDate.slice(5, 7), 10);
    entry.day = parseInt(selectedDate.slice(8, 10), 10);
  }
  data.anniversaries.push(entry);
  saveData();
  syncSaveNow();
  _pendingAnniversaryLabel = null;
  updateMemoAnniversaryChips();
  renderDayModalAnniversaries(selectedDate);
  renderCalendar(currentYear, currentMonth);
  renderAnniversaryList();
  showToast('🎂 매년 반복 기념일로 등록했어요');
}

function removeAnniversary(id) {
  data.anniversaries = (data.anniversaries || []).filter(a => a.id !== id);
  saveData();
  syncSaveNow();
  updateMemoAnniversaryChips();
  if (selectedDate) renderDayModalAnniversaries(selectedDate);
  renderCalendar(currentYear, currentMonth);
  renderAnniversaryList();
}

function renderDayModalAnniversaries(dateStr) {
  const box = document.getElementById('modalAnniversaryChips');
  if (!box) return;
  const list = getAnniversariesForDate(dateStr);
  if (!list.length) {
    box.innerHTML = '';
    box.classList.add('hidden');
    return;
  }
  box.innerHTML = list.map(a =>
    `<span class="anniv-chip anniv-chip-registered">🎂 ${a.label}<button class="anniv-chip-remove" onclick="removeAnniversary('${a.id}')" aria-label="삭제">✕</button></span>`
  ).join('');
  box.classList.remove('hidden');
}

function renderAnniversaryList() {
  const container = document.getElementById('anniversaryList');
  if (!container) return;
  const list = [...(data.anniversaries || [])].sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  if (!list.length) {
    container.innerHTML = '<div class="no-data-hint">등록된 기념일이 없어요.<br>메모에 "이름 생일"처럼 적으면 등록할 수 있어요.</div>';
    return;
  }
  container.innerHTML = list.map(a => {
    const dateLabel = a.calendarType === 'lunar'
      ? `음력 ${a.month}월 ${a.day}일${a.leap ? ' (윤달)' : ''}`
      : `양력 ${a.month}월 ${a.day}일`;
    return `
      <div class="cycle-item">
        <div class="cycle-item-body">
          <div class="cycle-item-top"><span class="cycle-item-date">${a.label}</span></div>
          <div class="cycle-item-info">${dateLabel} · 매년 반복</div>
        </div>
        <button class="cycle-delete-btn" onclick="removeAnniversary('${a.id}')">✕</button>
      </div>`;
  }).join('');
}

// ── Stats modal ────────────────────────────────────────
let activityTabMode = 'monthly';
let showingActivityStats = false;

function openStats() {
  showingActivityStats = false;
  renderStatsModal();
  document.getElementById('statsModal').classList.remove('hidden');
  document.getElementById('mainStatsSection').classList.remove('hidden');
  document.getElementById('activityStatsSection').classList.add('hidden');
  document.getElementById('activityStatsBtn').textContent = '더보기';
}

function closeStats() {
  _closeModal('statsModal');
}

function toggleActivityStats() {
  showingActivityStats = !showingActivityStats;
  document.getElementById('mainStatsSection').classList.toggle('hidden', showingActivityStats);
  document.getElementById('activityStatsSection').classList.toggle('hidden', !showingActivityStats);
  document.getElementById('activityStatsBtn').textContent = showingActivityStats ? '접기' : '더보기';
  if (showingActivityStats) renderActivityStats(activityTabMode);
}

function switchActivityTab(tab) {
  activityTabMode = tab;
  document.getElementById('tabMonthly').classList.toggle('active', tab === 'monthly');
  document.getElementById('tabWeekly').classList.toggle('active', tab === 'weekly');
  renderActivityStats(tab);
}

let _acs = null; // activity chart state

function buildActivitySVGChart(chartKeys, groups, period, icon) {
  const W = 300, H = 96;
  const padL = 6, padR = 6, padT = 10, padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = chartKeys.length;

  const iVals = chartKeys.map(k => groups[k].intimateCount);
  const eVals = chartKeys.map(k => groups[k].exercise);
  const gVals = chartKeys.map(k => groups[k].game);
  const maxVal = Math.max(...iVals, ...eVals, ...gVals, 1);

  const xp = i => padL + (n < 2 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yp = v => padT + innerH - (v / maxVal) * innerH;

  _acs = { n, chartKeys, groups, period, iVals, eVals, gVals, xp, yp, padL, padT, innerW, innerH, W, H };

  function curve(vals) {
    const pts = vals.map((v, i) => [xp(i), yp(v)]);
    if (pts.length < 2) return `M ${pts[0][0]},${pts[0][1]}`;
    let d = `M ${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const cx = (pts[i-1][0] + pts[i][0]) / 2;
      d += ` C ${cx},${pts[i-1][1]} ${cx},${pts[i][1]} ${pts[i][0]},${pts[i][1]}`;
    }
    return d;
  }

  function area(vals) {
    const pts = vals.map((v, i) => [xp(i), yp(v)]);
    const bot = padT + innerH;
    if (pts.length < 2) return '';
    let d = `M ${pts[0][0]},${bot} L ${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const cx = (pts[i-1][0] + pts[i][0]) / 2;
      d += ` C ${cx},${pts[i-1][1]} ${cx},${pts[i][1]} ${pts[i][0]},${pts[i][1]}`;
    }
    d += ` L ${pts[pts.length-1][0]},${bot} Z`;
    return d;
  }

  const showIdx = new Set();
  if (n <= 5) chartKeys.forEach((_, i) => showIdx.add(i));
  else { showIdx.add(0); showIdx.add(Math.round((n-1)/2)); showIdx.add(n-1); }

  const labels = chartKeys.map((key, i) => {
    if (!showIdx.has(i)) return '';
    const lbl = period === 'monthly'
      ? `${parseInt(key.slice(5))}월`
      : `${fromDateStr(key).getMonth()+1}/${fromDateStr(key).getDate()}`;
    return `<text x="${xp(i).toFixed(1)}" y="${H-5}" text-anchor="middle" font-size="7" fill="#d0d0d0" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-weight="600">${lbl}</text>`;
  }).join('');

  const TW = 82, TH = 64, TR = 8;
  const svg = `<svg id="act-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;cursor:crosshair">
    <defs>
      <linearGradient id="gI" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#E91E8C" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="#E91E8C" stop-opacity="0.01"/>
      </linearGradient>
      <linearGradient id="gE" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#27ae60" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="#27ae60" stop-opacity="0.01"/>
      </linearGradient>
      <linearGradient id="gG" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#5c6bc0" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="#5c6bc0" stop-opacity="0.01"/>
      </linearGradient>
    </defs>
    <path d="${area(iVals)}" fill="url(#gI)"/>
    <path d="${area(eVals)}" fill="url(#gE)"/>
    <path d="${area(gVals)}" fill="url(#gG)"/>
    <path d="${curve(iVals)}" fill="none" stroke="#E91E8C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
    <path d="${curve(eVals)}" fill="none" stroke="#27ae60" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
    <path d="${curve(gVals)}" fill="none" stroke="#5c6bc0" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
    ${labels}
    <line id="act-vl" x1="0" y1="${padT}" x2="0" y2="${padT+innerH}" stroke="#ccc" stroke-width="0.8" stroke-dasharray="2,2" display="none"/>
    <circle id="act-di" r="3" fill="#E91E8C" stroke="#fff" stroke-width="1.5" display="none"/>
    <circle id="act-de" r="3" fill="#27ae60" stroke="#fff" stroke-width="1.5" display="none"/>
    <circle id="act-dg" r="3" fill="#5c6bc0" stroke="#fff" stroke-width="1.5" display="none"/>
    <g id="act-tt" display="none">
      <rect id="act-tb" width="${TW}" height="${TH}" rx="${TR}" ry="${TR}" fill="rgba(22,22,28,0.88)"/>
      <text id="act-td" font-size="8" fill="rgba(255,255,255,0.6)" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-weight="700"/>
      <text id="act-ti" font-size="8.5" fill="#F48FB1" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-weight="600"/>
      <text id="act-te" font-size="8.5" fill="#66bb6a" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-weight="600"/>
      <text id="act-tg" font-size="8.5" fill="#7986cb" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-weight="600"/>
    </g>
    <rect id="act-ol" x="${padL}" y="${padT}" width="${innerW}" height="${innerH}" fill="transparent"/>
  </svg>`;

  return `<div class="activity-chart-card">
    ${svg}
    <div class="chart-legend-row">
      <span class="chart-legend-item"><span class="chart-legend-dot dot-intimate"></span>${icon} 사랑</span>
      <span class="chart-legend-item"><span class="chart-legend-dot dot-exercise"></span>🏃 운동</span>
      <span class="chart-legend-item"><span class="chart-legend-dot dot-game"></span>🎮 게임</span>
    </div>
  </div>`;
}

function _actSvgX(clientX) {
  const svg = document.getElementById('act-chart');
  if (!svg || !_acs) return null;
  const r = svg.getBoundingClientRect();
  return (clientX - r.left) / r.width * _acs.W;
}

function _actUpdate(svgX) {
  if (!_acs) return;
  const { n, xp, yp, iVals, eVals, gVals, chartKeys, period, padL, padT, innerW, innerH, W } = _acs;
  const idx = Math.max(0, Math.min(n - 1, Math.round((svgX - padL) / innerW * (n - 1))));
  const cx = xp(idx);

  const vl = document.getElementById('act-vl');
  vl.setAttribute('x1', cx); vl.setAttribute('x2', cx);
  vl.removeAttribute('display');

  [['act-di', iVals], ['act-de', eVals], ['act-dg', gVals]].forEach(([id, vals]) => {
    const el = document.getElementById(id);
    if (vals[idx] > 0) {
      el.setAttribute('cx', cx); el.setAttribute('cy', yp(vals[idx]));
      el.removeAttribute('display');
    } else {
      el.setAttribute('display', 'none');
    }
  });

  const key = chartKeys[idx];
  let dateLabel;
  if (period === 'monthly') {
    const [y, m] = key.split('-');
    dateLabel = `${y}년 ${parseInt(m)}월`;
  } else {
    const sun = fromDateStr(key), sat = new Date(sun);
    sat.setDate(sun.getDate() + 6);
    dateLabel = `${sun.getMonth()+1}/${sun.getDate()} ~ ${sat.getMonth()+1}/${sat.getDate()}`;
  }

  const TW = 82, TH = 64, PAD = 9;
  const tx = (cx + 12 + TW > W - 4) ? cx - TW - 12 : cx + 12;
  const ty = padT + 2;

  const tt = document.getElementById('act-tt');
  tt.setAttribute('transform', `translate(${tx.toFixed(1)},${ty})`);
  tt.removeAttribute('display');

  document.getElementById('act-td').setAttribute('x', PAD);
  document.getElementById('act-td').setAttribute('y', 14);
  document.getElementById('act-td').textContent = dateLabel;

  const lines = [
    ['act-ti', `사랑  ${iVals[idx]}번`],
    ['act-te', `운동  ${eVals[idx]}일`],
    ['act-tg', `게임  ${gVals[idx]}일`],
  ];
  lines.forEach(([id, text], li) => {
    const el = document.getElementById(id);
    el.setAttribute('x', PAD); el.setAttribute('y', 28 + li * 13);
    el.textContent = text;
  });
}

function _actClear() {
  ['act-vl','act-di','act-de','act-dg','act-tt'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('display', 'none');
  });
}

function _attachActListeners() {
  const ol = document.getElementById('act-ol');
  if (!ol) return;
  ol.addEventListener('mousemove', e => _actUpdate(_actSvgX(e.clientX)));
  ol.addEventListener('mouseleave', _actClear);
  ol.addEventListener('touchstart', e => { e.preventDefault(); _actUpdate(_actSvgX(e.touches[0].clientX)); }, { passive: false });
  ol.addEventListener('touchmove',  e => { e.preventDefault(); _actUpdate(_actSvgX(e.touches[0].clientX)); }, { passive: false });
  ol.addEventListener('touchend', _actClear);
}

function renderActivityStats(period) {
  const content = document.getElementById('activityStatsContent');
  const intimateDates = data.intimateDates || [];
  const intimateCounts = data.intimateCounts || {};
  const exerciseDates = data.exerciseDates || [];
  const gameDates = data.gameDates || [];

  const allDates = new Set([...intimateDates, ...exerciseDates, ...gameDates]);
  if (allDates.size === 0) {
    content.innerHTML = '<div class="no-data-hint">활동 기록이 없어요.</div>';
    return;
  }

  const groups = {};
  allDates.forEach(dateStr => {
    let key;
    if (period === 'monthly') {
      key = dateStr.slice(0, 7);
    } else {
      const d = fromDateStr(dateStr);
      const dow = d.getDay(); // 0=일, 6=토
      const weekSun = new Date(d);
      weekSun.setDate(d.getDate() - dow); // 해당 주 일요일
      key = toDateStr(weekSun);
    }
    if (!groups[key]) groups[key] = { intimateCount: 0, exercise: 0, game: 0 };
    if (intimateDates.includes(dateStr)) groups[key].intimateCount += intimateCounts[dateStr] || 1;
    if (exerciseDates.includes(dateStr)) groups[key].exercise++;
    if (gameDates.includes(dateStr)) groups[key].game++;
  });

  const sortedKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  const icon = data.intimateIcon || '💟';

  // 차트: 오래된 순으로 최근 8개
  const chartKeys = [...sortedKeys].reverse().slice(-8);
  const chart = buildActivitySVGChart(chartKeys, groups, period, icon);

  const rows = sortedKeys.map(key => {
    const g = groups[key];
    let label;
    if (period === 'monthly') {
      const [y, m] = key.split('-');
      label = `${y}년 ${parseInt(m)}월`;
    } else {
      const sun = fromDateStr(key);
      const sat = new Date(sun);
      sat.setDate(sun.getDate() + 6);
      label = `${sun.getMonth()+1}/${sun.getDate()} ~ ${sat.getMonth()+1}/${sat.getDate()}`;
    }
    const badges = [
      g.intimateCount > 0 ? `<span class="act-badge intimate-badge">${icon} ${g.intimateCount}번</span>` : '',
      g.exercise > 0      ? `<span class="act-badge exercise-badge">🏃 ${g.exercise}일</span>` : '',
      g.game > 0          ? `<span class="act-badge game-badge">🎮 ${g.game}일</span>` : '',
    ].filter(Boolean).join('');
    return `
      <div class="activity-stat-row">
        <div class="activity-stat-period">${label}</div>
        <div class="activity-stat-counts">${badges || '<span class="no-activity">-</span>'}</div>
      </div>`;
  }).join('');

  content.innerHTML = chart + rows;
  _attachActListeners();
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
      <div class="stats-card-sub">${c.sub}</div>
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
  renderAnniversaryList();
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettings() {
  _closeModal('settingsModal');
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
  const [removed] = data.cycles.splice(idx, 1);
  if (removed) data.cyclesTs[removed.startDate] = Date.now();
  saveData();
  syncSaveNow();
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

  // 설정한 알림 시각 이전엔 발송하지 않음
  const [nh, nm] = (data.notifications.notifyTime ?? '08:00').split(':').map(Number);
  const now = new Date();
  if (now.getHours() < nh || (now.getHours() === nh && now.getMinutes() < nm)) return;

  const info = getNextPeriodInfo();
  if (!info) return;

  let title = '달력';
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
          icon: './icon_192.png',
          badge: './icon_192.png',
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
      ensureTsMaps(data);
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
  _closeModal('fertileInfoModal');
}

// ── Install Guide (first launch) ───────────────────────
function maybeShowInstallGuide() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isStandalone) return;

  // Android Chrome: 브라우저 설치 팝업 자동 표시
  if (_installPrompt) {
    _installPrompt.prompt();
    _installPrompt.userChoice.then(() => { _installPrompt = null; });
    return;
  }

  // iOS 등 나머지: 최초 1회만 가이드 표시
  if (localStorage.getItem('installGuideSeen')) return;
  document.getElementById('installGuide').classList.remove('hidden');
}

function dismissInstallGuide() {
  localStorage.setItem('installGuideSeen', '1');
  document.getElementById('installGuide').classList.add('hidden');
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
let _slideDir = 0;

function prevMonth() {
  if (currentMonth === 0) { currentYear--; currentMonth = 11; }
  else currentMonth--;
  _slideDir = 1;
  renderCalendar(currentYear, currentMonth);
}

function nextMonth() {
  if (currentMonth === 11) { currentYear++; currentMonth = 0; }
  else currentMonth++;
  _slideDir = -1;
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

// Touch swipe for month navigation + pull-to-refresh
function initSwipe() {
  let startX = 0, startY = 0, _lpTimer = null, _calLpFired = false;
  let _pulling = false, _pullY = 0;
  const PULL_THRESHOLD = 68;
  const PULL_MAX = 72;

  const cal = document.getElementById('calendarContainer');
  const pullIndicator = document.getElementById('pullIndicator');
  const pullIcon = document.getElementById('pullIndicatorIcon');
  const pullText = document.getElementById('pullIndicatorText');

  function _setPullHeight(h, animate) {
    pullIndicator.style.transition = animate ? 'height 0.25s ease' : '';
    pullIndicator.style.height = h + 'px';
  }

  function _resetPull(animate) {
    _pulling = false;
    _pullY = 0;
    _setPullHeight(0, animate);
    if (animate) setTimeout(() => { pullIndicator.style.transition = ''; }, 260);
    pullIcon.className = 'pull-icon';
    pullIcon.textContent = '↓';
    pullText.className = 'pull-text';
    pullText.textContent = '당겨서 동기화';
  }

  cal.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    _calLpFired = false;
    _pulling = false;
    _pullY = 0;
    const cell = e.target.closest('.calendar-cell');
    const lpDate = cell ? cell.dataset.date : null;
    _lpTimer = setTimeout(() => {
      _lpTimer = null;
      _calLpFired = true;
      _suppressClick = true;
      if (navigator.vibrate) navigator.vibrate(30);
      toggleDiaryMode(lpDate);
    }, 600);
  }, { passive: true });

  cal.addEventListener('touchmove', e => {
    clearTimeout(_lpTimer); _lpTimer = null;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!_calLpFired && dy > 12 && dy > Math.abs(dx) * 1.5) {
      _pulling = true;
      _pullY = Math.min(dy, PULL_MAX);
      _setPullHeight(_pullY, false);
      if (_pullY >= PULL_THRESHOLD) {
        pullIcon.className = 'pull-icon ready';
        pullIcon.textContent = '↺';
        pullText.className = 'pull-text ready';
        pullText.textContent = '놓아서 동기화';
      } else {
        pullIcon.className = 'pull-icon';
        pullIcon.textContent = '↓';
        pullText.className = 'pull-text';
        pullText.textContent = '당겨서 동기화';
      }
    }
  }, { passive: true });

  cal.addEventListener('touchend', e => {
    clearTimeout(_lpTimer); _lpTimer = null;
    if (_calLpFired) {
      _calLpFired = false;
      // touchend 기준 400ms 후 리셋 (synthetic click ~300ms 흡수)
      setTimeout(() => { _suppressClick = false; }, 400);
      return;
    }
    if (_pulling) {
      const triggered = _pullY >= PULL_THRESHOLD;
      if (triggered) {
        pullIcon.className = 'pull-icon spinning';
        pullIcon.textContent = '↺';
        pullText.className = 'pull-text ready';
        pullText.textContent = '동기화 중...';
        _pulling = false;
        _pullY = 0;
        if (!syncCode) {
          showToast('동기화 코드를 설정해주세요');
          _resetPull(true);
        } else {
          syncLoad().then(updated => {
            if (!updated) showToast('이미 최신이에요');
            _resetPull(true);
          });
        }
      } else {
        _resetPull(true);
      }
      return;
    }
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      dx < 0 ? nextMonth() : prevMonth();
    }
  }, { passive: true });

  // 다이어리 컨테이너: 길게 누르면 캘린더 모드로 복귀
  let _dLpTimer = null;
  const diary = document.getElementById('diaryContainer');
  diary.addEventListener('touchstart', () => {
    _dLpTimer = setTimeout(() => {
      _dLpTimer = null;
      _dLpFired = true;
      _suppressClick = true;
      if (navigator.vibrate) navigator.vibrate(30);
      toggleDiaryMode();
    }, 600);
  }, { passive: true });
  diary.addEventListener('touchmove', () => { clearTimeout(_dLpTimer); _dLpTimer = null; }, { passive: true });
  diary.addEventListener('touchend', () => {
    clearTimeout(_dLpTimer); _dLpTimer = null;
    if (_dLpFired) {
      // touchend 기준 400ms 후 리셋 (synthetic click ~300ms 흡수)
      setTimeout(() => { _dLpFired = false; _suppressClick = false; }, 400);
    }
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
  document.getElementById('diaryBtn').addEventListener('click', toggleDiaryMode);
  document.getElementById('statsBtn').addEventListener('click', openStats);
  document.getElementById('settingsBtn').addEventListener('click', openSettings);

  document.getElementById('closeModal').addEventListener('click', closeDayModal);
  document.getElementById('togglePeriod').addEventListener('click', togglePeriodStart);
  document.getElementById('togglePeriodEnd').addEventListener('click', togglePeriodEnd);
  document.getElementById('toggleIntimate').addEventListener('click', toggleIntimate);
  document.getElementById('editIntimateIcon').addEventListener('click', openIconPicker);
  document.getElementById('toggleExercise').addEventListener('click', toggleExercise);
  document.getElementById('toggleGame').addEventListener('click', toggleGame);
  document.getElementById('memoInput').addEventListener('input', autoSaveMemo);
  document.getElementById('memoInput').addEventListener('input', updateMemoAnniversaryChips);

  document.getElementById('closeSettings').addEventListener('click', closeSettings);
  ['cycleLength', 'periodLength', 'notifyDaysBefore', 'notifyTime'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettings);
  });
  document.querySelectorAll('input[name="fertileMethod"]').forEach(r => {
    r.addEventListener('change', saveSettings);
  });
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
  document.getElementById('activityStatsBtn').addEventListener('click', toggleActivityStats);
  document.getElementById('closeFertileInfo').addEventListener('click', closeFertileInfo);
  document.getElementById('fertileInfoModal').addEventListener('click', function(e) {
    if (e.target === this) closeFertileInfo();
  });
  document.getElementById('installGuideDismiss').addEventListener('click', dismissInstallGuide);

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

  maybeShowInstallGuide();

  // Check notifications after a short delay
  setTimeout(checkAndNotify, 1500);
  setTimeout(initPushSubscription, 2000);

  // 동기화: 앱 실행 시 로드 (이후 자동 폴링 없음 — 수동 동기화/포그라운드 복귀 시에만 체크)
  syncLoad();

  // 앱이 백그라운드로 가거나 닫히기 직전 대기 중인 저장/동기화를 강제 실행,
  // 포그라운드로 돌아오면 서버에 새 내용이 있는지 확인
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingChanges();
    else syncLoad();
  });
  window.addEventListener('pagehide', flushPendingChanges);

  // 뒤로가기 제스처 처리 (모달 닫기 / 다이어리→캘린더 전환)
  history.pushState(null, '');
  window.addEventListener('popstate', () => {
    const isOpen = id => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden') && !el.classList.contains('closing');
    };
    if (isOpen('dayModal'))         { closeDayModal();    history.pushState(null, ''); return; }
    if (isOpen('statsModal'))       { closeStats();       history.pushState(null, ''); return; }
    if (isOpen('settingsModal'))    { closeSettings();    history.pushState(null, ''); return; }
    if (isOpen('fertileInfoModal')) { closeFertileInfo(); history.pushState(null, ''); return; }
    if (isDiaryMode)                { toggleDiaryMode();  history.pushState(null, ''); return; }
    // 아무것도 없으면 자연스럽게 종료
  });
}

document.addEventListener('DOMContentLoaded', init);
