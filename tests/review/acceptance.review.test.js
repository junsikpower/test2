/*
 * 독립 테스트 — §13 Acceptance Criteria
 *   13.1 Functional : 개별 기능 단위 수용 조건
 *   13.2 System     : 둘 이상의 기능이 함께 동작하는 통합 시나리오
 *   13.3 User       : 사용자의 실제 사용 흐름을 처음부터 끝까지 재현 (조작 사이 시간 경과 포함)
 *
 * DOM / 알림 / 오디오 / 저장소는 전부 테스트 더블. 실호출 없음.
 *
 * @jest-environment jsdom
 */
'use strict';

const { Core, MIN, bootApp, reload, teardown, makeBackend, $, click, clockText } = require('./_helpers');

afterEach(teardown);

const { RUNNING, PAUSED, IDLE } = Core.STATUS;
const { FOCUS, SHORT_BREAK, LONG_BREAK } = Core.SESSION;

/* ────────────────────────────── 13.1 Functional ────────────────────────────── */
describe('13.1 Functional Acceptance', () => {
  test('test_AC13_1_Paused상태에서_새로고침해도_남은시간_스냅샷이_오프라인시간과_무관하게_그대로_복원된다 (FR-08, EC-03)', () => {
    const backend = makeBackend();
    const start = new Date(2026, 8, 7, 9, 0, 0).getTime();
    const { ctrl, clock } = bootApp({ backend, start });
    click('btn-start-pause');                       // Running
    clock.advance(10 * MIN); ctrl.evaluate();
    click('btn-start-pause');                       // Pause → 15:00 남음
    expect(ctrl.getState().timer.remainingMsSnapshot).toBe(15 * MIN);
    ctrl.stop();

    const { ctrl: ctrl2 } = reload({ backend, start: start + 3 * 24 * 60 * MIN });  // 3일 뒤
    const st = ctrl2.getState();
    expect(st.timer.status).toBe(PAUSED);
    expect(st.timer.remainingMsSnapshot).toBe(15 * MIN);
    expect(st.timer.memoPending).toBe(false);
  });

  test('test_AC13_1_MemoInputPending에서_타이머_제어버튼은_노출되지_않고_메모_제출_건너뛰기_UI만_노출된다 (BR-04)', () => {
    const { ctrl, clock } = bootApp();
    click('btn-start-pause');
    clock.advance(25 * MIN + 1); ctrl.evaluate();
    expect($('timer-controls').hidden).toBe(true);
    expect($('memo-box').hidden).toBe(false);
    expect($('btn-memo-submit')).not.toBeNull();
    expect($('btn-memo-skip')).not.toBeNull();
  });

  test('test_AC13_1_Idle세션_설정변경은_화면에_즉시_반영되고_Running세션_설정변경은_다음_세션부터_반영된다 (FR-07)', () => {
    const { ctrl, clock } = bootApp();
    // Idle: 즉시
    click('nav-settings');
    $('set-focus').value = '30'; $('set-short').value = '5'; $('set-long').value = '15';
    click('btn-settings-save');
    click('nav-timer');
    expect(clockText()).toBe('30:00');
    // Running: 다음 세션부터
    click('btn-start-pause');
    clock.advance(60 * 1000); ctrl.evaluate();      // 29:00
    click('nav-settings');
    $('set-focus').value = '12'; click('btn-settings-save');
    click('nav-timer'); ctrl.evaluate();
    expect(clockText()).toBe('29:00');             // 현 세션 유지
  });

  test('test_AC13_1_localStorage_쓰기가_실패해도_타이머_사용이_중단되지_않고_저장실패_경고가_표시된다 (EC-05)', () => {
    const { ctrl, clock, backend } = bootApp();
    backend.failWrites = true;
    click('btn-start-pause');
    clock.advance(1000); ctrl.evaluate();
    expect($('storage-banner').hidden).toBe(false);
    expect(ctrl.getState().timer.status).toBe(RUNNING);
  });
});

