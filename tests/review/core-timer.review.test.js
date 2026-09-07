/*
 * 독립 테스트 — 순수 로직 계층(src/core.js) 타이머/사이클/정확도
 *
 * 근거: PRD §4(FR-01·FR-03·FR-04), §5(BR-01·BR-03), §10(NFR-01), §12.2.
 * 개발 AI 자체 테스트(tests/dev/)를 참조하지 않고 PRD 명세와 core.js 공개 API 로만 구성.
 *
 * @jest-environment jsdom
 */
'use strict';

const { Core, MIN } = require('./_helpers');

const S = Core.defaultSettings();               // 25 / 5 / 15
const { FOCUS, SHORT_BREAK, LONG_BREAK } = Core.SESSION;
const { IDLE, RUNNING, PAUSED } = Core.STATUS;

function freshFocusRunning(now = 0, perf = 0) {
  let t = Core.createInitialTimer(S, now, perf);
  return Core.startTimer(t, S, now, perf);
}

describe('FR-01 타이머 시작/일시정지/리셋', () => {
  test('test_FR01_시작시_종료목표시각은_현재시각더하기_설정된_세션길이다', () => {
    const t = Core.startTimer(Core.createInitialTimer(S, 1_000, 0), S, 1_000, 0);
    expect(t.status).toBe(RUNNING);
    expect(t.endTimestamp).toBe(1_000 + 25 * MIN);
  });

  test('test_FR01_시작후_임의시점의_남은시간이_실제경과시간과_일치한다', () => {
    const t = freshFocusRunning(0, 0);
    // 임의(틱에 정렬되지 않은) 시점들
    expect(Core.remainingMs(t, 7_331, S)).toBe(25 * MIN - 7_331);
    expect(Core.remainingMs(t, 12 * MIN + 500, S)).toBe(25 * MIN - (12 * MIN + 500));
  });

  test('test_FR01_일시정지후_남은시간이_변하지_않는다', () => {
    const t = freshFocusRunning(0, 0);
    const paused = Core.pauseTimer(t, 10 * MIN);          // 15:00 남음
    expect(paused.status).toBe(PAUSED);
    expect(paused.remainingMsSnapshot).toBe(15 * MIN);
    // 시간이 더 흘러도 Paused 남은 시간은 스냅샷 그대로
    expect(Core.remainingMs(paused, 10 * MIN + 9 * MIN, S)).toBe(15 * MIN);
  });

  test('test_FR01_리셋시_설정된_세션길이의_Idle상태로_정확히_복귀한다', () => {
    const t = Core.pauseTimer(freshFocusRunning(0, 0), 3 * MIN);
    const r = Core.resetTimer(t, S);
    expect(r.status).toBe(IDLE);
    expect(r.endTimestamp).toBeNull();
    expect(Core.remainingMs(r, 999, S)).toBe(25 * MIN);
  });

  test('test_FR01_MemoInputPending상태에서_시작_일시정지_리셋_호출은_거부된다 (BR-04)', () => {
    // Focus 정상 만료 → Memo-Input-Pending
    const t = freshFocusRunning(0, 0);
    t.endTimestamp = 0;
    const pending = Core.completeExpiredSession(t, S, 0, 0).timer;
    expect(pending.memoPending).toBe(true);
    expect(() => Core.startTimer(pending, S, 0, 0)).toThrow();
    expect(() => Core.resetTimer(pending, S)).toThrow();
  });
});

describe('BR-03 리셋과 사이클 슬롯의 독립성', () => {
  test('test_BR03_3번째_Focus슬롯까지_소모된상태에서_4번째_Focus를_리셋해도_슬롯수는_3으로_유지된다', () => {
    let t = Core.createInitialTimer(S, 0, 0);
    t.focusSlotsConsumed = 3;
    t.sessionType = FOCUS;
    t = Core.startTimer(t, S, 0, 0);
    const r = Core.resetTimer(t, S);
    expect(r.focusSlotsConsumed).toBe(3);
    expect(r.status).toBe(IDLE);
  });
});

