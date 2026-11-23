// ── 슬리더링크 (퍼즐) ─────────────────────────────────────
// 동기화 코드를 공유하는 사람끼리 각자 플레이하고 서로의 기록·진행 상황을 볼 수 있다.
// 진행 상황은 플레이어별 서버 키(/game/save)에 저장되어 달력 데이터와 섞이지 않는다.
// app.js의 PUSH_SERVER_URL, syncCode, showToast를 사용한다.
(function () {
  'use strict';

  const SL_KEY = 'slither_v1';
  const SIZES = [6, 7, 8, 9, 10, 11];
  const LEVEL_NAMES = { 6: '입문', 7: '쉬움', 8: '보통', 9: '어려움', 10: '고수', 11: '달인' };
  const SAVE_MIN_INTERVAL = 30000; // 서버 저장 최소 간격 (KV 쓰기 한도 절약)
  const POLL_INTERVAL = 30000;
  const PEEK_POLL_INTERVAL = 15000;

  const puzzles = () => window.SLITHER_PUZZLES || {};
  const stageCount = n => (puzzles()[n] || []).length;
  const keyOf = (n, stage) => `${n}-${stage}`; // stage: 1부터

  // ── 상태 ──────────────────────────────────────────────
  let sl = loadLocal();
  let others = [];
  let othersLoaded = false;
  let root = null;
  let view = 'home';
  let curSize = 6;
  let curStage = 1;
  let board = null;      // 플레이 중인 판
  let peek = null;       // { playerId, n, stage }
  let pollTimer = null;
  let saveTimer = null;
  let lastSaveAt = 0;
  let dirty = false;
  let resetArmedAt = 0;

  function loadLocal() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SL_KEY)); } catch (e) { /* 손상 시 새로 */ }
    if (!s || typeof s !== 'object') s = {};
    if (!s.playerId) {
      const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
      s.playerId = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }
    s.nickname = s.nickname || '';
    s.clears = s.clears || {};
    s.progress = s.progress || {};
    s.updatedAt = s.updatedAt || 0;
    return s;
  }
  function saveLocal() {
    sl.updatedAt = Date.now();
    try { localStorage.setItem(SL_KEY, JSON.stringify(sl)); } catch (e) { /* 저장 공간 부족 */ }
  }

  function syncOn() {
    return typeof PUSH_SERVER_URL !== 'undefined' && PUSH_SERVER_URL &&
      typeof syncCode !== 'undefined' && !!syncCode;
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function shortDate(s) {
    if (!s) return '';
    const [, m, d] = s.split('-');
    return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
  }
  function relTime(ts) {
    if (!ts) return '';
    const diff = Math.max(0, Date.now() - ts);
    if (diff < 60000) return '방금';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}시간 전`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function toast(msg) { if (typeof showToast === 'function') showToast(msg); }

  // ── 서버 동기화 ───────────────────────────────────────
  function serverRecord() {
    // 클리어한 판의 재도전 진행은 공유하지 않음
    const progress = {};
    for (const [k, p] of Object.entries(sl.progress)) {
      const [n, st] = k.split('-');
      if (!(sl.clears[n] && sl.clears[n][st])) progress[k] = p;
    }
    return { nickname: sl.nickname, clears: sl.clears, progress, updatedAt: sl.updatedAt };
  }

  function scheduleSave() {
    dirty = true;
    if (!syncOn() || saveTimer) return;
    const wait = Math.max(5000, SAVE_MIN_INTERVAL - (Date.now() - lastSaveAt));
    saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, wait);
  }

  async function flushSave(keepalive) {
    if (!syncOn() || !dirty) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    dirty = false;
    lastSaveAt = Date.now();
    const body = JSON.stringify({ code: syncCode, playerId: sl.playerId, record: serverRecord() });
    try {
      if (keepalive && navigator.sendBeacon) {
        navigator.sendBeacon(`${PUSH_SERVER_URL}/game/save`, new Blob([body], { type: 'application/json' }));
        return;
      }
      const r = await fetch(`${PUSH_SERVER_URL}/game/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: !!keepalive,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.warn('slither save failed:', e);
      dirty = true;
    }
  }

  async function loadOthers() {
    if (!syncOn()) { others = []; othersLoaded = true; return; }
    try {
      const r = await fetch(`${PUSH_SERVER_URL}/game/load?code=${syncCode}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      others = (json.players || []).filter(p => p && p.playerId !== sl.playerId);
      othersLoaded = true;
    } catch (e) {
      console.warn('slither load failed:', e);
    }
  }

  function startPolling() {
    stopPolling();
    const tick = async () => {
      if (!root || root.classList.contains('hidden') || document.hidden) return;
      await loadOthers();
      if (view === 'home' || view === 'stages') render();
      else if (view === 'play') renderPlayOthers();
      else if (view === 'peek') render();
    };
    pollTimer = setInterval(tick, view === 'peek' ? PEEK_POLL_INTERVAL : POLL_INTERVAL);
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

  // ── 판 데이터 ─────────────────────────────────────────
  function layout(n) {
    const H = (n + 1) * n;
    return {
      n, H, E: H + n * (n + 1),
      h: (r, c) => r * n + c,
      v: (r, c) => H + r * (n + 1) + c,
    };
  }
  const U = 100; // SVG 좌표: 한 칸 = 100

  function cellEdges(L, r, c) { return [L.h(r, c), L.h(r + 1, c), L.v(r, c), L.v(r, c + 1)]; }

  function makeBoard(n, stage, edgeStr) {
    const p = puzzles()[n][stage - 1];
    const L = layout(n);
    const edges = new Uint8Array(L.E);
    if (edgeStr && edgeStr.length === L.E) for (let i = 0; i < L.E; i++) edges[i] = +edgeStr[i] || 0;
    return { n, stage, L, clues: p.c, sol: p.s, edges, history: [] };
  }
  const edgesToStr = edges => Array.from(edges).join('');

  function isSolved(b) {
    for (let i = 0; i < b.L.E; i++) if ((b.edges[i] === 1) !== (b.sol[i] === '1')) return false;
    return true;
  }

  // ── 화면 뼈대 ─────────────────────────────────────────
  function ensureRoot() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'slitherScreen';
    root.className = 'sl-screen hidden';
    root.innerHTML = '<div class="sl-inner"></div>';
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
  }

  function open() {
    ensureRoot();
    sl = loadLocal();
    root.classList.remove('hidden');
    view = 'home';
    render();
    if (!sl.nickname) showNicknameDialog(true);
    loadOthers().then(() => { if (view === 'home' || view === 'stages') render(); });
    startPolling();
  }

  function close() {
    leavePlay();
    flushSave(true);
    stopPolling();
    root.classList.add('hidden');
  }

  function go(next) {
    if (view === 'play' && next !== 'play') leavePlay();
    view = next;
    render();
    startPolling();
    const sc = root.querySelector('.sl-body');
    if (sc) sc.scrollTop = 0;
  }

  function render() {
    const inner = root.querySelector('.sl-inner');
    if (view === 'home') inner.innerHTML = homeHtml();
    else if (view === 'stages') inner.innerHTML = stagesHtml();
    else if (view === 'play') { inner.innerHTML = playHtml(); mountBoard(); }
    else if (view === 'peek') { inner.innerHTML = peekHtml(); mountPeekBoard(); }
  }

  function header(title, sub, backAction, rightHtml) {
    return `<header class="sl-header">
      <button class="sl-icon-btn" data-act="${backAction}" aria-label="뒤로">‹</button>
      <div class="sl-title"><div>${title}</div>${sub ? `<div class="sl-sub">${sub}</div>` : ''}</div>
      <div class="sl-header-right">${rightHtml || ''}</div>
    </header>`;
  }

  function allPlayers() {
    return [{ ...serverRecord(), playerId: sl.playerId, me: true }, ...others];
  }
  const STALE_MS = 7 * 86400000; // 7일 넘게 손대지 않은 진행은 표시하지 않음
  function activeProgress(p, k) {
    const prog = (p.progress || {})[k];
    if (!prog) return null;
    if (!p.me && prog.t && Date.now() - prog.t > STALE_MS) return null;
    return prog;
  }
  function activeProgressCount(p) {
    return Object.keys(p.progress || {}).filter(k => activeProgress(p, k)).length;
  }

  function clearCount(p, n) { return Object.keys((p.clears || {})[n] || {}).length; }
  function displayName(p) { return p.nickname || (p.me ? '나' : '이름 없음'); }

  // ── 메인 (난이도 선택) ─────────────────────────────────
  function homeHtml() {
    const players = allPlayers();
    let syncNote;
    if (!syncOn()) {
      syncNote = '<div class="sl-note">설정 → 기기 동기화로 연결하면 같은 코드를 쓰는 사람의 기록과 진행 상황이 함께 보여요.</div>';
    } else if (!othersLoaded) {
      syncNote = '<div class="sl-note">함께하는 사람 불러오는 중…</div>';
    } else if (others.length === 0) {
      syncNote = '<div class="sl-note">아직 함께 플레이한 사람이 없어요. 상대도 퍼즐을 시작하면 여기에 표시돼요.</div>';
    } else {
      syncNote = '<div class="sl-players">' + others.map(p => {
        const playing = activeProgressCount(p);
        return `<span class="sl-player-pill">${esc(displayName(p))}${playing ? ' <em>진행중</em>' : ''}</span>`;
      }).join('') + '</div>';
    }
    const cards = SIZES.filter(n => stageCount(n)).map(n => {
      const total = stageCount(n);
      const rows = players.map(p => {
        const cnt = clearCount(p, n);
        return `<div class="sl-card-row${p.me ? ' me' : ''}">
          <span class="sl-card-name">${esc(displayName(p))}</span>
          <span class="sl-bar"><span style="width:${Math.round(100 * cnt / total)}%"></span></span>
          <span class="sl-card-cnt">${cnt}/${total}</span>
        </div>`;
      }).join('');
      return `<button class="sl-size-card" data-act="size" data-n="${n}">
        <div class="sl-size-top"><span class="sl-size">${n}×${n}</span><span class="sl-level">${LEVEL_NAMES[n]}</span></div>
        ${rows}
      </button>`;
    }).join('');
    return header('슬리더링크', '', 'close',
      `<button class="sl-nick-btn" data-act="nick">${esc(sl.nickname || '닉네임')} ✏️</button>`) +
      `<div class="sl-body">
        ${syncNote}
        <div class="sl-size-grid">${cards}</div>
        <div class="sl-help">점과 점을 이어 하나의 고리를 만드세요. 숫자는 그 칸을 둘러싼 선의 개수예요.</div>
      </div>`;
  }

  // ── 스테이지 목록 ─────────────────────────────────────
  function playerChips(n, stage, excludeMe) {
    const k = keyOf(n, stage);
    return allPlayers().filter(p => !(excludeMe && p.me)).map(p => {
      const date = ((p.clears || {})[n] || {})[stage];
      if (date) {
        return `<span class="sl-chip done${p.me ? ' me' : ''}">✓ ${esc(displayName(p))} · ${shortDate(date)}</span>`;
      }
      const prog = activeProgress(p, k);
      if (prog) {
        if (p.me) return `<span class="sl-chip playing me">${esc(displayName(p))} 진행중</span>`;
        const when = prog.t ? ` · ${relTime(prog.t)}` : '';
        return `<button class="sl-chip playing peekable" data-act="peek" data-pid="${esc(p.playerId)}" data-n="${n}" data-stage="${stage}">
          ${esc(displayName(p))} 진행중${when} <span class="sl-chip-eye">보기 ›</span></button>`;
      }
      return '';
    }).join('');
  }

  function stagesHtml() {
    const n = curSize;
    const total = stageCount(n);
    const rows = [];
    for (let s = 1; s <= total; s++) {
      const mine = (sl.clears[n] || {})[s];
      rows.push(`<div class="sl-stage-row" data-act="play" data-stage="${s}" role="button">
        <span class="sl-stage-num${mine ? ' cleared' : ''}">${mine ? '✓' : s}</span>
        <div class="sl-stage-main">
          <div class="sl-stage-name">${s}단계</div>
          <div class="sl-chips">${playerChips(n, s) || '<span class="sl-empty">아직 기록 없음</span>'}</div>
        </div>
        <span class="sl-chev">›</span>
      </div>`);
    }
    return header(`${n}×${n} · ${LEVEL_NAMES[n]}`, `${clearCount({ clears: sl.clears }, n)}/${total} 클리어`, 'home') +
      `<div class="sl-body"><div class="sl-stage-list">${rows.join('')}</div></div>`;
  }

  // ── 플레이 ────────────────────────────────────────────
  function startPlay(n, stage) {
    curSize = n;
    curStage = stage;
    const saved = sl.progress[keyOf(n, stage)];
    board = makeBoard(n, stage, saved && saved.e);
    go('play');
  }

  function leavePlay() {
    if (view !== 'play' || !board) return;
    persistBoard();
    flushSave();
  }

  function persistBoard() {
    if (!board) return;
    const k = keyOf(board.n, board.stage);
    const any = board.edges.some(x => x !== 0);
    if (any) sl.progress[k] = { e: edgesToStr(board.edges), t: Date.now() };
    else delete sl.progress[k];
    saveLocal();
  }

  function playHtml() {
    const n = board.n, s = board.stage;
    const cleared = (sl.clears[n] || {})[s];
    return header(`${n}×${n} · ${s}단계`, cleared ? `${shortDate(cleared)} 클리어함` : LEVEL_NAMES[n], 'stages',
      `<button class="sl-icon-btn" data-act="undo" aria-label="되돌리기">↶</button>`) +
      `<div class="sl-body sl-play-body">
        <div class="sl-others" id="slPlayOthers"></div>
        <div class="sl-board-area"><div class="sl-board-wrap"><svg id="slBoard" class="sl-board"></svg></div></div>
        <div class="sl-tools">
          <button class="sl-tool" data-act="undo">↶ 되돌리기</button>
          <button class="sl-tool" data-act="reset">⟲ 처음부터</button>
        </div>
        <div class="sl-help">탭: 선 → ✕ → 지우기 · 끌어서 이어 그리기</div>
      </div>
      <div class="sl-win hidden" id="slWin"></div>`;
  }

  function renderPlayOthers() {
    const el = root.querySelector('#slPlayOthers');
    if (!el || !board) return;
    const chips = playerChips(board.n, board.stage, true);
    el.innerHTML = chips.trim() ? `<div class="sl-chips">${chips}</div>` : '';
  }

  function mountBoard() {
    const svg = root.querySelector('#slBoard');
    drawBoard(svg, board, false);
    renderPlayOthers();
    attachInput(svg);
  }

  function drawBoard(svg, b, readonly) {
    const n = b.n, L = b.L;
    const pad = 0.3 * U;
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${n * U + 2 * pad} ${n * U + 2 * pad}`);
    const parts = [];
    // 숫자
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const ch = b.clues[r * n + c];
        if (ch === '.') continue;
        const want = +ch;
        let on = 0, x = 0;
        for (const e of cellEdges(L, r, c)) { if (b.edges[e] === 1) on++; else if (b.edges[e] === 2) x++; }
        // 초과하거나 남은 변으로 채울 수 없으면 오류, 네 변이 모두 정해지고 개수가 맞으면 완료(회색)
        const cls = on > want || (4 - x) < want ? 'err' : (on === want && on + x === 4 ? 'ok' : '');
        parts.push(`<text x="${(c + 0.5) * U}" y="${(r + 0.53) * U}" class="sl-clue ${cls}">${ch}</text>`);
      }
    }
    // 선 / ✕
    const seg = (e) => {
      if (e < L.H) { const r = Math.floor(e / n), c = e % n; return [c, r, c + 1, r]; }
      const k = e - L.H, r = Math.floor(k / (n + 1)), c = k % (n + 1);
      return [c, r, c, r + 1];
    };
    for (let e = 0; e < L.E; e++) {
      const st = b.edges[e];
      if (!st) continue;
      const [x1, y1, x2, y2] = seg(e).map(v => v * U);
      if (st === 1) {
        parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="sl-line"/>`);
      } else {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = 0.1 * U;
        parts.push(`<path d="M${mx - d} ${my - d}L${mx + d} ${my + d}M${mx + d} ${my - d}L${mx - d} ${my + d}" class="sl-x"/>`);
      }
    }
    // 점
    for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) {
      parts.push(`<circle cx="${c * U}" cy="${r * U}" r="${0.075 * U}" class="sl-dot"/>`);
    }
    svg.innerHTML = parts.join('');
    svg.classList.toggle('readonly', !!readonly);
  }

  function hitEdge(svg, b, clientX, clientY, maxDist, vertexGap) {
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return -1;
    const q = pt.matrixTransform(ctm.inverse());
    const p = { x: q.x / U, y: q.y / U };
    const n = b.n, L = b.L;
    let best = -1, bestD = maxDist;
    // 가로선
    const hr = Math.round(p.y), hc = Math.floor(p.x);
    // 꼭짓점 근처는 가로/세로가 모호하므로 제외 (끌기로 모서리를 돌 때 옆 선이 그려지는 것 방지)
    const nearV = t => Math.abs(t - Math.round(t)) < vertexGap;
    if (hr >= 0 && hr <= n && hc >= 0 && hc < n && !nearV(p.x)) {
      const d = Math.abs(p.y - hr);
      if (d < bestD) { bestD = d; best = L.h(hr, hc); }
    }
    // 세로선
    const vc = Math.round(p.x), vr = Math.floor(p.y);
    if (vc >= 0 && vc <= n && vr >= 0 && vr < n && !nearV(p.y)) {
      const d = Math.abs(p.x - vc);
      if (d < bestD) { bestD = d; best = L.v(vr, vc); }
    }
    return best;
  }

  function attachInput(svg) {
    let paint = null, last = -1, active = false, changed = false;
    svg.addEventListener('pointerdown', ev => {
      if (!board || board.won) return;
      const e = hitEdge(svg, board, ev.clientX, ev.clientY, 0.45, 0.1);
      if (e < 0) return;
      ev.preventDefault();
      svg.setPointerCapture(ev.pointerId);
      active = true;
      board.history.push(edgesToStr(board.edges));
      if (board.history.length > 300) board.history.shift();
      paint = (board.edges[e] + 1) % 3;
      board.edges[e] = paint;
      last = e;
      changed = true;
      drawBoard(svg, board, false);
    });
    svg.addEventListener('pointermove', ev => {
      if (!active) return;
      const e = hitEdge(svg, board, ev.clientX, ev.clientY, 0.3, 0.25);
      if (e < 0 || e === last) return;
      last = e;
      if (board.edges[e] !== paint) {
        board.edges[e] = paint;
        changed = true;
        drawBoard(svg, board, false);
      }
    });
    const end = () => {
      if (!active) return;
      active = false;
      if (changed) afterEdit();
      changed = false;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  function afterEdit() {
    if (isSolved(board)) return onWin();
    persistBoard();
    scheduleSave();
  }

  function onWin() {
    board.won = true;
    const n = board.n, s = board.stage;
    sl.clears[n] = sl.clears[n] || {};
    const first = !sl.clears[n][s];
    if (first) sl.clears[n][s] = todayStr();
    delete sl.progress[keyOf(n, s)];
    saveLocal();
    dirty = true;
    flushSave();
    const hasNext = s < stageCount(n);
    const win = root.querySelector('#slWin');
    win.innerHTML = `<div class="sl-win-card">
      <div class="sl-win-emoji">🎉</div>
      <div class="sl-win-title">${n}×${n} ${s}단계 클리어!</div>
      <div class="sl-win-sub">${first ? `${shortDate(todayStr())} 기록됨` : `처음 클리어: ${shortDate(sl.clears[n][s])}`}</div>
      <div class="sl-win-btns">
        <button class="sl-btn ghost" data-act="stages">목록</button>
        ${hasNext ? `<button class="sl-btn" data-act="next">다음 단계 ›</button>` : ''}
      </div>
    </div>`;
    win.classList.remove('hidden');
    root.querySelector('#slBoard').classList.add('won');
  }

  function undo() {
    if (!board || board.won || !board.history.length) return;
    const prev = board.history.pop();
    for (let i = 0; i < prev.length; i++) board.edges[i] = +prev[i];
    drawBoard(root.querySelector('#slBoard'), board, false);
    persistBoard();
    scheduleSave();
  }

  function reset() {
    if (!board || board.won) return;
    if (Date.now() - resetArmedAt > 2500) {
      resetArmedAt = Date.now();
      toast('한 번 더 누르면 처음부터 시작해요');
      return;
    }
    resetArmedAt = 0;
    board.history.push(edgesToStr(board.edges));
    board.edges.fill(0);
    drawBoard(root.querySelector('#slBoard'), board, false);
    persistBoard();
    scheduleSave();
  }

  // ── 상대 진행 보기 ────────────────────────────────────
  function peekPlayer() { return others.find(p => p.playerId === peek.playerId); }

  function peekHtml() {
    const p = peekPlayer();
    const n = peek.n, s = peek.stage;
    const name = p ? displayName(p) : '상대';
    const date = p && ((p.clears || {})[n] || {})[s];
    const prog = p && (p.progress || {})[keyOf(n, s)];
    let sub;
    if (date) sub = `${shortDate(date)} 클리어`;
    else if (prog) sub = `마지막 진행 ${relTime(prog.t)}`;
    else sub = '진행 기록 없음';
    return header(`${esc(name)}의 진행 상황`, `${n}×${n} · ${s}단계 · ${sub}`, 'peekback',
      `<button class="sl-icon-btn" data-act="peekrefresh" aria-label="새로고침">⟳</button>`) +
      `<div class="sl-body sl-play-body">
        <div class="sl-board-area"><div class="sl-board-wrap"><svg id="slPeekBoard" class="sl-board"></svg></div></div>
        <div class="sl-help">보기 전용이에요 · 자동으로 새로고침돼요</div>
        <div class="sl-tools"><button class="sl-btn" data-act="playpeeked">나도 이 단계 풀기 ›</button></div>
      </div>`;
  }

  function mountPeekBoard() {
    const p = peekPlayer();
    const prog = p && (p.progress || {})[keyOf(peek.n, peek.stage)];
    const date = p && ((p.clears || {})[peek.n] || {})[peek.stage];
    const svg = root.querySelector('#slPeekBoard');
    const iCleared = (sl.clears[peek.n] || {})[peek.stage];
    if (date && !iCleared) {
      // 상대가 이미 풀었으면 정답이 드러나므로, 내가 아직 못 풀었을 땐 판을 가림
      svg.outerHTML = '<div class="sl-peek-hidden">🏁 이미 클리어했어요<br><span>내가 이 단계를 풀면 상대의 완성 판도 볼 수 있어요</span></div>';
      return;
    }
    const b = makeBoard(peek.n, peek.stage, prog && prog.e);
    if (date && !prog) for (let i = 0; i < b.L.E; i++) b.edges[i] = b.sol[i] === '1' ? 1 : 0;
    drawBoard(svg, b, true);
  }

  // ── 닉네임 ────────────────────────────────────────────
  function showNicknameDialog(first) {
    const dlg = document.createElement('div');
    dlg.className = 'sl-dialog-backdrop';
    dlg.innerHTML = `<div class="sl-dialog">
      <div class="sl-dialog-title">${first ? '닉네임을 정해 주세요' : '닉네임 변경'}</div>
      <div class="sl-dialog-sub">클리어 기록 옆에 표시돼요</div>
      <input class="sl-input" maxlength="10" placeholder="예: 시아" value="${esc(sl.nickname)}">
      <div class="sl-win-btns">
        ${first ? '' : '<button class="sl-btn ghost" data-dlg="cancel">취소</button>'}
        <button class="sl-btn" data-dlg="ok">확인</button>
      </div>
    </div>`;
    root.appendChild(dlg);
    const input = dlg.querySelector('input');
    setTimeout(() => input.focus(), 50);
    const done = ok => {
      if (ok) {
        const v = input.value.trim().slice(0, 10);
        if (!v) { toast('닉네임을 입력해 주세요'); return; }
        sl.nickname = v;
        saveLocal();
        dirty = true;
        flushSave();
      }
      dlg.remove();
      render();
    };
    dlg.addEventListener('click', ev => {
      const a = ev.target.closest('[data-dlg]');
      if (a) { ev.stopPropagation(); done(a.dataset.dlg === 'ok'); }
    });
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') done(true); });
  }

  // ── 클릭 라우팅 ───────────────────────────────────────
  function onClick(ev) {
    const el = ev.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const act = el.dataset.act;
    ev.stopPropagation();
    switch (act) {
      case 'close': close(); break;
      case 'home': go('home'); break;
      case 'stages': go('stages'); break;
      case 'nick': showNicknameDialog(false); break;
      case 'size': curSize = +el.dataset.n; go('stages'); break;
      case 'play': startPlay(curSize, +el.dataset.stage); break;
      case 'next': startPlay(board.n, board.stage + 1); break;
      case 'undo': undo(); break;
      case 'reset': reset(); break;
      case 'peek':
        peek = { playerId: el.dataset.pid, n: +el.dataset.n, stage: +el.dataset.stage, from: view };
        if (view === 'play') leavePlay();
        go('peek');
        break;
      case 'peekback':
        if (peek && peek.from === 'play') startPlay(peek.n, peek.stage);
        else go('stages');
        break;
      case 'peekrefresh':
        loadOthers().then(() => { if (view === 'peek') { render(); toast('새로고침했어요'); } });
        break;
      case 'playpeeked': startPlay(peek.n, peek.stage); break;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!root || root.classList.contains('hidden')) return;
    if (document.hidden) {
      if (view === 'play') persistBoard();
      flushSave(true);
    } else {
      loadOthers().then(() => { if (view !== 'play') render(); else renderPlayOthers(); });
    }
  });

  // 기기 뒤로가기: 처리했으면 true (app.js의 popstate 핸들러에서 호출)
  function back() {
    if (!root || root.classList.contains('hidden')) return false;
    const dlg = root.querySelector('.sl-dialog-backdrop');
    if (dlg) { dlg.remove(); if (!sl.nickname) close(); else render(); return true; }
    const win = root.querySelector('#slWin');
    if (view === 'play' && win && !win.classList.contains('hidden')) { go('stages'); return true; }
    if (view === 'home') close();
    else if (view === 'stages') go('home');
    else if (view === 'play') go('stages');
    else if (view === 'peek') {
      if (peek && peek.from === 'play') startPlay(peek.n, peek.stage);
      else go('stages');
    }
    return true;
  }

  window.openSlither = open;
  window.slitherBack = back;
})();
