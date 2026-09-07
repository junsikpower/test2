/*
 * 자체 테스트 — 뽀모도로 사이클 자동 전환 (FR-03), 세션 건너뛰기 (FR-04),
 * 세션 순서 및 완료 카운트 규칙 (BR-01)
 *
 * 대상: src/core.js
 */
'use strict';

const Core = require('../../src/core.js');
const MIN = Core.MS_PER_MIN;
const S = () => Core.defaultSettings();

/** Focus-Running 타이머를 만들어 즉시 만료시킨다. */
function expiredFocus(slots, now) {
  const s = S();
  let t = Core.startTimer(Core.createInitialTimer(s, 0, 0), s, 0, 0);
  t = Core.copyTimer(t);
  t.focusSlotsConsumed = slots;
  t.endTimestamp = now - 1;
  return t;
}
function expiredBreak(type, slots, now) {
  const s = S();
  let t = Core.createInitialTimer(s, 0, 0);
  t = Core.copyTimer(t);
  t.sessionType = type;
  t.focusSlotsConsumed = slots;
  t.status = Core.STATUS.RUNNING;
  t.endTimestamp = now - 1;
  return t;
}

describe('FR-03 / BR-01 사이클 자동 전환', () => {
  test('test_FR03_Focus_정상종료시_완료카운트_증가신호와_MemoInputPending_전환', () => {
    const res = Core.completeExpiredSession(expiredFocus(0, 1000), S(), 1000, 10);
    expect(res.memoPending).toBe(true);
    expect(res.completion).toEqual({ dateKey: Core.dateKey(999), completedAt: 999 });
    expect(res.timer.memoPending).toBe(true);
    // MemoInputPending 의 기저 상태는 Idle (6.2)
    expect(res.timer.status).toBe(Core.STATUS.IDLE);
    // 다음 세션 타이머는 아직 시작되지 않음
    expect(res.autoStarted).toBe(false);
  });

  test('test_FR03_1~3번째_Focus_종료후_메모해소시_ShortBreak로_전환된다', () => {
    for (const slotsBefore of [0, 1, 2]) {
      const done = Core.completeExpiredSession(expiredFocus(slotsBefore, 1000), S(), 1000, 10);
      const adv = Core.resolveMemoAndAdvance(done.timer, S(), 1100, 20);
      expect(adv.timer.sessionType).toBe(Core.SESSION.SHORT_BREAK);
      expect(adv.timer.focusSlotsConsumed).toBe(slotsBefore + 1);
    }
  });

  test('test_FR03_4번째_Focus슬롯_소모_직후에는_반드시_LongBreak로_전환된다', () => {
    const done = Core.completeExpiredSession(expiredFocus(3, 1000), S(), 1000, 10);
    const adv = Core.resolveMemoAndAdvance(done.timer, S(), 1100, 20);
    expect(adv.timer.sessionType).toBe(Core.SESSION.LONG_BREAK);
    expect(adv.timer.focusSlotsConsumed).toBe(4);
  });

  test('test_FR03_Break_종료후에는_메모입력없이_곧바로_다음Focus가_자동시작된다', () => {
    const res = Core.completeExpiredSession(expiredBreak(Core.SESSION.SHORT_BREAK, 2, 5000), S(), 5000, 30);
    expect(res.memoPending).toBe(false);
    expect(res.completion).toBeNull();
    expect(res.autoStarted).toBe(true);
    expect(res.timer.sessionType).toBe(Core.SESSION.FOCUS);
    expect(res.timer.status).toBe(Core.STATUS.RUNNING);
    expect(res.timer.endTimestamp).toBe(5000 + 25 * MIN);
  });

  test('test_BR01_LongBreak_종료시_사이클이_초기화되어_슬롯수가_0으로_재시작된다', () => {
    const res = Core.completeExpiredSession(expiredBreak(Core.SESSION.LONG_BREAK, 4, 9000), S(), 9000, 40);
    expect(res.timer.sessionType).toBe(Core.SESSION.FOCUS);
    expect(res.timer.focusSlotsConsumed).toBe(0);
  });

  test('test_BR01_세션순서_F_SB_F_SB_F_SB_F_LB_로_반복된다', () => {
    const s = S();
    let now = 1000;
    let timer = Core.startTimer(Core.createInitialTimer(s, now, 0), s, now, 0);
    const seen = [];
    for (let i = 0; i < 8; i++) {
      timer = Core.copyTimer(timer);
      timer.status = Core.STATUS.RUNNING;
      timer.endTimestamp = now;
      now += 1000;
      const res = Core.completeExpiredSession(timer, s, now, 0);
      seen.push(res.timer.memoPending ? 'Focus-done' : res.timer.sessionType);
      if (res.timer.memoPending) {
        const adv = Core.resolveMemoAndAdvance(res.timer, s, now, 0);
        seen[seen.length - 1] = adv.timer.sessionType; // 다음 세션 타입 기록
        timer = adv.timer;
      } else {
        timer = res.timer;
      }
    }
    expect(seen).toEqual([
      'ShortBreak', 'Focus', 'ShortBreak', 'Focus',
      'ShortBreak', 'Focus', 'LongBreak', 'Focus'
    ]);
  });
});

