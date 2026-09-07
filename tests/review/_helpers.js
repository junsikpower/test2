/*
 * tests/review/_helpers.js — 리뷰/테스트 AI 독립 테스트 공용 하니스
 *
 * 이 파일은 `*.test.js` 가 아니므로 jest testMatch 대상이 아니다(테스트 케이스 0건).
 * 개발 AI 자체 테스트(tests/dev/)를 일절 참조하지 않고, PRD 와 src/*.js 의
 * 공개 인터페이스만으로 구성한 하니스다.
 *
 *  - makeClock     : Date.now / performance.now 를 완전히 제어하는 더블.
 *                    advance() 는 두 클록을 함께(정상 시간 경과), jumpDateOnly() 는
 *                    Date 클록만 이동(EC-04 시스템 시계 변경 재현).
 *  - makeBackend   : Web Storage 인터페이스 인메모리 더블. 쓰기 실패/접근 예외 주입.
 *  - DOM           : index.template.html <body> 의 마크업(테스트 더블 DOM, 실호출 없음).
 *  - bootApp/reload: src/app.js createApp() 을 주입식으로 부팅. 실제 네트워크/오디오/알림은
 *                    전부 테스트 더블로 대체(§CI 산출물 계약 4-나: 실호출 테스트는 설계 제외).
 */
'use strict';

const path = require('path');

const Core = require(path.join(__dirname, '..', '..', 'src', 'core.js'));
const Storage = require(path.join(__dirname, '..', '..', 'src', 'storage.js'));
const App = require(path.join(__dirname, '..', '..', 'src', 'app.js'));

const MIN = Core.MS_PER_MIN;

// index.template.html <body> 마크업에서 앱이 조회하는 id 를 그대로 옮긴 것.
const DOM = `
<main id="app">
  <h1>
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8" /></svg>
    뽀모도로 타이머 &amp; 작업 기록
  </h1>
  <div id="storage-banner" class="banner" role="alert" hidden></div>
  <nav>
    <button id="nav-timer" type="button" aria-current="page">타이머</button>
    <button id="nav-settings" type="button" aria-current="false">설정</button>
    <button id="nav-log" type="button" aria-current="false">로그</button>
  </nav>
  <section id="view-timer" class="card">
    <div id="session-type" class="session-type">집중</div>
    <div id="slot-info" class="slot-info">사이클 0 / 4</div>
    <div id="clock" class="clock">25:00</div>
    <div id="timer-controls" class="controls">
      <button id="btn-start-pause" type="button">시작</button>
      <button id="btn-reset" type="button" class="secondary">리셋</button>
      <button id="btn-skip" type="button" class="secondary">건너뛰기</button>
    </div>
    <div id="memo-box" class="memo-box" hidden>
      <label for="memo-input">이번 집중 세션에서 한 작업 (한 줄)</label>
      <input id="memo-input" type="text" maxlength="200" />
      <div class="controls">
        <button id="btn-memo-submit" type="button">메모 저장</button>
        <button id="btn-memo-skip" type="button" class="secondary">건너뛰기</button>
      </div>
    </div>
  </section>
  <section id="view-settings" class="card settings" hidden>
    <label>집중 시간(분)<input id="set-focus" type="number" min="1" max="180" step="1" value="25" /></label>
    <label>짧은 휴식(분)<input id="set-short" type="number" min="1" max="180" step="1" value="5" /></label>
    <label>긴 휴식(분)<input id="set-long" type="number" min="1" max="180" step="1" value="15" /></label>
    <button id="btn-settings-save" type="button">저장</button>
    <div id="settings-error" class="error" hidden></div>
  </section>
  <section id="view-log" class="card" hidden>
    <label>날짜 <input id="log-date" type="date" /></label>
    <p>완료한 뽀모도로: <strong id="log-count">0</strong></p>
    <ul id="log-list"></ul>
  </section>
</main>
`;

function makeClock(startMs) {
  let d = startMs;
  let p = startMs;
  return {
    now: () => d,
    perfNow: () => p,
    advance(ms) { d += ms; p += ms; },     // 정상 시간 경과 (두 클록 함께)
    jumpDateOnly(ms) { d += ms; }           // 시스템 시계만 변경 (EC-04)
  };
}