/* ────────────────────────────── 13.2 System ────────────────────────────────── */
describe('13.2 System Acceptance', () => {
  test('test_AC13_2_정상실행중_시작_종료_기록_자동전환_다음세션_흐름이_끊김없이_동작한다', () => {
    const start = new Date(2026, 8, 7, 9, 0, 0).getTime();
    const { ctrl, clock } = bootApp({ start });

    click('btn-start-pause');                       // Focus 시작
    clock.advance(25 * MIN + 1); ctrl.evaluate();   // 만료 → 메모 대기
    expect(ctrl.getState().timer.memoPending).toBe(true);

    $('memo-input').value = '설계 문서 작성';
    click('btn-memo-submit');                       // 메모 저장 → ShortBreak 자동 시작
    let st = ctrl.getState();
    expect(st.timer.sessionType).toBe(SHORT_BREAK);
    expect(st.timer.status).toBe(RUNNING);

    clock.advance(5 * MIN + 1); ctrl.evaluate();    // Break 종료 → 다음 Focus 자동 시작
    st = ctrl.getState();
    expect(st.timer.sessionType).toBe(FOCUS);
    expect(st.timer.status).toBe(RUNNING);

    click('nav-log');
    expect($('log-count').textContent).toBe('1');
    const day = Core.getDailyLog(ctrl.getState().logs, '2026-09-07');
    expect(day.count).toBe(1);
    expect(day.memos[0].text).toBe('설계 문서 작성');
  });

  test('test_AC13_2_재접속복원_Running_만료_1회_종료처리_후_다음세션_Idle_수동시작_대기 (BR-02)', () => {
    const backend = makeBackend();
    const start = new Date(2026, 8, 7, 9, 0, 0).getTime();
    const { ctrl, clock } = bootApp({ backend, start });
    click('btn-start-pause');                       // Focus Running
    ctrl.stop();

    // 브라우저 완전 종료 상태로 3시간 경과 후 재접속
    const { ctrl: ctrl2 } = reload({ backend, start: clock.now() + 3 * 60 * MIN });
    expect(ctrl2.getState().timer.memoPending).toBe(true);

    click('btn-memo-skip');
    const st = ctrl2.getState();
    expect(st.timer.status).toBe(IDLE);             // 자동 시작 안 함
    expect(st.timer.sessionType).toBe(SHORT_BREAK);

    // 완료 1회만 기록
    expect(Core.getDailyLog(st.logs, '2026-09-07').count).toBe(1);

    // 사용자가 직접 시작해야 Running
    click('btn-start-pause');
    expect(ctrl2.getState().timer.status).toBe(RUNNING);
  });

  test('test_AC13_2_재접속복원_Paused_오프라인시간과_무관하게_스냅샷_유지_종료처리_없음 (EC-03)', () => {
    const backend = makeBackend();
    const start = new Date(2026, 8, 7, 9, 0, 0).getTime();
    const { ctrl, clock } = bootApp({ backend, start });
    click('btn-start-pause');
    clock.advance(10 * MIN); ctrl.evaluate();
    click('btn-start-pause');                       // Pause → 15:00
    ctrl.stop();

    const { ctrl: ctrl2 } = reload({ backend, start: start + 2 * 24 * 60 * MIN });
    const st = ctrl2.getState();
    expect(st.timer.status).toBe(PAUSED);
    expect(st.timer.remainingMsSnapshot).toBe(15 * MIN);
    expect(st.timer.memoPending).toBe(false);
  });

  test('test_AC13_2_스킵과_정상완료가_섞인_사이클에서_4번째_Focus슬롯_소모시_LongBreak로_전환된다 (BR-01, FR-04)', () => {
    const { ctrl, clock } = bootApp();
    function focusThen(action) {
      if (ctrl.getState().timer.status === IDLE) click('btn-start-pause');
      if (action === 'skip') { click('btn-skip'); return; }
      clock.advance(25 * MIN + 1); ctrl.evaluate();
      $('memo-input').value = ''; click('btn-memo-submit');
    }
    function passBreak() { clock.advance(20 * MIN + 1); ctrl.evaluate(); }

    focusThen('skip');   // slot 1 (skip Focus#1) → ShortBreak Running
    passBreak();          // → Focus
    focusThen('skip');   // slot 2
    passBreak();
    focusThen('done');   // slot 3, 완료 1
    passBreak();
    focusThen('done');   // slot 4 → LongBreak, 완료 2

    const st = ctrl.getState();
    expect(st.timer.sessionType).toBe(LONG_BREAK);
    expect(st.timer.focusSlotsConsumed).toBe(4);
    expect(Core.getDailyLog(st.logs, '2026-09-07').count).toBe(2);
  });
});

