'use strict';

/*
 * PRD 5. Business / System Rules — BR-01 ~ BR-04.
 * 비즈니스 규칙이 누락·왜곡 없이 구현되었는지 검증한다.
 */

const { boot, finishRunning, run, isHidden, makeMemoryStorage, dateKeyLocal } = require('./helpers/harness');
const H = require('./helpers/harness');

// ───────────────────────── BR-01 세션 순서 및 완료 카운트 규칙 ─────────────────────────

describe('BR-01 세션 순서 및 완료 카운트', () => {
  test('test_BR01_세션순서_Focus_Short_반복_4번째후_Long_이후_Focus재시작', () => {
    const { P, clock } = boot();
    P.start();
    const seq = [];
    // 8개 세션 전이를 스킵으로 강제 관찰
    for (let i = 0; i < 8; i++) {
      seq.push(P.getState().sessionType);
      P.skip();
    }
    seq.push(P.getState().sessionType);
    expect(seq).toEqual([
      'Focus', 'ShortBreak', 'Focus', 'ShortBreak',
      'Focus', 'ShortBreak', 'Focus', 'LongBreak', 'Focus',
    ]);
  });

  test('test_BR01_LongBreak_스킵되어도_사이클_초기화되어_Focus부터_재시작', () => {
    const { P } = boot();
    P.start();
    for (let i = 0; i < 7; i++) P.skip(); // Focus x4 + ShortBreak x3 → LongBreak
    expect(P.getState().sessionType).toBe('LongBreak');
    expect(P.getState().focusSlotsConsumed).toBe(4);
    P.skip(); // LongBreak 스킵
    expect(P.getState().sessionType).toBe('Focus');
    expect(P.getState().focusSlotsConsumed).toBe(0);
  });

  test('test_BR01_완료개수는_시간만료로_종료된_Focus에만_증가_스킵은_제외', () => {
    const { P, clock } = boot();
    P.start();
    P.skip();                     // Focus 스킵 → 카운트 0
    finishRunning(P, clock);      // ShortBreak 종료 → Focus 자동
    finishRunning(P, clock);      // Focus 정상 종료 → 카운트 1, memo
    P.submitMemo('정상완료');
    expect(P.getLog().count).toBe(1);
  });

  test('test_BR01_Focus슬롯은_완료_스킵_무관하게_소모_4번째_소모시_LongBreak', () => {
    const { P, clock } = boot();
    P.start();
    P.skip();                    // slot 1 (스킵)
    P.skip();                    // ShortBreak→Focus
    finishRunning(P, clock);     // slot 2 (완료) → memo
    P.submitMemo('a');
    finishRunning(P, clock);     // ShortBreak→Focus
    P.skip();                    // slot 3 (스킵)
    P.skip();                    // ShortBreak→Focus
    finishRunning(P, clock);     // slot 4 (완료) → memo
    P.submitMemo('b');
    expect(P.getState().focusSlotsConsumed).toBe(4);
    expect(P.getState().sessionType).toBe('LongBreak');
  });
});

// ───────────────────────── BR-02 자동 시작의 적용 범위 ─────────────────────────

describe('BR-02 자동 시작의 적용 범위', () => {
  test('test_BR02_실시간_사용중_Break종료시_다음Focus_자동시작', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock); P.submitMemo('m'); // → ShortBreak Running
    finishRunning(P, clock);                     // ShortBreak 종료
    expect(P.getState().sessionType).toBe('Focus');
    expect(P.getState().sessionStatus).toBe('Running'); // 자동 시작됨
  });

  test('test_BR02_재접속으로_복원된_만료세션은_자동시작하지_않고_Idle대기', () => {
    const now = Date.UTC(2026, 8, 7, 12, 0, 0);
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'Focus', sessionStatus: 'Running',
        endTimestamp: now - 30 * 60000, remainingSnapshot: null, focusSlotsConsumed: 2,
        dateAnchor: now - 55 * 60000, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(now) });
    expect(P.getState().memoPending).toBe(true); // Focus 1회 종료 처리
    P.submitMemo('복원');
    expect(P.getState().sessionStatus).toBe('Idle'); // 자동 시작 아님
  });

  test('test_BR02_재접속_복원_직후에는_사용자_시작조작을_필요로_한다', () => {
    const now = Date.UTC(2026, 8, 7, 12, 0, 0);
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'ShortBreak', sessionStatus: 'Running',
        endTimestamp: now - 5 * 60000, remainingSnapshot: null, focusSlotsConsumed: 1,
        dateAnchor: now - 10 * 60000, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(now) });
    expect(P.getState().sessionStatus).toBe('Idle');
    P.start();
    expect(P.getState().sessionStatus).toBe('Running'); // 직접 시작하면 진행
  });
});

// ───────────────────────── BR-03 리셋과 사이클 슬롯의 독립성 ─────────────────────────

describe('BR-03 리셋과 사이클 슬롯의 독립성', () => {
  test('test_BR03_리셋은_현재세션_타이머만_초기화하고_슬롯소모수는_유지', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock); P.submitMemo('a'); // slot 1, ShortBreak Running
    finishRunning(P, clock);                     // Focus Running
    finishRunning(P, clock); P.submitMemo('b'); // slot 2, ShortBreak Running
    finishRunning(P, clock);                     // Focus Running
    expect(P.getState().focusSlotsConsumed).toBe(2);
    run(P, clock, 3 * 60000, 1000);
    P.reset();
    expect(P.getState().focusSlotsConsumed).toBe(2); // 리셋 영향 없음
    expect(P.getState().sessionStatus).toBe('Idle');
  });
});

// ───────────────────────── BR-04 Memo-Input-Pending 상태의 조작 제한 ─────────────────────────

describe('BR-04 Memo-Input-Pending 상태의 조작 제한', () => {
  function toMemo() {
    const ctx = boot();
    ctx.P.start();
    finishRunning(ctx.P, ctx.clock);
    return ctx;
  }

  test('test_BR04_타이머제어버튼_시작_일시정지_리셋_스킵_모두_미노출', () => {
    toMemo();
    expect(isHidden('timer-controls')).toBe(true);
    expect(isHidden('memo-panel')).toBe(false);
  });

  test('test_BR04_이상태에서_start_pause_reset_skip_호출은_무시된다', () => {
    const { P } = toMemo();
    const before = JSON.stringify(P.getState());
    P.start();
    P.pause();
    P.reset();
    P.skip();
    const after = P.getState();
    expect(after.memoPending).toBe(true);
    expect(after.ui).toBe('memo');
    expect(after.sessionStatus).toBe('Idle');
    expect(JSON.stringify(after)).toBe(before);
  });

  test('test_BR04_메모_제출_또는_건너뛰기로만_상태를_벗어난다', () => {
    const { P } = toMemo();
    P.submitMemo('탈출');
    expect(P.getState().memoPending).toBe(false);
    expect(P.getState().ui).toBe('timer');
  });
});
