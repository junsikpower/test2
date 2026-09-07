/*
 * 자체 테스트 — 13. Acceptance Criteria
 *  13.1 Functional : 개별 기능 단위 수용 조건
 *  13.2 System     : 둘 이상 기능이 함께 동작하는 통합 시나리오
 *  13.3 User       : 사용자 실제 사용 흐름을 처음부터 끝까지 재현 (조작 사이 시간 경과 포함)
 *
 * @jest-environment jsdom
 */
'use strict';

const App = require('../../src/app.js');
const Core = require('../../src/core.js');
const Storage = require('../../src/storage.js');
const MIN = Core.MS_PER_MIN;

const DOM = `
  <main id="app">
    <div id="storage-banner" hidden></div>
    <nav><button id="nav-timer"></button><button id="nav-settings"></button><button id="nav-log"></button></nav>
    <section id="view-timer">
      <div id="session-type"></div><div id="slot-info"></div><div id="clock"></div>
      <div id="timer-controls">
        <button id="btn-start-pause"></button><button id="btn-reset"></button><button id="btn-skip"></button>
      </div>
      <div id="memo-box" hidden>
        <input id="memo-input" /><button id="btn-memo-submit"></button><button id="btn-memo-skip"></button>
      </div>
    </section>
    <section id="view-settings" hidden>
      <input id="set-focus" /><input id="set-short" /><input id="set-long" />
      <button id="btn-settings-save"></button><div id="settings-error" hidden></div>
    </section>
    <section id="view-log" hidden>
      <input id="log-date" /><strong id="log-count"></strong><ul id="log-list"></ul>
    </section>
  </main>
`;

function makeBackend() {
  const map = {};
  return {
    map, failWrites: false,
    setItem(k, v) { if (this.failWrites) throw new Error('quota'); map[k] = String(v); },
    getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    removeItem(k) { delete map[k]; }
  };
}
function makeClock(startMs) {
  let d = startMs, p = startMs;
  return {
    now: () => d,
    perfNow: () => p,
    advance: (ms) => { d += ms; p += ms; },   // 정상 시간 경과 (두 클록 함께)
    jumpDateOnly: (ms) => { d += ms; }         // 시스템 시계만 변경 (EC-04 재현)
  };
}
function boot(opts = {}) {
  document.body.innerHTML = DOM;
  const clock = makeClock(opts.start || new Date(2026, 8, 7, 9, 0, 0).getTime());
  const backend = opts.backend || makeBackend();
  const store = Storage.createStore({ backend });
  const beep = { unlock: jest.fn(), play: jest.fn(() => Promise.resolve(true)) };
  window.Notification = Object.assign(jest.fn(), { permission: 'granted' });
  const app = App.createApp({
    document, window, now: () => clock.now(), perfNow: () => clock.perfNow(),
    storage: store, beeper: beep, tickMs: 10
  });
  _liveApps.push(app);
  return { app, clock, backend, store, beep };
}

const _liveApps = [];
afterEach(() => {
  while (_liveApps.length) { try { _liveApps.pop().stop(); } catch (e) { /* noop */ } }
  jest.restoreAllMocks();
  delete window.Notification;
});