/* ────────────────────────────── 13.3 User ─────────────────────────────────── */
describe('13.3 User Acceptance (조작 사이 시간 경과 포함 사용자 시나리오)', () => {
  test('test_AC13_3_하루동안_실제사용시_로그화면의_완료개수와_각_메모가_실제_작업내역과_일치한다', () => {
    const start = new Date(2026, 8, 7, 9, 0, 0).getTime();
    const { ctrl, clock } = bootApp({ start });

    function completeFocus(memo) {
      if (ctrl.getState().timer.status === IDLE) click('btn-start-pause');
      clock.advance(25 * MIN + 1); ctrl.evaluate();      // 25분 집중
      expect(ctrl.getState().timer.memoPending).toBe(true);
      $('memo-input').value = memo; click('btn-memo-submit');
    }
    function shortBreak() { clock.advance(5 * MIN + 1); ctrl.evaluate(); }

    completeFocus('이메일 정리');
    shortBreak();
    clock.advance(90 * 1000);                            // 잠깐 자리 비움
    ctrl.evaluate();
    completeFocus('보고서 초안');
    shortBreak();

    // 점심: 2시간 자리 비움. 자동 시작된 Focus 를 리셋 후 오후에 재개.
    click('btn-reset');
    clock.advance(2 * 60 * MIN); ctrl.evaluate();
    completeFocus('');                                   // 오후엔 메모 없이 건너뛴 셈(빈 값)

    click('nav-log');
    expect($('log-count').textContent).toBe('3');
    const day = Core.getDailyLog(ctrl.getState().logs, '2026-09-07');
    expect(day.count).toBe(3);
    expect(day.memos.map((m) => Core.displayMemoText(m.text))).toEqual([
      '이메일 정리', '보고서 초안', '메모 없음'
    ]);
    expect(day.memos[0].completedAt).toBeLessThan(day.memos[1].completedAt);
    expect(day.memos[1].completedAt).toBeLessThan(day.memos[2].completedAt);
  });

  test('test_AC13_3_사용자가_임의_시점에_새로고침해도_진행중이던_세션_설정값_로그가_그대로_유지된다', () => {
    const backend = makeBackend();
    const start = new Date(2026, 8, 7, 14, 0, 0).getTime();
    const { ctrl, clock } = bootApp({ backend, start });

    click('nav-settings');
    $('set-focus').value = '20'; $('set-short').value = '10'; $('set-long').value = '15';
    click('btn-settings-save');
    click('nav-timer');

    click('btn-start-pause');
    clock.advance(20 * MIN + 1); ctrl.evaluate();        // Focus 완료
    $('memo-input').value = '리서치'; click('btn-memo-submit');  // 10분 ShortBreak 자동 시작
    clock.advance(8 * MIN); ctrl.evaluate();             // 8분 진행, 2분 남음
    ctrl.stop();

    const { ctrl: ctrl2, clock: clock2 } = reload({ backend, start: clock.now() + 500 });
    const after = ctrl2.getState();
    expect(after.settings).toEqual({ focusMin: 20, shortBreakMin: 10, longBreakMin: 15 });
    expect(after.timer.sessionType).toBe(SHORT_BREAK);
    expect(after.timer.status).toBe(RUNNING);
    const remain = Core.remainingMs(after.timer, clock2.now(), after.settings);
    expect(Math.abs(remain - 2 * MIN)).toBeLessThanOrEqual(1000);
    expect(Core.getDailyLog(after.logs, '2026-09-07').count).toBe(1);
  });

  test('test_AC13_3_시스템시계가_정상_유지되는_동안_수_시간_타이머를_켜둬도_표시된_남은시간이_실제_경과시간과_일치한다', () => {
    const start = new Date(2026, 8, 7, 8, 0, 0).getTime();
    const { ctrl, clock } = bootApp({ start });

    click('nav-settings');
    $('set-focus').value = '180'; $('set-short').value = '5'; $('set-long').value = '15';
    click('btn-settings-save');
    click('nav-timer');
    click('btn-start-pause');
    const endTs = ctrl.getState().timer.endTimestamp;

    // "수 시간" 을 5분 간격의 사용자 확인으로 나눠 진행 (총 175분).
    let elapsed = 0;
    for (let i = 0; i < 35; i++) {
      clock.advance(5 * MIN); elapsed += 5 * MIN;
      ctrl.evaluate();
      const shownMs = Core.remainingMs(ctrl.getState().timer, clock.now(), ctrl.getState().settings);
      expect(shownMs).toBe(endTs - clock.now());        // 절대시각 기준 — 드리프트 0
      expect(shownMs).toBe(180 * MIN - elapsed);
    }
    expect(ctrl.getState().timer.status).toBe(RUNNING); // 아직 만료 전
  });

  test('test_AC13_3_시스템시계가_임의로_변경되면_타이머가_늘거나_줄지_않고_일시정지되며_확인을_요청받는다', () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    const start = new Date(2026, 8, 7, 10, 0, 0).getTime();
    const { ctrl, clock } = bootApp({ start });

    click('btn-start-pause');
    clock.advance(3 * MIN); ctrl.evaluate();            // 정상 3분, 22분 남음
    const before = Core.remainingMs(ctrl.getState().timer, clock.now(), ctrl.getState().settings);
    expect(before).toBe(22 * MIN);

    clock.jumpDateOnly(60 * MIN);                       // 시스템 시계만 +1h
    ctrl.evaluate();

    const st = ctrl.getState();
    expect(st.timer.status).toBe(PAUSED);
    expect(alertSpy).toHaveBeenCalled();
    expect(Math.abs(st.timer.remainingMsSnapshot - before)).toBeLessThanOrEqual(1000);  // 연장/단축 없음
  });

  test('test_AC13_3_저장공간_문제로_데이터가_저장되지_않는_상황에서도_사용자는_경고를_통해_이를_인지한다 (EC-05)', () => {
    const { ctrl, clock, backend } = bootApp();
    backend.failWrites = true;

    click('btn-start-pause');
    clock.advance(1000); ctrl.evaluate();

    const banner = $('storage-banner');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/저장되지 않고 있습니다/);

    backend.failWrites = false;                         // 공간 회복 → 다음 상태 변경 시 자동 재시도
    click('btn-start-pause');                           // pause
    ctrl.evaluate();
    expect(banner.hidden).toBe(true);
  });
});
