'use strict';

/*
 * 자체 테스트 공용 하네스.
 *
 * pomodoro.html 을 읽어 jsdom 문서에 마크업을 심고, 인라인 스크립트를 실행해
 * window.Pomodoro 를 얻는다. 시간(now/perf)·저장소·오디오·알림은 주입 가능한
 * 테스트 더블로 대체한다. (앱은 12.3 Implementation Freedom 에 따라 이 주입
 * 시임을 제공한다.)
 *
 * 실제 시스템 시계를 건드리지 않고, "정상적인 시간 경과"(advance)와
 * "시스템 시계 변경"(jumpWall)을 분리해 시뮬레이션할 수 있게 한다.
 */

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.resolve(__dirname, '..', '..', '..', 'pomodoro.html');

function extractDoc() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const head = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [, ''])[1];
  const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, html])[1];
  const scripts = [];
  const strip = (s) =>
    s.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, code) => {
      scripts.push(code);
      return '';
    });
  return { head: strip(head), body: strip(body), script: scripts.join('\n;\n') };
}

const DOC = extractDoc();

function makeClock(startWall) {
  let wall = startWall == null ? Date.UTC(2026, 8, 7, 9, 0, 0) : startWall;
  let perf = 5000;
  return {
    now: () => wall,
    perf: () => perf,
    /** 정상적인 시간 경과: 두 시계가 함께 흐른다. */
    advance(ms) { wall += ms; perf += ms; },
    /** 시스템 시계만 변경(단조 시계 perf 는 그대로) — EC-04 재현용. */
    jumpWall(ms) { wall += ms; },
    setWall(v) { wall = v; },
    get wall() { return wall; },
    get perfNow() { return perf; },
  };
}

/** setItem 이 항상 실패하는 저장소 더블 (EC-05). */
function makeFailingStorage() {
  return {
    _m: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
    setItem() { throw new Error('QuotaExceededError (simulated)'); },
    removeItem(k) { delete this._m[k]; },
    clear() { this._m = {}; },
  };
}

/** 처음 몇 번은 실패하고 이후 성공하는 저장소 더블 (EC-05 자동복구). */
function makeFlakyStorage() {
  const s = {
    _m: {},
    failWrites: true,
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
    setItem(k, v) {
      if (s.failWrites) throw new Error('write failed (simulated)');
      s._m[k] = String(v);
    },
    removeItem(k) { delete s._m[k]; },
    clear() { s._m = {}; },
  };
  return s;
}

/** 내용을 실제로 보관하는 메모리 저장소 더블 (복원 시나리오). */
function makeMemoryStorage(seed) {
  const m = Object.assign({}, seed || {});
  return {
    _m: m,
    getItem(k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem(k, v) { m[k] = String(v); },
    removeItem(k) { delete m[k]; },
    clear() { for (const k of Object.keys(m)) delete m[k]; },
  };
}

/**
 * 앱을 새로 부팅한다.
 * @param {object} opts
 *   clock         : makeClock() 인스턴스 (없으면 생성)
 *   startWall     : clock 미지정 시 시작 wall time
 *   storage       : 저장소 더블 (기본: 새 메모리 저장소)
 *   audio         : { unlock?, beep } 더블 또는 null
 *   notification  : { permission, show, request } 더블 또는 null
 *   init          : Pomodoro.init 에 덧붙일 옵션
 */
function boot(opts) {
  opts = opts || {};

  // 문서 초기화
  document.documentElement.innerHTML = '<head></head><body></body>';
  document.head.innerHTML = DOC.head;
  document.body.innerHTML = DOC.body;
  document.title = '';

  // 자동 부팅 억제 후 스크립트 실행
  window.__POMODORO_NO_AUTOBOOT__ = true;
  delete window.Pomodoro;
  // eslint-disable-next-line no-new-func
  const run = new Function(DOC.script + '\n;return window.Pomodoro;');
  run.call(window);

  const clock = opts.clock || makeClock(opts.startWall);
  const storage = Object.prototype.hasOwnProperty.call(opts, 'storage')
    ? opts.storage
    : makeMemoryStorage();

  const initOpts = Object.assign(
    {
      now: clock.now,
      perf: clock.perf,
      storage,
      audio: Object.prototype.hasOwnProperty.call(opts, 'audio') ? opts.audio : null,
      notification: Object.prototype.hasOwnProperty.call(opts, 'notification')
        ? opts.notification
        : null,
      noInterval: true,
    },
    opts.init || {}
  );

  window.Pomodoro.init(initOpts);
  return { P: window.Pomodoro, clock, storage, doc: document };
}

/** 앱 내부 dateKey 와 동일한 로컬 타임존 기준 YYYY-MM-DD. */
function dateKeyLocal(ts) {
  const d = new Date(ts);
  const p = (n) => ('0' + n).slice(-2);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function $(id) { return document.getElementById(id); }
function isHidden(id) {
  const el = $(id);
  return !el || el.hidden === true;
}

/** advance + tick 을 반복해 실시간 사용 중 시간 경과를 재현한다. */
function run(P, clock, totalMs, stepMs) {
  const step = stepMs || 1000;
  let elapsed = 0;
  while (elapsed < totalMs) {
    const d = Math.min(step, totalMs - elapsed);
    clock.advance(d);
    elapsed += d;
    P.tick();
  }
}

/** 현재 Running 세션이 시간 만료로 끝나도록 남은시간 + 1초를 흘려보낸다. */
function finishRunning(P, clock) {
  const rem = P.getState().remainingMs;
  clock.advance(rem + 1000);
  P.tick();
}

module.exports = {
  HTML_PATH,
  boot,
  finishRunning,
  makeClock,
  makeFailingStorage,
  makeFlakyStorage,
  makeMemoryStorage,
  dateKeyLocal,
  $,
  isHidden,
  run,
};