describe('13.1 Functional Acceptance', () => {
  test('test_AC13_1_설정변경_저장후_새로고침해도_변경된_값이_유지된다 (FR-07)', () => {
    const { app, backend } = boot();
    let ctrl = app.start();
    document.getElementById('nav-settings').click();
    document.getElementById('set-focus').value = '30';
    document.getElementById('set-short').value = '6';
    document.getElementById('set-long').value = '20';
    document.getElementById('btn-settings-save').click();
    ctrl.stop();

    // 새로고침 = 같은 backend 로 새 앱 인스턴스
    const store2 = Storage.createStore({ backend });
    const app2 = App.createApp({
      document, window, now: () => Date.now(), perfNow: () => 0,
      storage: store2, beeper: { unlock() {}, play: () => Promise.resolve(true) }, tickMs: 10
    });
    const ctrl2 = app2.start();
    expect(ctrl2.getState().settings).toEqual({ focusMin: 30, shortBreakMin: 6, longBreakMin: 20 });
    ctrl2.stop();
  });

  test('test_AC13_1_Idle상태_Focus의_설정변경은_화면_남은시간_표시에_즉시_반영된다 (FR-07)', () => {
    const { app } = boot();
    const ctrl = app.start();
    expect(document.getElementById('clock').textContent).toBe('25:00');
    document.getElementById('nav-settings').click();
    document.getElementById('set-focus').value = '45';
    document.getElementById('set-short').value = '5';
    document.getElementById('set-long').value = '15';
    document.getElementById('btn-settings-save').click();
    document.getElementById('nav-timer').click();
    expect(document.getElementById('clock').textContent).toBe('45:00');
    ctrl.stop();
  });

  test('test_AC13_1_Running_Focus의_설정변경은_현세션에_적용되지_않고_다음_Focus부터_적용된다 (FR-07)', () => {
    const { app, clock } = boot();
    const ctrl = app.start();
    document.getElementById('btn-start-pause').click(); // Focus Running 25분
    clock.advance(60 * 1000);

    document.getElementById('nav-settings').click();
    document.getElementById('set-focus').value = '10';
    document.getElementById('set-short').value = '5';
    document.getElementById('set-long').value = '15';
    document.getElementById('btn-settings-save').click();
    document.getElementById('nav-timer').click();
    ctrl.evaluate();
    // 현재 세션은 여전히 24:00 부근 (25분 기준), 10분으로 줄지 않음
    expect(document.getElementById('clock').textContent).toBe('24:00');
    ctrl.stop();
  });

  test('test_AC13_1_범위밖_설정값은_저장되지_않고_오류가_표시된다 (FR-07)', () => {
    const { app } = boot();
    const ctrl = app.start();
    document.getElementById('nav-settings').click();
    document.getElementById('set-focus').value = '0';
    document.getElementById('set-short').value = '5';
    document.getElementById('set-long').value = '15';
    document.getElementById('btn-settings-save').click();
    expect(document.getElementById('settings-error').hidden).toBe(false);
    expect(ctrl.getState().settings.focusMin).toBe(25); // 그대로
    ctrl.stop();
  });

  test('test_AC13_1_localStorage_쓰기_실패해도_타이머_사용이_중단되지_않고_경고배너가_표시된다 (EC-05)', () => {
    const { app, clock, backend } = boot();
    const ctrl = app.start();
    backend.failWrites = true;
    document.getElementById('btn-start-pause').click(); // 시작 (저장 실패)
    clock.advance(1000);
    ctrl.evaluate();
    expect(document.getElementById('storage-banner').hidden).toBe(false);
    // 타이머는 계속 동작 (Running)
    expect(ctrl.getState().timer.status).toBe(Core.STATUS.RUNNING);
    ctrl.stop();
  });
});

