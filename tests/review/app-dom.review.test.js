/*
 * 독립 테스트 — DOM/알림/가시성 배선 계층 (src/app.js createApp)
 *
 * 근거: PRD FR-01, FR-02, FR-03, FR-05, FR-07, EC-01, EC-02, EC-04, EC-05, BR-04.
 * DOM / Notification / Web Audio / visibilitychange 는 전부 테스트 더블로 대체한다
 * (§CI 계약 4-나: 실제 네트워크/오디오 실호출은 설계 제외 — 가짜 DOM/테스트 더블 사용).
 * 직전 커밋의 app.js 변경(lastValidRemainingMs 기반 EC-04 고정값)도 함께 검증한다.
 *
 * @jest-environment jsdom
 */
'use strict';

const { Core, MIN, bootApp, reload, teardown, makeBackend, $, click, clockText } = require('./_helpers');

afterEach(teardown);

const { RUNNING, PAUSED, IDLE } = Core.STATUS;
const { FOCUS, SHORT_BREAK } = Core.SESSION;

function expireCurrent(ctrl, clock, ms) {
  clock.advance(ms);
  ctrl.evaluate();
}

describe('FR-01 타이머 시작/일시정지/리셋 (DOM)', () => {
  test('test_FR01_시작_일시정지_리셋_버튼_조작이_화면_남은시간과_상태에_정확히_반영된다', () => {
    const { ctrl, clock } = bootApp();
    expect(clockText()).toBe('25:00');

    click('btn-start-pause');                       // 시작
    expect($('btn-start-pause').textContent).toBe('일시정지');
    expect(ctrl.getState().timer.status).toBe(RUNNING);

    clock.advance(60 * 1000); ctrl.evaluate();
    expect(clockText()).toBe('24:00');

    click('btn-start-pause');                       // 일시정지 → 24:00 고정
    expect(ctrl.getState().timer.status).toBe(PAUSED);
    clock.advance(5 * MIN); ctrl.evaluate();
    expect(clockText()).toBe('24:00');

    click('btn-reset');                             // 리셋 → 25:00 Idle
    expect(ctrl.getState().timer.status).toBe(IDLE);
    expect(clockText()).toBe('25:00');
  });
});

describe('FR-02 세션 종료 알림 (DOM)', () => {
  test('test_FR02_권한이_허용된_경우_소리재생과_브라우저알림_호출이_함께_발생한다', () => {
    const { ctrl, clock, beeper, notification } = bootApp({ notification: 'granted' });
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1000);
    expect(beeper.play).toHaveBeenCalled();
    expect(notification).toHaveBeenCalled();        // new Notification(...) 호출됨
  });

  test('test_FR02_앱_실행중_세션종료_시점에_알림이_지체없이_발생한다', () => {
    const { ctrl, clock, beeper } = bootApp();
    click('btn-start-pause');
    expect(beeper.play).not.toHaveBeenCalled();
    expireCurrent(ctrl, clock, 25 * MIN + 1);       // 만료된 그 tick 에서 즉시
    expect(beeper.play).toHaveBeenCalledTimes(1);
  });

  test('test_FR02_오디오_재생이_실패로_감지되면_탭_제목_변경으로_대체된다', async () => {
    const { ctrl, clock } = bootApp({ notification: 'granted', audioOk: false });
    const original = document.title;
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1000);
    await Promise.resolve(); await Promise.resolve();
    expect(document.title).not.toBe(original);
    expect(document.title).toMatch(/●|완료|종료/);
  });

  test('test_FR02_오디오_재생_Promise가_거부돼도_실패로_보고_탭_제목_변경으로_대체된다', async () => {
    // FR-02: "오디오 재생 실패는 play() 호출의 Promise 거부로 감지 가능 → 실패 시 탭 제목 변경으로 즉시 대체"
    const rejectingBeeper = { unlock: jest.fn(), play: jest.fn(() => Promise.reject(new Error('play blocked'))) };
    const { ctrl, clock } = bootApp({ notification: 'granted', beeper: rejectingBeeper });
    const original = document.title;
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1000);
    await new Promise((r) => setTimeout(r, 20));
    expect(document.title).not.toBe(original);
  });
});

