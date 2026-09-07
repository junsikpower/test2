'use strict';

/*
 * PRD 13. Acceptance Criteria.
 *   13.1 Functional  — 개별 기능 단위
 *   13.2 System      — 둘 이상의 기능이 함께 동작하는 통합 시나리오
 *   13.3 User        — 사용자의 실제 사용 흐름을 처음부터 끝까지 재현 (조작 사이 시간 경과 포함)
 */

const { boot, finishRunning, run, $, isHidden, makeMemoryStorage, makeFailingStorage } = require('./helpers/harness');
const H = require('./helpers/harness');

const okAudio = () => ({ unlock: jest.fn(() => Promise.resolve()), beep: jest.fn(() => Promise.resolve()) });
const grantedNotif = () => ({ permission: 'granted', show: jest.fn(), request: jest.fn(() => Promise.resolve('granted')) });

// ═════════════════════════ 13.1 Functional Acceptance ═════════════════════════

describe('13.1 Functional Acceptance', () => {
  test('test_AC13_1_Paused상태_새로고침해도_남은시간_스냅샷_오프라인시간과_무관하게_복원', () => {
    const savedAt = Date.UTC(2026, 8, 7, 9, 0, 0);
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'Focus', sessionStatus: 'Paused',
        endTimestamp: null, remainingSnapshot: 11 * 60000, focusSlotsConsumed: 1,
        dateAnchor: savedAt, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(savedAt + 8 * 3600 * 1000) });
    expect(P.getState().sessionStatus).toBe('Paused');
    expect(P.getState().remainingMs).toBe(11 * 60000);
  });

  test('test_AC13_1_MemoInputPending에서는_타이머제어버튼_미노출_메모UI만_노출', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock);
    expect(isHidden('timer-controls')).toBe(true);
    expect(isHidden('memo-panel')).toBe(false);
    expect($('memo-input')).not.toBeNull();
    expect($('btn-memo-submit')).not.toBeNull();
    expect($('btn-memo-skip')).not.toBeNull();
  });

  test('test_AC13_1_Idle세션_설정변경은_즉시_반영_RunningPaused는_다음세션부터', () => {
    const { P, clock } = boot();
    // Idle 즉시
    P.saveSettings({ focusMin: 30, shortBreakMin: 6, longBreakMin: 15 });
    expect(P.getState().remainingMs).toBe(30 * 60000);
    // Running 지연
    P.start();
    clock.advance(60000); P.tick();
    P.saveSettings({ focusMin: 45, shortBreakMin: 6, longBreakMin: 15 });
    expect(P.getState().remainingMs).toBe(29 * 60000);
  });

  test('test_AC13_1_localStorage_쓰기실패해도_타이머_사용_중단없이_경고표시', () => {
    const { P, clock } = boot({ storage: makeFailingStorage() });
    P.start();
    run(P, clock, 5 * 60000, 1000);
    expect(P.getState().sessionStatus).toBe('Running');
    expect(P.getState().remainingMs).toBe(20 * 60000);
    expect(isHidden('storage-warning')).toBe(false);
  });
});

// ═════════════════════════ 13.2 System Acceptance ═════════════════════════

describe('13.2 System Acceptance', () => {
  test('test_AC13_2_정상실행중_시작_종료_기록_자동전환_다음세션_흐름이_끊김없이_동작', () => {
    const { P, clock } = boot({ audio: okAudio(), notification: grantedNotif() });
    // 시작
    P.start();
    expect(P.getState().sessionType).toBe('Focus');
    expect(P.getState().sessionStatus).toBe('Running');
    // 25분 경과 → 종료 → 기록(메모)
    run(P, clock, 20 * 60000, 60000);
    finishRunning(P, clock);
    expect(P.getState().ui).toBe('memo');
    P.submitMemo('통합 시나리오 작업');
    expect(P.getLog().count).toBe(1);
    // 자동 전환 → ShortBreak 자동 시작
    expect(P.getState().sessionType).toBe('ShortBreak');
    expect(P.getState().sessionStatus).toBe('Running');
    // ShortBreak 종료 → 메모 없이 다음 Focus 자동 시작
    finishRunning(P, clock);
    expect(P.getState().sessionType).toBe('Focus');
    expect(P.getState().sessionStatus).toBe('Running');
    // 스킵으로 다음 세션 즉시 이동
    P.skip();
    expect(P.getState().sessionType).toBe('ShortBreak');
    // 로그/설정 연동 확인
    P.setView('log');
    expect($('log-count').textContent).toBe('1');
    P.setView('settings');
    P.saveSettings({ focusMin: 20, shortBreakMin: 5, longBreakMin: 15 });
    expect(P.getState().settings.focusMin).toBe(20);
  });

  test('test_AC13_2_재접속_복원_Running_경우_1회종료처리_후_다음세션_수동시작', () => {
    const now = Date.UTC(2026, 8, 7, 14, 0, 0);
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'Focus', sessionStatus: 'Running',
        endTimestamp: now - 20 * 60000, remainingSnapshot: null, focusSlotsConsumed: 0,
        dateAnchor: now - 45 * 60000, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(now) });
    expect(P.getState().memoPending).toBe(true);
    expect(P.getLog(H.dateKeyLocal(now - 20 * 60000)).count).toBe(1);
    P.submitMemo('복원 후');
    expect(P.getState().sessionStatus).toBe('Idle'); // 자동 시작 아님 (BR-02, 의도된 예외)
    P.start();
    expect(P.getState().sessionStatus).toBe('Running');
  });

  test('test_AC13_2_재접속_복원_Paused_경우_남은시간_그대로_종료처리되지_않음', () => {
    const savedAt = Date.UTC(2026, 8, 7, 14, 0, 0);
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'ShortBreak', sessionStatus: 'Paused',
        endTimestamp: null, remainingSnapshot: 3 * 60000, focusSlotsConsumed: 2,
        dateAnchor: savedAt, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(savedAt + 6 * 3600 * 1000) });
    expect(P.getState().sessionStatus).toBe('Paused');
    expect(P.getState().sessionType).toBe('ShortBreak');
    expect(P.getState().remainingMs).toBe(3 * 60000);
    expect(P.getLog().count).toBe(0); // 종료 처리 없음
  });
});