describe('13.2 System Acceptance', () => {
  test('test_AC13_2_정상실행중_시작_종료_기록_자동전환_다음세션_흐름이_끊김없이_동작한다', () => {
    const { app, clock } = boot();
    const ctrl = app.start();

    // Focus 시작 → 25분 경과 → 완료 → 메모 저장 → Short Break 자동 시작
    document.getElementById('btn-start-pause').click();
    clock.advance(25 * MIN + 1);
    ctrl.evaluate();
    expect(ctrl.getState().timer.memoPending).toBe(true);

    document.getElementById('memo-input').value = '설계 문서 작성';
    document.getElementById('btn-memo-submit').click();

    const st = ctrl.getState();
    expect(st.timer.sessionType).toBe(Core.SESSION.SHORT_BREAK);
    expect(st.timer.status).toBe(Core.STATUS.RUNNING); // 자동 시작

    // Short Break 5분 경과 → 메모 없이 다음 Focus 자동 시작
    clock.advance(5 * MIN + 1);
    ctrl.evaluate();
    const st2 = ctrl.getState();
    expect(st2.timer.sessionType).toBe(Core.SESSION.FOCUS);
    expect(st2.timer.status).toBe(Core.STATUS.RUNNING);

    // 로그에 완료 1개 + 메모 반영 (첫 Focus 는 09:00 시작 → 09:25 종료)
    const today = Core.dateKey(new Date(2026, 8, 7, 9, 25).getTime());
    expect(Core.getDailyLog(ctrl.getState().logs, today).count).toBe(1);
    expect(Core.getDailyLog(ctrl.getState().logs, today).memos[0].text).toBe('설계 문서 작성');
    ctrl.stop();
  });

  test('test_AC13_2_재접속복원_Running_만료_1회종료처리후_다음세션_Idle_수동시작대기', () => {
    const backend = makeBackend();
    const { app, clock } = boot({ backend });
    let ctrl = app.start();
    document.getElementById('btn-start-pause').click(); // Focus Running
    ctrl.stop();

    // 브라우저 완전 종료 상태로 3시간 경과 후 재접속
    const reloadClock = makeClock(clock.now() + 3 * 60 * MIN);
    const store2 = Storage.createStore({ backend });
    const app2 = App.createApp({
      document, window, now: reloadClock.now, perfNow: reloadClock.perfNow,
      storage: store2, beeper: { unlock() {}, play: () => Promise.resolve(true) }, tickMs: 10
    });
    window.Notification = Object.assign(jest.fn(), { permission: 'granted' });
    const ctrl2 = app2.start();

    // 만료 Focus → 메모 대기, 완료 1회
    expect(ctrl2.getState().timer.memoPending).toBe(true);
    document.getElementById('btn-memo-skip').click();

    // BR-02: 다음 세션은 자동 시작되지 않고 Idle 대기
    const st = ctrl2.getState();
    expect(st.timer.status).toBe(Core.STATUS.IDLE);
    expect(st.timer.sessionType).toBe(Core.SESSION.SHORT_BREAK);
    ctrl2.stop();
  });

  test('test_AC13_2_재접속복원_Paused_오프라인시간과_무관하게_남은시간_스냅샷_유지_종료처리없음', () => {
    const backend = makeBackend();
    const start = new Date(2026, 8, 7, 9, 0, 0).getTime();
    const { app, clock } = boot({ backend, start });
    let ctrl = app.start();
    document.getElementById('btn-start-pause').click(); // Running
    clock.advance(10 * MIN);
    ctrl.evaluate();
    document.getElementById('btn-start-pause').click(); // Pause → 15:00 남음
    const pausedRemaining = ctrl.getState().timer.remainingMsSnapshot;
    expect(pausedRemaining).toBe(15 * MIN);
    ctrl.stop();

    // 이틀 뒤 재접속
    const reloadClock = makeClock(start + 2 * 24 * 60 * MIN);
    const store2 = Storage.createStore({ backend });
    const app2 = App.createApp({
      document, window, now: reloadClock.now, perfNow: reloadClock.perfNow,
      storage: store2, beeper: { unlock() {}, play: () => Promise.resolve(true) }, tickMs: 10
    });
    const ctrl2 = app2.start();
    const st = ctrl2.getState();
    expect(st.timer.status).toBe(Core.STATUS.PAUSED);
    expect(st.timer.remainingMsSnapshot).toBe(15 * MIN); // 변하지 않음
    expect(st.timer.memoPending).toBe(false); // 종료 처리 안 됨
    ctrl2.stop();
  });
});