describe('EC-01 브라우저 알림 권한 거부 / Notification API 미지원', () => {
  test('test_EC01_권한이_거부된_경우_소리와_탭제목_변경으로_알리고_데스크톱_알림은_호출하지_않는다', () => {
    const { ctrl, clock, beeper, notification } = bootApp({ notification: 'denied' });
    const original = document.title;
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1000);
    expect(beeper.play).toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
    expect(document.title).not.toBe(original);
  });

  test('test_EC01_Notification_API_자체가_미지원인_경우에도_소리와_탭제목으로_알린다', () => {
    const { ctrl, clock, beeper } = bootApp({ notification: null });
    const original = document.title;
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1000);
    expect(beeper.play).toHaveBeenCalled();
    expect(document.title).not.toBe(original);
  });

  test('test_EC01_알림_폴백은_완료_카운트_등_데이터에_영향을_주지_않는다', () => {
    const { ctrl, clock } = bootApp({ notification: null });
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1000);
    const st = ctrl.getState();
    const key = Core.dateKey(st.timer.pendingCompletion.completedAt);
    expect(Core.getDailyLog(st.logs, key).count).toBe(1);
  });
});

describe('EC-02 탭 비활성(백그라운드) 중 세션 종료', () => {
  test('test_EC02_탭_복귀시_visibilitychange에서_종료목표시각과_현재시각을_비교해_즉시_종료처리한다', () => {
    const { ctrl, clock } = bootApp();
    click('btn-start-pause');                       // Focus Running

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    clock.advance(25 * MIN + 5000);                 // 백그라운드 스로틀링으로 tick 없음 가정
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(ctrl.getState().timer.memoPending).toBe(true);
  });

  test('test_EC02_백그라운드_경과는_절대시각_계산으로_반영되어_로그귀속시각이_원래_종료목표시각이다', () => {
    const start = new Date(2026, 8, 7, 9, 0, 0).getTime();
    const { ctrl, clock } = bootApp({ start });
    click('btn-start-pause');

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    clock.advance(25 * MIN + 60_000);               // 만료 후로도 1분 더
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    const pc = ctrl.getState().timer.pendingCompletion;
    expect(pc.completedAt).toBe(start + 25 * MIN);  // '현재'가 아니라 원래 종료 목표 시각
    expect(pc.dateKey).toBe('2026-09-07');
  });
});

describe('EC-04 시스템 시계 변경 (DOM, lastValidRemainingMs 고정값)', () => {
  test('test_EC04_시계변경_감지시_세션이_즉시_Paused로_전환되고_확인_알림을_표시한다', () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    const { ctrl, clock } = bootApp({ start: new Date(2026, 8, 7, 10, 0, 0).getTime() });
    click('btn-start-pause');
    clock.advance(3 * MIN); ctrl.evaluate();
    clock.jumpDateOnly(60 * MIN);                   // Date 만 +1h → date/perf 델타 불일치
    ctrl.evaluate();
    expect(ctrl.getState().timer.status).toBe(PAUSED);
    expect(alertSpy).toHaveBeenCalled();
  });

  test('test_EC04_시계변경시_남은시간은_감지_직전_마지막_유효_계산값으로_고정되고_임의_연장_단축이_없다', () => {
    jest.spyOn(window, 'alert').mockImplementation(() => {});
    const { ctrl, clock } = bootApp({ start: new Date(2026, 8, 7, 10, 0, 0).getTime() });
    click('btn-start-pause');                       // Focus Running 25:00
    clock.advance(3 * MIN); ctrl.evaluate();        // 정상 tick → lastValid = 22:00 기록
    const before = Core.remainingMs(ctrl.getState().timer, clock.now(), ctrl.getState().settings);
    expect(before).toBe(22 * MIN);

    clock.jumpDateOnly(60 * MIN);
    ctrl.evaluate();

    const snap = ctrl.getState().timer.remainingMsSnapshot;
    // 커밋 반영 전(endTimestamp-now)이면 음수→최소 1초로 붕괴. 반영 후엔 ≈ 22분.
    expect(Math.abs(snap - before)).toBeLessThanOrEqual(1000);
  });
});

