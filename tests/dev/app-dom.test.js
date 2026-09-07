/*
 * 자체 테스트 — DOM 배선 계층 (src/app.js)
 *  - 세션 종료 알림 (FR-02), 알림 권한 거부/미지원 폴백 (EC-01)
 *  - 탭 비활성 중 세션 종료 후 복귀 보정 (EC-02)
 *  - Memo-Input-Pending 조작 제한 (BR-04)
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
    <nav>
      <button id="nav-timer"></button>
      <button id="nav-settings"></button>
      <button id="nav-log"></button>
    </nav>
    <section id="view-timer">
      <div id="session-type"></div>
      <div id="slot-info"></div>
      <div id="clock"></div>
      <div id="timer-controls">
        <button id="btn-start-pause"></button>
        <button id="btn-reset"></button>
        <button id="btn-skip"></button>
      </div>
      <div id="memo-box" hidden>
        <input id="memo-input" />
        <button id="btn-memo-submit"></button>
        <button id="btn-memo-skip"></button>
      </div>
    </section>
    <section id="view-settings" hidden>
      <input id="set-focus" /><input id="set-short" /><input id="set-long" />
      <button id="btn-settings-save"></button>
      <div id="settings-error" hidden></div>
    </section>
    <section id="view-log" hidden>
      <input id="log-date" />
      <strong id="log-count"></strong>
      <ul id="log-list"></ul>
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

/** 시간을 완전히 제어하는 클록 더블. */
function makeClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    perfNow: () => t,
    advance: (ms) => { t += ms; }
  };
}