// ═════════════════════════ 13.3 User Acceptance ═════════════════════════

describe('13.3 User Acceptance', () => {
  test('test_AC13_3_하루_사용흐름_로그의_완료개수와_각_메모가_실제_작업내역과_일치', () => {
    const { P, clock } = boot({ audio: okAudio(), notification: grantedNotif() });
    const notes = ['이메일 정리', '', '설계 문서', '코드 리뷰'];
    P.start();
    for (let i = 0; i < notes.length; i++) {
      // 집중 25분 (조작 사이 시간 경과)
      run(P, clock, 24 * 60000, 5 * 60000);
      finishRunning(P, clock);
      // 사용자가 20초 고민 후 메모 제출
      clock.advance(20000);
      P.submitMemo(notes[i]);
      // 휴식을 실제로 흘려보냄
      finishRunning(P, clock);
      // 다음 Focus 전 잠깐 자리비움
      clock.advance(90000); P.tick();
    }
    const log = P.getLog();
    expect(log.count).toBe(4);
    expect(log.memos.map((m) => m.text)).toEqual(['이메일 정리', '', '설계 문서', '코드 리뷰']);
    // 빈 메모는 화면에서 '메모 없음'
    P.setView('log');
    const items = $('log-memos').querySelectorAll('li');
    expect(items.length).toBe(4);
    expect(items[1].textContent).toContain('메모 없음');
  });

  test('test_AC13_3_임의시점_새로고침_브라우저재시작해도_세션_설정_로그_유지', () => {
    const storage = makeMemoryStorage();
    let ctx = boot({ storage });
    ctx.P.saveSettings({ focusMin: 20, shortBreakMin: 5, longBreakMin: 15 });
    ctx.P.start();
    // 두 번의 집중 완료 + 메모
    run(ctx.P, ctx.clock, 19 * 60000, 60000);
    finishRunning(ctx.P, ctx.clock);
    ctx.clock.advance(15000);
    ctx.P.submitMemo('저장 전 작업 1');
    finishRunning(ctx.P, ctx.clock); // ShortBreak 종료 → Focus Running
    run(ctx.P, ctx.clock, 8 * 60000, 60000); // 12분 남은 시점

    const remBefore = ctx.P.getState().remainingMs;
    const slotsBefore = ctx.P.getState().focusSlotsConsumed;

    // 브라우저 재시작: 같은 저장소 + 같은 시각
    ctx = boot({ storage, clock: ctx.clock });
    expect(ctx.P.getState().sessionType).toBe('Focus');
    expect(ctx.P.getState().sessionStatus).toBe('Running');
    expect(ctx.P.getState().remainingMs).toBe(remBefore);
    expect(ctx.P.getState().focusSlotsConsumed).toBe(slotsBefore);
    expect(ctx.P.getState().settings.focusMin).toBe(20);
    expect(ctx.P.getLog().count).toBe(1);
    expect(ctx.P.getLog().memos[0].text).toBe('저장 전 작업 1');
  });

  test('test_AC13_3_수시간_타이머를_켜둬도_표시된_남은시간이_실제경과와_일치', () => {
    const { P, clock } = boot();
    P.saveSettings({ focusMin: 180, shortBreakMin: 5, longBreakMin: 15 });
    P.start();
    // 2시간 55분을 다양한 간격으로 경과
    for (const step of [37 * 60000, 41 * 60000, 5 * 60000, 52 * 60000, 20 * 60000]) {
      run(P, clock, step, 60000);
    }
    // 총 155분 경과 → 25분 남음
    expect(P.getState().remainingMs).toBe(25 * 60000);
  });

  test('test_AC13_3_시스템시계_임의변경시_타이머가_늘거나_줄지않고_일시정지되고_확인요청', () => {
    const { P, clock } = boot();
    P.start();
    run(P, clock, 3 * 60000, 30000);
    const remBefore = P.getState().remainingMs;
    // 사용자가 시스템 시계를 1시간 앞당김
    clock.jumpWall(60 * 60000);
    P.tick();
    expect(P.getState().sessionStatus).toBe('Paused');
    expect(isHidden('clock-modal')).toBe(false);
    expect(P.getState().remainingMs).toBe(remBefore); // 늘지도 줄지도 않음
    // 확인(재개) 후에만 진행
    P.resumeAfterClockChange();
    expect(P.getState().sessionStatus).toBe('Running');
  });

  test('test_AC13_3_저장공간_문제로_저장이_안되는_상황에서_사용자가_경고로_인지', () => {
    const { P } = boot({ storage: makeFailingStorage() });
    P.start();
    expect(isHidden('storage-warning')).toBe(false);
    expect($('storage-warning').textContent.length).toBeGreaterThan(0);
  });
});