describe('BR-04 Memo-Input-Pending 상태의 조작 제한 (DOM)', () => {
  test('test_BR04_MemoInputPending에서는_타이머_제어버튼_영역이_숨겨지고_메모UI만_노출된다', () => {
    const { ctrl, clock } = bootApp();
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1000);
    expect($('timer-controls').hidden).toBe(true);
    expect($('memo-box').hidden).toBe(false);
  });

  test('test_BR04_MemoInputPending은_시작_리셋_스킵으로_벗어날_수_없고_메모_제출_또는_건너뛰기로만_벗어난다', () => {
    const { ctrl, clock } = bootApp();
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1000);

    click('btn-start-pause'); click('btn-reset'); click('btn-skip');
    expect(ctrl.getState().timer.memoPending).toBe(true);

    click('btn-memo-skip');
    expect(ctrl.getState().timer.memoPending).toBe(false);
  });
});

describe('FR-03 사이클 자동 전환 (DOM)', () => {
  test('test_FR03_Focus완료_메모제출후_ShortBreak가_자동시작되고_Break종료후_다음_Focus가_자동시작된다', () => {
    const { ctrl, clock } = bootApp();
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1);
    expect(ctrl.getState().timer.memoPending).toBe(true);

    $('memo-input').value = '설계';
    click('btn-memo-submit');
    let st = ctrl.getState();
    expect(st.timer.sessionType).toBe(SHORT_BREAK);
    expect(st.timer.status).toBe(RUNNING);          // 자동 시작

    expireCurrent(ctrl, clock, 5 * MIN + 1);
    st = ctrl.getState();
    expect(st.timer.sessionType).toBe(FOCUS);
    expect(st.timer.status).toBe(RUNNING);          // 메모 없이 자동 시작
  });
});

describe('FR-05 작업 메모 기록 (DOM)', () => {
  test('test_FR05_Focus_정상종료마다_메모입력창이_표시된다', () => {
    const { ctrl, clock } = bootApp();
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1);
    expect($('memo-box').hidden).toBe(false);
  });

  test('test_FR05_건너뛰기시_완료카운트는_정상증가하고_빈_메모는_로그에_메모없음으로_표시된다', () => {
    const { ctrl, clock } = bootApp({ start: new Date(2026, 8, 7, 9, 0, 0).getTime() });
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1);
    click('btn-memo-skip');

    click('nav-log');
    expect($('log-count').textContent).toBe('1');
    const items = document.querySelectorAll('#log-list li');
    expect(items.length).toBe(1);
    expect(items[0].textContent).toMatch(/메모 없음/);
  });
});

describe('FR-06 일별 로그 화면 (DOM)', () => {
  test('test_FR06_로그화면_기본_선택날짜는_오늘이고_메모는_오래된순으로_표시된다', () => {
    const { ctrl, clock } = bootApp({ start: new Date(2026, 8, 7, 9, 0, 0).getTime() });

    // 두 번의 Focus 완료 (사이 시간 경과 포함)
    click('btn-start-pause');
    expireCurrent(ctrl, clock, 25 * MIN + 1);
    $('memo-input').value = '첫번째'; click('btn-memo-submit');   // ShortBreak 자동시작
    expireCurrent(ctrl, clock, 5 * MIN + 1);                      // → Focus 자동시작
    expireCurrent(ctrl, clock, 25 * MIN + 1);
    $('memo-input').value = '두번째'; click('btn-memo-submit');

    click('nav-log');
    expect($('log-date').value).toBe('2026-09-07');
    expect($('log-count').textContent).toBe('2');
    const texts = Array.from(document.querySelectorAll('#log-list li')).map((li) => li.textContent);
    expect(texts[0]).toMatch(/첫번째/);
    expect(texts[1]).toMatch(/두번째/);
  });
});