function makeBackend() {
  const map = {};
  return {
    map,
    failWrites: false,
    throwOnRead: false,
    setItem(k, v) {
      if (this.failWrites) throw new DOMException('quota exceeded', 'QuotaExceededError');
      map[k] = String(v);
    },
    getItem(k) {
      if (this.throwOnRead) throw new DOMException('access denied', 'SecurityError');
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
    },
    removeItem(k) { delete map[k]; }
  };
}

const LIVE = [];

function _makeBeeper(opts) {
  if (opts.beeper) return opts.beeper;
  const audioOk = opts.audioOk !== false;
  return { unlock: jest.fn(), play: jest.fn(() => Promise.resolve(audioOk)) };
}

function _installNotification(mode) {
  if (mode === null) { delete global.window.Notification; return undefined; }
  const ctor = jest.fn();
  ctor.permission = mode || 'granted';
  ctor.requestPermission = jest.fn(() => Promise.resolve(ctor.permission));
  global.window.Notification = ctor;
  return ctor;
}

/** 새 앱 인스턴스를 부팅한다. document.body 를 DOM 으로 초기화한다. */
function bootApp(opts = {}) {
  const doc = global.document;
  const win = global.window;
  doc.body.innerHTML = DOM;
  const start = opts.start != null ? opts.start : new Date(2026, 8, 7, 9, 0, 0).getTime();
  const clock = makeClock(start);
  const backend = opts.backend || makeBackend();
  const store = Storage.createStore({ backend });
  const beeper = _makeBeeper(opts);
  const notification = _installNotification(opts.notification === undefined ? 'granted' : opts.notification);
  const app = App.createApp({
    document: doc,
    window: win,
    now: () => clock.now(),
    perfNow: () => clock.perfNow(),
    storage: store,
    beeper,
    tickMs: opts.tickMs || 10 * 60 * 1000   // 크게 잡아 자동 tick 이 테스트 중 발화하지 않게 함
  });
  LIVE.push(app);
  const ctrl = app.start();
  return { app, ctrl, clock, backend, store, beeper, notification, start };
}

/**
 * 같은 backend 로 앱을 다시 부팅한다(= 새로고침 / 브라우저 재시작).
 * 새로고침은 DOM 도 HTML 로부터 새로 그려지므로 body 를 초기화한다
 * (이전 앱 인스턴스가 붙여 둔 이벤트 리스너 제거). 영속 상태는 backend 에만 있다.
 */
function reload(opts = {}) {
  const doc = global.document;
  const win = global.window;
  doc.body.innerHTML = DOM;
  const clock = makeClock(opts.start != null ? opts.start : Date.now());
  const store = Storage.createStore({ backend: opts.backend });
  _installNotification(opts.notification === undefined ? 'granted' : opts.notification);
  const app = App.createApp({
    document: doc,
    window: win,
    now: () => clock.now(),
    perfNow: () => clock.perfNow(),
    storage: store,
    beeper: _makeBeeper(opts),
    tickMs: opts.tickMs || 10 * 60 * 1000
  });
  LIVE.push(app);
  const ctrl = app.start();
  return { app, ctrl, clock, store };
}

function teardown() {
  while (LIVE.length) {
    try { LIVE.pop().stop(); } catch (e) { /* noop */ }
  }
  try { delete global.window.Notification; } catch (e) { /* noop */ }
  try { global.document.title = ''; } catch (e) { /* noop */ }
  try {
    Object.defineProperty(global.document, 'visibilityState', { value: 'visible', configurable: true });
  } catch (e) { /* noop */ }
  if (global.jest && typeof jest.restoreAllMocks === 'function') jest.restoreAllMocks();
}

function $(id) { return global.document.getElementById(id); }
function click(id) { $(id).click(); }
function clockText() { return $('clock').textContent; }

module.exports = {
  Core, Storage, App, MIN, DOM,
  makeClock, makeBackend, bootApp, reload, teardown,
  $, click, clockText
};
