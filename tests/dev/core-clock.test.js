/*
 * 자체 테스트 — 시스템 시계(로컬 클록) 변경 (EC-04), 타이머 정확도 알고리즘 (NFR-01)
 *
 * EC-04 / 12.2 승인된 결정 (대체 불가):
 *   세션 시작·재개·탭 복귀 시 dateAnchor=Date.now(), perfAnchor=performance.now() 샘플링.
 *   이후 |(Date.now()-dateAnchor) - (performance.now()-perfAnchor)| >= 5000ms 이면 시계 변경.
 *   원시 값 직접 비교는 사용하지 않는다.
 *
 * 대상: src/core.js detectClockChange / forcePauseForClockChange / resumeTimer
 */
'use strict';

const Core = require('../../src/core.js');
const MIN = Core.MS_PER_MIN;
const S = () => Core.defaultSettings();

describe('EC-04 시스템 시계 변경 감지', () => {
  test('test_EC04_앵커대비_델타차이가_5초이상이면_시계변경으로_판정한다', () => {
    // 두 클록의 origin 이 다르더라도(여기선 date 1e12, perf 1000) 델타끼리 비교한다.
    const anchor = Core.sampleAnchor(1_000_000_000_000, 1000);
    // perf 는 30초 흐름, date 는 40초 흘렀다고 주장 → 10초 불일치
    const perfNow = 1000 + 30_000;
    const dateNow = 1_000_000_000_000 + 40_000;
    expect(Core.detectClockChange(anchor, dateNow, perfNow)).toBe(true);
  });

  test('test_EC04_델타차이가_5초미만이면_정상_절전_백그라운드_동결도_오탐지하지_않는다', () => {
    const anchor = Core.sampleAnchor(1_000_000_000_000, 1000);
    // 백그라운드 동결로 2시간이 함께 흐른 정상 상황: 두 델타가 거의 동일
    const elapsed = 2 * 60 * MIN;
    expect(Core.detectClockChange(anchor, 1_000_000_000_000 + elapsed, 1000 + elapsed + 1200)).toBe(false);
    // 정확히 5초 미만 경계
    expect(Core.detectClockChange(anchor, 1_000_000_000_000 + 4999, 1000)).toBe(false);
  });

  test('test_EC04_임계값_정확히_5초는_시계변경으로_판정한다', () => {
    const anchor = Core.sampleAnchor(0, 0);
    expect(Core.detectClockChange(anchor, 5000, 0)).toBe(true);
  });

  test('test_EC04_원시값을_직접_비교하지_않는다_앵커재설정시_기존경과는_오탐지되지_않는다', () => {
    // 앵커를 탭 복귀 시점마다 재설정하므로, 재설정 직후에는 델타가 0 근처에서 새로 측정된다.
    const anchor = Core.sampleAnchor(2_000_000, 999_999); // 서로 완전히 다른 origin
    // 재설정 직후 동일하게 3초 경과
    expect(Core.detectClockChange(anchor, 2_003_000, 1_002_999)).toBe(false);
  });

  test('test_EC04_시계변경_감지시_세션은_즉시_Paused로_전환되고_남은시간은_마지막_유효값으로_고정된다', () => {
    const s = S();
    let t = Core.startTimer(Core.createInitialTimer(s, 1_000_000, 0), s, 1_000_000, 0);
    // 감지 직전 마지막으로 유효했던 남은 시간 = 13분
    const lastValid = 13 * MIN;
    const paused = Core.forcePauseForClockChange(t, lastValid);
    expect(paused.status).toBe(Core.STATUS.PAUSED);
    expect(paused.endTimestamp).toBeNull();
    expect(paused.remainingMsSnapshot).toBe(13 * MIN);
  });

  test('test_EC04_시계변경_처리시_시간을_임의로_연장하거나_단축하지_않는다', () => {
    const s = S();
    let t = Core.startTimer(Core.createInitialTimer(s, 0, 0), s, 0, 0);
    const lastValid = 7 * MIN + 500;
    const paused = Core.forcePauseForClockChange(t, lastValid);
    // 고정된 값은 마지막 유효값 그대로 (반올림만)
    expect(paused.remainingMsSnapshot).toBe(Math.round(lastValid));
  });

  test('test_EC04_사용자가_재개하면_현재시각_기준_새_endTimestamp와_앵커가_재설정된다', () => {
    const s = S();
    let t = Core.startTimer(Core.createInitialTimer(s, 0, 0), s, 0, 0);
    t = Core.forcePauseForClockChange(t, 10 * MIN);
    const resumeNow = 5_000_000;
    const resumePerf = 42;
    const resumed = Core.resumeTimer(t, resumeNow, resumePerf);
    expect(resumed.status).toBe(Core.STATUS.RUNNING);
    expect(resumed.endTimestamp).toBe(resumeNow + 10 * MIN);
    expect(resumed.dateAnchor).toBe(resumeNow);
    expect(resumed.perfAnchor).toBe(resumePerf);
  });

  test('test_INT_detectClockChange_앵커가_없거나_불완전하면_false를_반환한다', () => {
    expect(Core.detectClockChange(null, 1000, 1000)).toBe(false);
    expect(Core.detectClockChange({}, 1000, 1000)).toBe(false);
    expect(Core.detectClockChange({ dateAnchor: 0 }, 1000, 1000)).toBe(false);
  });
});