describe('FR-04 세션 건너뛰기 (Skip)', () => {
  test('test_FR04_Focus_스킵시_완료카운트는_증가하지_않고_메모도_요구하지_않는다', () => {
    const s = S();
    let t = Core.startTimer(Core.createInitialTimer(s, 0, 0), s, 0, 0);
    const res = Core.skipSession(t, s, 1000, 10);
    expect(res.timer.memoPending).toBe(false);
    expect(res).not.toHaveProperty('completion');
    // 다음 세션으로 즉시 전환·시작
    expect(res.timer.status).toBe(Core.STATUS.RUNNING);
    expect(res.timer.sessionType).toBe(Core.SESSION.SHORT_BREAK);
  });

  test('test_FR04_Focus_스킵도_사이클_Focus슬롯은_소모된_것으로_계산된다', () => {
    const s = S();
    let t = Core.startTimer(Core.createInitialTimer(s, 0, 0), s, 0, 0);
    const res = Core.skipSession(t, s, 1000, 10);
    expect(res.timer.focusSlotsConsumed).toBe(1);
  });

  test('test_FR04_Focus를_2회_스킵후_정상완료_2회면_총4슬롯소모로_LongBreak_전환_완료카운트는_2', () => {
    const s = S();
    let now = 0;
    let timer = Core.startTimer(Core.createInitialTimer(s, now, 0), s, now, 0);
    let completedCount = 0;

    // 1) Focus 스킵
    timer = Core.skipSession(timer, s, ++now, 0).timer; // -> ShortBreak, slots 1
    // 2) ShortBreak 스킵
    timer = Core.skipSession(timer, s, ++now, 0).timer; // -> Focus, slots 1
    // 3) Focus 스킵
    timer = Core.skipSession(timer, s, ++now, 0).timer; // -> ShortBreak, slots 2
    // 4) ShortBreak 스킵
    timer = Core.skipSession(timer, s, ++now, 0).timer; // -> Focus, slots 2

    // 5) Focus 정상완료
    timer = Core.copyTimer(timer); timer.status = Core.STATUS.RUNNING; timer.endTimestamp = now;
    let res = Core.completeExpiredSession(timer, s, ++now, 0);
    if (res.completion) completedCount++;
    timer = Core.resolveMemoAndAdvance(res.timer, s, now, 0).timer; // -> ShortBreak, slots 3

    // 6) ShortBreak 정상완료
    timer = Core.copyTimer(timer); timer.status = Core.STATUS.RUNNING; timer.endTimestamp = now;
    timer = Core.completeExpiredSession(timer, s, ++now, 0).timer; // -> Focus, slots 3

    // 7) Focus 정상완료 → 4번째 슬롯 소모
    timer = Core.copyTimer(timer); timer.status = Core.STATUS.RUNNING; timer.endTimestamp = now;
    res = Core.completeExpiredSession(timer, s, ++now, 0);
    if (res.completion) completedCount++;
    timer = Core.resolveMemoAndAdvance(res.timer, s, now, 0).timer;

    expect(timer.sessionType).toBe(Core.SESSION.LONG_BREAK);
    expect(timer.focusSlotsConsumed).toBe(4);
    expect(completedCount).toBe(2);
  });

  test('test_FR04_Break_스킵시_다음_Focus로_전환된다', () => {
    const s = S();
    let t = Core.createInitialTimer(s, 0, 0);
    t = Core.copyTimer(t);
    t.sessionType = Core.SESSION.SHORT_BREAK;
    t.status = Core.STATUS.RUNNING;
    t.endTimestamp = 10 * MIN;
    const res = Core.skipSession(t, s, 1000, 10);
    expect(res.timer.sessionType).toBe(Core.SESSION.FOCUS);
  });

  test('test_FR04_LongBreak_스킵시에도_사이클이_초기화되어_Focus부터_재시작된다', () => {
    const s = S();
    let t = Core.createInitialTimer(s, 0, 0);
    t = Core.copyTimer(t);
    t.sessionType = Core.SESSION.LONG_BREAK;
    t.status = Core.STATUS.RUNNING;
    t.endTimestamp = 10 * MIN;
    t.focusSlotsConsumed = 4;
    const res = Core.skipSession(t, s, 1000, 10);
    expect(res.timer.sessionType).toBe(Core.SESSION.FOCUS);
    expect(res.timer.focusSlotsConsumed).toBe(0);
  });
});