describe('FR-03 뽀모도로 사이클 자동 전환', () => {
  test('test_FR03_Focus_정상종료시_완료카운트귀속정보와_함께_MemoInputPending으로_전환된다', () => {
    const t = freshFocusRunning(1_000, 0);
    t.endTimestamp = 1_000 + 25 * MIN;
    const res = Core.completeExpiredSession(t, S, 1_000 + 25 * MIN, 0);
    expect(res.memoPending).toBe(true);
    expect(res.autoStarted).toBe(false);
    expect(res.completion).toEqual({
      dateKey: Core.dateKey(1_000 + 25 * MIN),
      completedAt: 1_000 + 25 * MIN
    });
    expect(res.timer.status).toBe(IDLE);          // 6.2: 기저 status 는 Idle
  });

  test('test_FR03_그외_Focus종료시_메모해소_후_ShortBreak로_전환된다', () => {
    const t = freshFocusRunning(0, 0); t.endTimestamp = 0;
    const pending = Core.completeExpiredSession(t, S, 0, 0).timer;
    const next = Core.resolveMemoAndAdvance(pending, S, 0, 0);
    expect(next.timer.sessionType).toBe(SHORT_BREAK);
    expect(next.autoStarted).toBe(true);
  });

  test('test_FR03_4번째_Focus슬롯_소모직후에는_반드시_LongBreak로_전환된다', () => {
    let t = Core.createInitialTimer(S, 0, 0);
    t.focusSlotsConsumed = 3; t.sessionType = FOCUS;
    t = Core.startTimer(t, S, 0, 0); t.endTimestamp = 0;
    const pending = Core.completeExpiredSession(t, S, 0, 0).timer;
    const next = Core.resolveMemoAndAdvance(pending, S, 0, 0);
    expect(next.timer.sessionType).toBe(LONG_BREAK);
    expect(next.timer.focusSlotsConsumed).toBe(4);
  });

  test('test_FR03_Break세션_종료후에는_메모입력없이_곧바로_다음_Focus가_자동시작된다', () => {
    let t = Core.makeRunningTimer(SHORT_BREAK, 2, S, 0, 0);
    t.endTimestamp = 0;
    const res = Core.completeExpiredSession(t, S, 0, 0);
    expect(res.memoPending).toBe(false);
    expect(res.autoStarted).toBe(true);
    expect(res.timer.sessionType).toBe(FOCUS);
    expect(res.timer.status).toBe(RUNNING);
  });
});

describe('FR-04 세션 건너뛰기 (Skip)', () => {
  test('test_FR04_Focus_스킵시_완료카운트도_메모입력도_요구하지_않는다', () => {
    const t = freshFocusRunning(0, 0);
    const res = Core.skipSession(t, S, 0, 0);
    expect(res.timer.memoPending).toBe(false);
    expect(res.timer.pendingCompletion).toBeNull();
    // 스킵 결과에는 완료 귀속 정보가 없다
    expect(res.completion).toBeUndefined();
  });

  test('test_FR04_Focus_스킵시에도_사이클_슬롯은_소모되어_LongBreak_도달순서에_반영된다', () => {
    const t = freshFocusRunning(0, 0);           // slots 0
    const res = Core.skipSession(t, S, 0, 0);
    expect(res.timer.focusSlotsConsumed).toBe(1);
  });

  test('test_FR04_MemoInputPending상태에서는_스킵할_수_없다 (BR-04)', () => {
    const t = freshFocusRunning(0, 0); t.endTimestamp = 0;
    const pending = Core.completeExpiredSession(t, S, 0, 0).timer;
    expect(() => Core.skipSession(pending, S, 0, 0)).toThrow();
  });

  test('test_FR04_Focus를_2회_스킵한_뒤_정상완료를_2회_채우면_총4슬롯_소모로_LongBreak_전환되고_완료카운트는_2다', () => {
    // §4 FR-04 Acceptance Criteria 2번의 시나리오를 실제 전이 함수로 재현.
    let timer = Core.startTimer(Core.createInitialTimer(S, 0, 0), S, 0, 0);
    let completions = 0;

    timer = Core.skipSession(timer, S, 0, 0).timer;      // Focus#1 스킵 → SB, slots 1
    expect(timer.sessionType).toBe(SHORT_BREAK);
    timer = Core.skipSession(timer, S, 0, 0).timer;      // SB 넘김 → Focus, slots 1
    timer = Core.skipSession(timer, S, 0, 0).timer;      // Focus#2 스킵 → SB, slots 2
    timer = Core.skipSession(timer, S, 0, 0).timer;      // SB 넘김 → Focus, slots 2

    timer.endTimestamp = 0;
    let res = Core.completeExpiredSession(timer, S, 0, 0); // Focus#3 완료
    if (res.completion) completions += 1;
    timer = Core.resolveMemoAndAdvance(res.timer, S, 0, 0).timer;  // → SB, slots 3
    timer = Core.skipSession(timer, S, 0, 0).timer;      // SB 넘김 → Focus, slots 3

    timer.endTimestamp = 0;
    res = Core.completeExpiredSession(timer, S, 0, 0);    // Focus#4 완료
    if (res.completion) completions += 1;
    timer = Core.resolveMemoAndAdvance(res.timer, S, 0, 0).timer;

    expect(timer.sessionType).toBe(LONG_BREAK);
    expect(timer.focusSlotsConsumed).toBe(4);
    expect(completions).toBe(2);
  });
});

