/*
 * 자체 테스트 — 타이머 제어 (FR-01), 설정 적용 시점 (FR-07),
 * 리셋/슬롯 독립성 (BR-03), 타이머 정확도 (NFR-01)
 *
 * 대상: src/core.js (순수 로직). now/perfNow 는 인자로 주입한다.
 */
'use strict';

const Core = require('../../src/core.js');

const MIN = Core.MS_PER_MIN;

function freshSettings() {
  return Core.defaultSettings(); // focus 25 / short 5 / long 15
}

describe('FR-01 타이머 시작/일시정지/리셋', () => {
  test('test_FR01_시작시_종료목표시각은_현재시각더하기남은시간', () => {
    const s = freshSettings();
    let t = Core.createInitialTimer(s, 1_000_000, 500);
    t = Core.startTimer(t, s, 1_000_000, 500);
    expect(t.status).toBe(Core.STATUS.RUNNING);
    expect(t.endTimestamp).toBe(1_000_000 + 25 * MIN);
  });

  test('test_FR01_일시정지시_남은시간이_고정되고_endTimestamp가_제거된다', () => {
    const s = freshSettings();
    let t = Core.startTimer(Core.createInitialTimer(s, 0, 0), s, 0, 0);
    // 10분 경과 시점에 일시정지
    t = Core.pauseTimer(t, 10 * MIN);
    expect(t.status).toBe(Core.STATUS.PAUSED);
    expect(t.endTimestamp).toBeNull();
    expect(t.remainingMsSnapshot).toBe(15 * MIN);
    // 일시정지 후 시간이 더 흘러도 남은 시간은 그대로
    expect(Core.remainingMs(t, 10 * MIN + 9999 * MIN, s)).toBe(15 * MIN);
  });

  test('test_FR01_리셋시_설정된_세션길이의_Idle상태로_복귀한다', () => {
    const s = freshSettings();
    let t = Core.startTimer(Core.createInitialTimer(s, 0, 0), s, 0, 0);
    t = Core.pauseTimer(t, 3 * MIN);
    t = Core.resetTimer(t, s);
    expect(t.status).toBe(Core.STATUS.IDLE);
    expect(t.endTimestamp).toBeNull();
    expect(Core.remainingMs(t, 12345, s)).toBe(25 * MIN);
  });

  test('test_FR01_시작후_임의시점의_남은시간이_실제경과시간과_일치한다', () => {
    const s = freshSettings();
    const startNow = 1_700_000_000_000;
    let t = Core.startTimer(Core.createInitialTimer(s, startNow, 0), s, startNow, 0);
    const elapsed = 7 * MIN + 23 * 1000;
    expect(Core.remainingMs(t, startNow + elapsed, s)).toBe(25 * MIN - elapsed);
  });

  test('test_BR03_3슬롯소모상태에서_4번째Focus를_리셋해도_슬롯수는_3으로_유지된다', () => {
    const s = freshSettings();
    let t = Core.createInitialTimer(s, 0, 0);
    t = Core.copyTimer(t);
    t.focusSlotsConsumed = 3;
    t = Core.startTimer(t, s, 0, 0);
    t = Core.resetTimer(t, s);
    expect(t.focusSlotsConsumed).toBe(3);
  });

  test('test_FR01_MemoInputPending상태에서는_시작_일시정지_리셋_호출이_거부된다', () => {
    // BR-04: Memo-Input-Pending 에서는 타이머 제어가 불가능해야 한다.
    const s = freshSettings();
    let running = Core.startTimer(Core.createInitialTimer(s, 0, 0), s, 0, 0);
    running.endTimestamp = 1; // 강제 만료
    const res = Core.completeExpiredSession(running, s, 2, 2);
    const pending = res.timer;
    expect(pending.memoPending).toBe(true);
    expect(() => Core.startTimer(pending, s, 10, 10)).toThrow();
    expect(() => Core.resetTimer(pending, s)).toThrow();
    expect(() => Core.skipSession(pending, s, 10, 10)).toThrow();
  });
});