describe('FR-07 설정 (DOM)', () => {
  test('test_FR07_Idle상태_Focus의_설정변경은_화면_남은시간_표시에_즉시_반영된다', () => {
    const { ctrl } = bootApp();
    expect(clockText()).toBe('25:00');
    click('nav-settings');
    $('set-focus').value = '45'; $('set-short').value = '5'; $('set-long').value = '15';
    click('btn-settings-save');
    click('nav-timer');
    expect(clockText()).toBe('45:00');
  });

  test('test_FR07_Running상태_Focus의_설정변경은_현세션에_적용되지_않고_다음_Focus세션부터_적용된다', () => {
    const { ctrl, clock } = bootApp();
    click('btn-start-pause');                       // Focus Running 25:00
    clock.advance(60 * 1000); ctrl.evaluate();      // 24:00

    click('nav-settings');
    $('set-focus').value = '10'; $('set-short').value = '5'; $('set-long').value = '15';
    click('btn-settings-save');
    click('nav-timer'); ctrl.evaluate();
    expect(clockText()).toBe('24:00');             // 10:00 으로 줄지 않음
  });

  test('test_FR07_범위를_벗어난_값은_저장되지_않고_오류가_표시되며_기존_설정이_유지된다', () => {
    const { ctrl } = bootApp();
    click('nav-settings');
    $('set-focus').value = '0'; $('set-short').value = '5'; $('set-long').value = '181';
    click('btn-settings-save');
    expect($('settings-error').hidden).toBe(false);
    expect(ctrl.getState().settings).toEqual({ focusMin: 25, shortBreakMin: 5, longBreakMin: 15 });
  });

  test('test_FR07_설정을_변경하고_저장하면_새로고침_후에도_변경된_값이_유지된다', () => {
    const backend = makeBackend();
    const { ctrl } = bootApp({ backend });
    click('nav-settings');
    $('set-focus').value = '30'; $('set-short').value = '6'; $('set-long').value = '20';
    click('btn-settings-save');
    ctrl.stop();

    const { ctrl: ctrl2 } = reload({ backend, start: Date.now() });
    expect(ctrl2.getState().settings).toEqual({ focusMin: 30, shortBreakMin: 6, longBreakMin: 20 });
  });
});

describe('EC-05 localStorage 쓰기 실패 (DOM 배너)', () => {
  test('test_EC05_쓰기_실패동안_경고배너가_표시되고_타이머는_계속_동작하며_복구되면_배너가_해제된다', () => {
    const { ctrl, clock, backend } = bootApp();
    backend.failWrites = true;
    click('btn-start-pause');
    ctrl.evaluate();

    const banner = $('storage-banner');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/저장되지 않고 있습니다/);
    expect(ctrl.getState().timer.status).toBe(RUNNING);   // 중단되지 않음

    backend.failWrites = false;
    click('btn-start-pause');                       // pause → write → 자동 재시도 성공
    ctrl.evaluate();
    expect(banner.hidden).toBe(true);
  });
});

/* ── 커밋 코드 기반(INT): app.js 배선 회귀·리소스 해제 ─────────────────────── */
describe('INT app.js 배선 — 리소스 해제 / EC-04 폴백 경계', () => {
  test('test_INT_stop_호출후에는_추가_tick이_돌지_않아_상태가_더_변하지_않는다', () => {
    const { app, ctrl, clock } = bootApp();
    click('btn-start-pause');
    clock.advance(3 * MIN); ctrl.evaluate();
    const snapshot = JSON.stringify(ctrl.getState().timer);
    app.stop();
    clock.advance(60 * MIN);                        // stop 이후 큰 시간 경과
    expect(JSON.stringify(ctrl.getState().timer)).toBe(snapshot);
  });

  test('test_INT_정상_tick_없이_시계가_종료시각_너머로_점프해도_Paused_스냅샷은_양수로_보정된다', () => {
    jest.spyOn(window, 'alert').mockImplementation(() => {});
    const { ctrl, clock } = bootApp({ start: new Date(2026, 8, 7, 10, 0, 0).getTime() });
    click('btn-start-pause');                       // lastValidRemainingMs = null (시작 시 리셋)
    clock.jumpDateOnly(60 * MIN);                   // 정상 tick 한 번도 없이 만료 너머로 점프
    ctrl.evaluate();
    const snap = ctrl.getState().timer.remainingMsSnapshot;
    expect(ctrl.getState().timer.status).toBe(PAUSED);
    expect(snap).toBeGreaterThanOrEqual(Core.MIN_PAUSED_REMAINING_MS);
    expect(snap).toBeLessThanOrEqual(25 * MIN);
  });

  test('test_INT_evaluate를_Idle상태에서_호출해도_예외없이_렌더만_수행한다', () => {
    const { ctrl } = bootApp();
    expect(() => { ctrl.evaluate(); ctrl.evaluate(); }).not.toThrow();
    expect(ctrl.getState().timer.status).toBe(IDLE);
  });
});