describe('BR-01 세션 순서 및 완료 카운트 규칙', () => {
  test('test_BR01_세션은_Focus_ShortBreak_반복하다_4번째_Focus후_LongBreak_그다음_Focus로_재시작한다', () => {
    // advanceCycle 을 연쇄 적용하여 한 사이클 + 다음 사이클 첫 세션까지의 순서를 확인.
    const seq = [];
    let type = FOCUS;
    let slots = 0;
    for (let i = 0; i < 9; i++) {
      seq.push(type);
      const adv = Core.advanceCycle(type, slots);
      type = adv.sessionType;
      slots = adv.focusSlotsConsumed;
    }
    expect(seq).toEqual([
      FOCUS, SHORT_BREAK, FOCUS, SHORT_BREAK, FOCUS, SHORT_BREAK, FOCUS, LONG_BREAK, FOCUS
    ]);
  });

  test('test_BR01_LongBreak가_스킵된_경우에도_사이클이_초기화되어_Focus부터_슬롯0으로_재시작한다', () => {
    const t = Core.makeRunningTimer(LONG_BREAK, 4, S, 0, 0);
    const res = Core.skipSession(t, S, 0, 0);
    expect(res.timer.sessionType).toBe(FOCUS);
    expect(res.timer.focusSlotsConsumed).toBe(0);
  });

  test('test_BR01_하루_완료개수는_정상종료된_Focus에만_1증가하고_스킵된_Focus는_포함되지_않는다', () => {
    let logs = Core.emptyLogs();
    const key = '2026-09-07';
    // 스킵된 Focus: completion 정보가 없으므로 로그에 반영되지 않는다.
    const skipRes = Core.skipSession(Core.startTimer(Core.createInitialTimer(S, 0, 0), S, 0, 0), S, 0, 0);
    expect(skipRes.completion).toBeUndefined();
    // 정상 종료 Focus 1회만 반영
    logs = Core.addCompletion(logs, key, Date.parse('2026-09-07T09:25:00'), '작업A');
    expect(Core.getDailyLog(logs, key).count).toBe(1);
  });
});

describe('NFR-01 타이머 정확도 (절대시각 기반, 드리프트 0)', () => {
  test('test_NFR01_장시간_연속구동시_표시_남은시간과_실제경과시간간_누적오차가_없다', () => {
    const bigSettings = { focusMin: 180, shortBreakMin: 5, longBreakMin: 15 };
    const startNow = Date.parse('2026-09-07T09:00:00');
    let t = Core.createInitialTimer(bigSettings, startNow, 0);
    t = Core.startTimer(t, bigSettings, startNow, 0);
    const endTs = t.endTimestamp;

    // 3시간에 가깝게, 틱에 정렬되지 않은 간격(137ms)으로 누적 진행.
    let elapsed = 0;
    for (let i = 0; i < 60_000; i++) {
      elapsed += 137;
      const nowMs = startNow + elapsed;
      // 절대시각 계산이므로 매 시점 정확히 endTs - now 여야 한다(카운터 감산 누적오차 없음).
      expect(Core.remainingMs(t, nowMs, bigSettings)).toBe(endTs - nowMs);
    }
    // 총 경과 ≈ 2시간 17분. 아직 만료 전이며 오차 0.
    expect(elapsed).toBe(60_000 * 137);
    expect(Core.remainingMs(t, startNow + elapsed, bigSettings)).toBe(180 * MIN - elapsed);
  });
});

/* ── 커밋 코드 기반(INT): 직전 커밋이 바꾼 슬롯 소모 시점 회귀 방지 ──────────────
 * git diff HEAD~1 HEAD -- index.html: completeExpiredSession/restoreTimer 의 Focus 만료
 * 분기에서 focusSlotsConsumed 를 더 이상 미리 +1 하지 않고, 슬롯 소모를
 * resolveMemoAndAdvance→advanceCycle 한 곳에서만 1회 수행하도록 변경됨.
 */
describe('INT 슬롯 소모는 메모 해소 시 정확히 1회만 (완료 경로 회귀)', () => {
  test('test_INT_completeExpiredSession_반환timer의_focusSlotsConsumed는_메모해소_전까지_증가하지_않는다', () => {
    let t = Core.startTimer(Core.createInitialTimer(S, 0, 0), S, 0, 0); // slots 0
    t.endTimestamp = 0;
    const res = Core.completeExpiredSession(t, S, 0, 0);
    expect(res.timer.focusSlotsConsumed).toBe(0);   // 미리 증가 안 함
  });

  test('test_INT_Focus만료_후_메모해소까지_슬롯은_정확히_1회만_소모된다_slots0에서_1', () => {
    let t = Core.startTimer(Core.createInitialTimer(S, 0, 0), S, 0, 0);
    t.endTimestamp = 0;
    const pending = Core.completeExpiredSession(t, S, 0, 0).timer;
    const after = Core.resolveMemoAndAdvance(pending, S, 0, 0);
    expect(after.timer.focusSlotsConsumed).toBe(1);          // 2 가 되면 이중 소모(회귀)
    expect(after.timer.sessionType).toBe(SHORT_BREAK);       // slots 2 였다면 LongBreak 로 샜을 것
  });
});