function setup(opts = {}) {
  document.body.innerHTML = DOM;
  const clock = makeClock(opts.start || 1_700_000_000_000);
  const backend = opts.backend || makeBackend();
  const store = Storage.createStore({ backend });
  const beep = { unlock: jest.fn(), play: jest.fn(() => Promise.resolve(opts.audioOk !== false)) };
  const app = App.createApp({
    document, window,
    now: clock.now, perfNow: clock.perfNow,
    storage: store, beeper: beep,
    tickMs: 10
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

describe('FR-02 세션 종료 알림', () => {
  test('test_FR02_권한이_허용된_경우_소리재생과_브라우저알림_호출이_함께_발생한다', () => {
    const notifCtor = jest.fn();
    notifCtor.permission = 'granted';
    window.Notification = notifCtor;

    const { app, clock, beep } = setup();
    const ctrl = app.start();
    // Focus 시작 후 만료시키기
    document.getElementById('btn-start-pause').click();
    clock.advance(25 * MIN + 1000);
    ctrl.evaluate();

    expect(beep.play).toHaveBeenCalled();
    expect(notifCtor).toHaveBeenCalled(); // new Notification(...) 호출
    ctrl.stop();
  });

  test('test_FR02_오디오_재생실패가_감지되면_탭_제목_변경으로_대체된다', async () => {
    // 권한 미허용 + 오디오 실패 → 탭 제목 폴백
    const { app, clock, beep } = setup({ audioOk: false });
    const original = document.title;
    const ctrl = app.start();
    document.getElementById('btn-start-pause').click();
    clock.advance(25 * MIN + 1000);
    ctrl.evaluate();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.title).not.toBe(original);
    expect(document.title).toMatch(/●|종료|완료/);
    ctrl.stop();
  });
});

describe('EC-01 알림 권한 거부 또는 Notification API 미지원', () => {
  test('test_EC01_Notification_권한이_거부된_경우_소리와_탭제목_변경으로_알린다', () => {
    const notifCtor = jest.fn();
    notifCtor.permission = 'denied';
    window.Notification = notifCtor;

    const { app, clock, beep } = setup();
    const original = document.title;
    const ctrl = app.start();
    document.getElementById('btn-start-pause').click();
    clock.advance(25 * MIN + 1000);
    ctrl.evaluate();

    expect(beep.play).toHaveBeenCalled();
    expect(notifCtor).not.toHaveBeenCalled(); // 거부 상태에서는 new Notification 호출 안 함
    expect(document.title).not.toBe(original); // 탭 제목 폴백
    ctrl.stop();
  });

  test('test_EC01_Notification_API_자체가_미지원인_경우에도_소리와_탭제목으로_알린다', () => {
    delete window.Notification; // 미지원
    const { app, clock, beep } = setup();
    const original = document.title;
    const ctrl = app.start();
    document.getElementById('btn-start-pause').click();
    clock.advance(25 * MIN + 1000);
    ctrl.evaluate();

    expect(beep.play).toHaveBeenCalled();
    expect(document.title).not.toBe(original);
    ctrl.stop();
  });

  test('test_EC01_알림_폴백은_데이터에_영향을_주지_않는다', () => {
    delete window.Notification;
    const { app, clock } = setup();
    const ctrl = app.start();
    document.getElementById('btn-start-pause').click();
    clock.advance(25 * MIN + 1000);
    ctrl.evaluate();
    // 완료 카운트는 정상 반영
    const day = Core.getDailyLog(ctrl.getState().logs, Core.dateKey(ctrl.getState().timer.pendingCompletion.completedAt));
    expect(day.count).toBe(1);
    ctrl.stop();
  });
});

describe('EC-02 탭 비활성(백그라운드) 중 세션 종료', () => {
  test('test_EC02_탭_복귀시_visibilitychange에서_종료목표시각과_현재시각을_비교해_즉시_종료처리한다', () => {
    const { app, clock } = setup();
    const ctrl = app.start();
    document.getElementById('btn-start-pause').click(); // Focus Running

    // 탭 숨김 상태로 25분 경과 (백그라운드 스로틀링으로 tick 이 안 돌았다고 가정)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    clock.advance(25 * MIN + 5000);

    // 탭 복귀
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    const st = ctrl.getState();
    expect(st.timer.memoPending).toBe(true); // 즉시 종료 처리되어 메모 대기
    ctrl.stop();
  });

  test('test_EC02_백그라운드_경과는_절대시각_계산으로_정확히_반영되어_데이터_정합성이_유지된다', () => {
    const { app, clock } = setup();
    const ctrl = app.start();
    document.getElementById('btn-start-pause').click();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    clock.advance(25 * MIN + 60_000); // 만료 후로도 1분 더
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    const pc = ctrl.getState().timer.pendingCompletion;
    // 로그 귀속 시각은 '경과 후 현재'가 아니라 원래 종료 목표 시각
    expect(pc.completedAt).toBe(1_700_000_000_000 + 25 * MIN);
    ctrl.stop();
  });
});

describe('BR-04 Memo-Input-Pending 상태의 조작 제한', () => {
  test('test_BR04_MemoInputPending에서는_타이머_제어버튼_영역이_노출되지_않고_메모UI만_노출된다', () => {
    const { app, clock } = setup();
    const ctrl = app.start();
    document.getElementById('btn-start-pause').click();
    clock.advance(25 * MIN + 1000);
    ctrl.evaluate();

    expect(document.getElementById('timer-controls').hidden).toBe(true);
    expect(document.getElementById('memo-box').hidden).toBe(false);
    ctrl.stop();
  });

  test('test_BR04_MemoInputPending은_메모_제출_또는_건너뛰기로만_벗어난다', () => {
    const { app, clock } = setup();
    const ctrl = app.start();
    document.getElementById('btn-start-pause').click();
    clock.advance(25 * MIN + 1000);
    ctrl.evaluate();

    // 이 상태에서 시작/리셋/스킵 클릭은 무시되어야 함
    document.getElementById('btn-start-pause').click();
    document.getElementById('btn-reset').click();
    document.getElementById('btn-skip').click();
    expect(ctrl.getState().timer.memoPending).toBe(true);

    // 건너뛰기로만 빠져나옴
    document.getElementById('btn-memo-skip').click();
    expect(ctrl.getState().timer.memoPending).toBe(false);
    ctrl.stop();
  });

  test('test_BR04_빈값_메모_제출_또는_건너뛰기_모두_완료카운트는_정상_반영된다', () => {
    const { app, clock } = setup();
    const ctrl = app.start();
    document.getElementById('btn-start-pause').click();
    clock.advance(25 * MIN + 1000);
    ctrl.evaluate();
    const key = Core.dateKey(ctrl.getState().timer.pendingCompletion.completedAt);
    document.getElementById('btn-memo-skip').click();
    expect(Core.getDailyLog(ctrl.getState().logs, key).count).toBe(1);
    ctrl.stop();
  });
});