describe('FR-07 설정 (세션 길이 커스터마이징)', () => {
  test('test_FR07_범위를_벗어난_값은_저장되지_않는다', () => {
    expect(Core.validateSettings({ focusMin: 0, shortBreakMin: 5, longBreakMin: 15 }).valid).toBe(false);
    expect(Core.validateSettings({ focusMin: 181, shortBreakMin: 5, longBreakMin: 15 }).valid).toBe(false);
    expect(Core.validateSettings({ focusMin: 25.5, shortBreakMin: 5, longBreakMin: 15 }).valid).toBe(false);
    expect(Core.validateSettings({ focusMin: 'abc', shortBreakMin: 5, longBreakMin: 15 }).valid).toBe(false);
    expect(Core.validateSettings({ focusMin: '25', shortBreakMin: '', longBreakMin: 15 }).valid).toBe(false);
  });

  test('test_FR07_경계값_1분과_180분은_허용된다', () => {
    const r = Core.validateSettings({ focusMin: 1, shortBreakMin: 180, longBreakMin: 90 });
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ focusMin: 1, shortBreakMin: 180, longBreakMin: 90 });
  });

  test('test_FR07_정수문자열은_허용되고_숫자로_변환된다', () => {
    const r = Core.validateSettings({ focusMin: '30', shortBreakMin: '7', longBreakMin: '20' });
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ focusMin: 30, shortBreakMin: 7, longBreakMin: 20 });
  });

  test('test_FR07_Idle세션은_설정변경이_화면표시에_즉시_반영된다', () => {
    const oldS = freshSettings();
    let t = Core.createInitialTimer(oldS, 0, 0); // Focus-Idle
    expect(Core.remainingMs(t, 0, oldS)).toBe(25 * MIN);
    const newS = Core.cloneSettings({ focusMin: 50, shortBreakMin: 5, longBreakMin: 15 });
    // Idle 세션의 남은 시간은 settings 로부터 파생되므로 즉시 새 값
    expect(Core.remainingMs(t, 0, newS)).toBe(50 * MIN);
  });

  test('test_FR07_Running세션은_설정변경이_현재세션에_반영되지_않고_다음세션부터_적용된다', () => {
    const oldS = freshSettings();
    let t = Core.startTimer(Core.createInitialTimer(oldS, 0, 0), oldS, 0, 0);
    const newS = Core.cloneSettings({ focusMin: 50, shortBreakMin: 5, longBreakMin: 15 });
    // 현재 Running Focus 세션: endTimestamp 기준이므로 새 설정과 무관하게 25분 기준 유지
    expect(Core.remainingMs(t, 60 * 1000, newS)).toBe(25 * MIN - 60 * 1000);
    // 이 세션이 끝나고 나서 시작되는 다음 Focus 는 새 값(50분)을 사용
    t.endTimestamp = 100;
    const done = Core.completeExpiredSession(t, newS, 200, 200); // Focus 완료 → memoPending
    const advanced = Core.resolveMemoAndAdvance(done.timer, newS, 300, 300); // 다음: ShortBreak
    // ShortBreak 후 다음 Focus 를 검증
    let sb = advanced.timer;
    sb.endTimestamp = 400;
    const afterBreak = Core.completeExpiredSession(sb, newS, 500, 500);
    expect(afterBreak.timer.sessionType).toBe(Core.SESSION.FOCUS);
    expect(afterBreak.timer.remainingMsSnapshot).toBe(50 * MIN);
  });
});

describe('NFR-01 타이머 정확도 (절대시각 기반, 드리프트 없음)', () => {
  test('test_NFR01_수시간_연속구동해도_표시시간과_실제경과시간_오차가_없다', () => {
    const s = freshSettings();
    const start = 1_700_000_000_000;
    let t = Core.startTimer(Core.createInitialTimer(s, start, 0), s, start, 0); // Focus 25분
    // 3시간 경과 후에도 endTimestamp 절대값 기준이므로 정확 (0으로 clamp)
    const threeHours = 3 * 60 * MIN;
    expect(Core.remainingMs(t, start + threeHours, s)).toBe(0);
    // 만료 5초 전 시점은 정확히 5000ms 를 표시 (드리프트 없음)
    expect(Core.remainingMs(t, t.endTimestamp - 5000, s)).toBe(5000);
    // 만료 2시간 전 시점도 정확
    expect(Core.remainingMs(t, start + (25 * MIN - 2 * 60 * MIN), s)).toBe(2 * 60 * MIN);
  });

  test('test_NFR01_endTimestamp는_시작시각_한번만_계산되고_조회마다_재계산되지_않는다', () => {
    const s = freshSettings();
    let t = Core.startTimer(Core.createInitialTimer(s, 1000, 0), s, 1000, 0);
    const end = t.endTimestamp;
    Core.remainingMs(t, 2000, s);
    Core.remainingMs(t, 3000, s);
    expect(t.endTimestamp).toBe(end);
  });
});