describe('13.3 User Acceptance', () => {
  test('test_AC13_3_하루동안_실제사용_로그화면의_완료개수와_메모가_실제작업내역과_일치한다', () => {
    // 사용자는 오전에 2회, 오후에 1회 집중 세션을 완료한다. 조작 사이 시간 경과 포함.
    const start = new Date(2026, 8, 7, 9, 0, 0).getTime();
    const { app, clock } = boot({ start });
    const ctrl = app.start();
    const today = '2026-09-07';

    function completeFocusWithMemo(memo) {
      // Break 종료 후에는 다음 Focus 가 이미 자동 시작(Running)돼 있다. Idle 일 때만 시작 클릭.
      if (ctrl.getState().timer.status === Core.STATUS.IDLE) {
        document.getElementById('btn-start-pause').click();
      }
      clock.advance(25 * MIN + 1);                              // 25분 집중
      ctrl.evaluate();                                          // 종료 → 메모 대기
      expect(ctrl.getState().timer.memoPending).toBe(true);
      document.getElementById('memo-input').value = memo;
      document.getElementById('btn-memo-submit').click();       // 메모 저장 → 다음(Break) 자동시작
    }
    function passBreak(mins) {
      clock.advance(mins * MIN + 1);
      ctrl.evaluate(); // Break 종료 → 다음 Focus 자동 시작
    }

    completeFocusWithMemo('이메일 정리');
    passBreak(5);
    completeFocusWithMemo('보고서 초안');
    passBreak(5);

    // 점심 시간: 2시간 자리 비움 (Focus Running 중 방치되면 만료) → 여기서는 사용자가 리셋 후 오후 재개
    document.getElementById('btn-reset').click();
    clock.advance(2 * 60 * MIN);

    completeFocusWithMemo('');  // 오후엔 메모 없이 건너뛴 셈 (빈 값)

    document.getElementById('nav-log').click();
    expect(document.getElementById('log-count').textContent).toBe('3');
    const day = Core.getDailyLog(ctrl.getState().logs, today);
    expect(day.count).toBe(3);
    expect(day.memos.map((m) => Core.displayMemoText(m.text))).toEqual([
      '이메일 정리', '보고서 초안', '메모 없음'
    ]);
    // 메모는 오름차순
    expect(day.memos[0].completedAt).toBeLessThan(day.memos[1].completedAt);
    expect(day.memos[1].completedAt).toBeLessThan(day.memos[2].completedAt);
    ctrl.stop();
  });

  test('test_AC13_3_임의시점에_새로고침해도_진행중이던_세션_설정_로그가_그대로_유지된다', () => {
    const backend = makeBackend();
    const start = new Date(2026, 8, 7, 14, 0, 0).getTime();
    const { app, clock } = boot({ backend, start });
    const ctrl = app.start();

    // 설정 바꾸고, 한 세션 완료해 로그 남기고, 다음 세션 8분 진행하다가 새로고침
    document.getElementById('nav-settings').click();
    document.getElementById('set-focus').value = '20';
    document.getElementById('set-short').value = '10';
    document.getElementById('set-long').value = '15';
    document.getElementById('btn-settings-save').click();
    document.getElementById('nav-timer').click();

    document.getElementById('btn-start-pause').click();
    clock.advance(20 * MIN + 1);
    ctrl.evaluate();
    document.getElementById('memo-input').value = '리서치';
    document.getElementById('btn-memo-submit').click(); // 10분짜리 Short Break 자동 시작
    clock.advance(8 * MIN); // 8분 진행 (2분 남음)
    ctrl.evaluate();
    ctrl.stop();

    // 새로고침
    const reloadClock = makeClock(clock.now() + 500);
    const store2 = Storage.createStore({ backend });
    const app2 = App.createApp({
      document, window, now: reloadClock.now, perfNow: reloadClock.perfNow,
      storage: store2, beeper: { unlock() {}, play: () => Promise.resolve(true) }, tickMs: 10
    });
    const ctrl2 = app2.start();
    const after = ctrl2.getState();

    expect(after.settings).toEqual({ focusMin: 20, shortBreakMin: 10, longBreakMin: 15 });
    expect(after.timer.sessionType).toBe(Core.SESSION.SHORT_BREAK);
    expect(after.timer.status).toBe(Core.STATUS.RUNNING);
    // 남은 시간 ~2분 (오차 1초 이내)
    const remain = Core.remainingMs(after.timer, reloadClock.now(), after.settings);
    expect(Math.abs(remain - 2 * MIN)).toBeLessThanOrEqual(1000);
    // 로그 유지
    expect(Core.getDailyLog(after.logs, '2026-09-07').count).toBe(1);
    ctrl2.stop();
  });

  test('test_AC13_3_시스템시계가_임의로_변경되면_타이머가_늘어나거나_줄지_않고_일시정지되고_확인을_요청한다', () => {
    const start = new Date(2026, 8, 7, 10, 0, 0).getTime();
    const { app, clock } = boot({ start });
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    const ctrl = app.start();

    document.getElementById('btn-start-pause').click(); // Focus Running 25분
    clock.advance(3 * MIN); // 정상 3분 경과, 22분 남음
    ctrl.evaluate();
    const remainingBefore = Core.remainingMs(ctrl.getState().timer, clock.now(), ctrl.getState().settings);
    expect(remainingBefore).toBe(22 * MIN);

    // 시스템 시계만 앞으로 1시간 점프 (performance.now 는 그대로) → date/perf 델타 불일치
    clock.jumpDateOnly(60 * MIN);
    ctrl.evaluate();

    const st = ctrl.getState();
    expect(st.timer.status).toBe(Core.STATUS.PAUSED);      // 일시정지됨
    expect(alertSpy).toHaveBeenCalled();                   // 확인 알림
    // 남은 시간이 임의로 연장/단축되지 않음 (감지 직전 값 ±1초)
    expect(Math.abs(st.timer.remainingMsSnapshot - remainingBefore)).toBeLessThanOrEqual(1000);
    ctrl.stop();
  });

  test('test_AC13_3_저장공간_문제로_데이터가_저장되지_않아도_사용자는_경고로_이를_인지한다 (EC-05)', () => {
    const { app, clock, backend } = boot();
    const ctrl = app.start();
    backend.failWrites = true;

    document.getElementById('btn-start-pause').click();
    clock.advance(1000);
    ctrl.evaluate();

    const banner = document.getElementById('storage-banner');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/저장되지 않고 있습니다/);

    // 저장 공간 회복 → 다음 상태 변경 시 자동 재시도 → 경고 해제
    backend.failWrites = false;
    document.getElementById('btn-start-pause').click(); // pause (상태 변경 → write)
    ctrl.evaluate();
    expect(banner.hidden).toBe(true);
    ctrl.stop();
  });
});
