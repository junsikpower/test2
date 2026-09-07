/*
 * 독립 테스트 — 설정 검증(FR-07), 일별 로그(FR-05·FR-06), 시계 변경 감지 알고리즘(EC-04·NFR-01·12.2)
 * 대상: src/core.js 의 순수 함수.
 *
 * @jest-environment jsdom
 */
'use strict';

const { Core, MIN } = require('./_helpers');

const S = Core.defaultSettings();
const { FOCUS, SHORT_BREAK } = Core.SESSION;
const { RUNNING, PAUSED } = Core.STATUS;

describe('FR-07 설정 (세션 길이 커스터마이징)', () => {
  test('test_FR07_기본값은_집중25_짧은휴식5_긴휴식15분이다', () => {
    expect(Core.defaultSettings()).toEqual({ focusMin: 25, shortBreakMin: 5, longBreakMin: 15 });
  });

  test('test_FR07_1분과_180분_경계값은_허용된다', () => {
    const r = Core.validateSettings({ focusMin: '1', shortBreakMin: '180', longBreakMin: 90 });
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ focusMin: 1, shortBreakMin: 180, longBreakMin: 90 });
  });

  test('test_FR07_0이하_181이상_소수_비숫자는_저장되지_않는다', () => {
    expect(Core.validateSettings({ focusMin: 0, shortBreakMin: 5, longBreakMin: 15 }).valid).toBe(false);
    expect(Core.validateSettings({ focusMin: 25, shortBreakMin: 181, longBreakMin: 15 }).valid).toBe(false);
    expect(Core.validateSettings({ focusMin: 25, shortBreakMin: 5, longBreakMin: 1.5 }).valid).toBe(false);
    expect(Core.validateSettings({ focusMin: 25, shortBreakMin: 5, longBreakMin: '15.0' }).valid).toBe(false);
    expect(Core.validateSettings({ focusMin: 'abc', shortBreakMin: 5, longBreakMin: 15 }).valid).toBe(false);
    expect(Core.validateSettings({ focusMin: '  ', shortBreakMin: 5, longBreakMin: 15 }).valid).toBe(false);
  });

  test('test_FR07_세_필드중_하나라도_유효하지_않으면_전체_저장이_차단된다', () => {
    const r = Core.validateSettings({ focusMin: 30, shortBreakMin: 6, longBreakMin: 999 });
    expect(r.valid).toBe(false);
    expect(r.errors.longBreakMin).toBe(true);
  });

  test('test_FR07_Idle_세션은_설정길이_변경이_남은시간_표시에_즉시_반영된다', () => {
    let t = Core.createInitialTimer(S, 0, 0);            // Focus Idle, 25:00
    expect(Core.remainingMs(t, 0, S)).toBe(25 * MIN);
    const newS = { focusMin: 45, shortBreakMin: 5, longBreakMin: 15 };
    expect(Core.remainingMs(t, 0, newS)).toBe(45 * MIN); // 즉시 반영 (Idle 은 settings 참조)
  });

  test('test_FR07_Running_세션은_설정변경이_현세션에_반영되지_않는다_남은시간은_endTimestamp_기준', () => {
    let t = Core.startTimer(Core.createInitialTimer(S, 1_000, 0), S, 1_000, 0); // end=1_000+25분
    const newS = { focusMin: 10, shortBreakMin: 5, longBreakMin: 15 };
    // 설정을 바꿔도 Running 남은시간은 endTimestamp - now 로 계산되어 그대로.
    expect(Core.remainingMs(t, 1_000 + 60_000, newS)).toBe(25 * MIN - 60_000);
  });

  test('test_FR07_Paused_세션은_설정변경이_현세션에_반영되지_않는다_스냅샷_유지', () => {
    const paused = Core.pauseTimer(Core.startTimer(Core.createInitialTimer(S, 0, 0), S, 0, 0), 10 * MIN);
    const newS = { focusMin: 10, shortBreakMin: 5, longBreakMin: 15 };
    expect(Core.remainingMs(paused, 99 * MIN, newS)).toBe(15 * MIN); // 스냅샷 그대로
  });
});

describe('FR-05 / FR-06 일별 로그', () => {
  test('test_FR05_빈값_메모_제출과_건너뛰기_모두_완료카운트는_정상반영되고_메모텍스트만_빈값으로_저장된다', () => {
    let logs = Core.emptyLogs();
    const key = '2026-09-07';
    logs = Core.addCompletion(logs, key, Date.parse('2026-09-07T09:25:00'), '');   // 빈 값
    logs = Core.addCompletion(logs, key, Date.parse('2026-09-07T09:55:00'), '   '); // 공백
    const day = Core.getDailyLog(logs, key);
    expect(day.count).toBe(2);
    expect(day.memos.map((m) => m.text)).toEqual(['', '   ']);
  });

  test('test_FR05_빈값_메모는_메모없음으로_표시된다', () => {
    expect(Core.displayMemoText('')).toBe('메모 없음');
    expect(Core.displayMemoText('   ')).toBe('메모 없음');
    expect(Core.displayMemoText('PRD 검토')).toBe('PRD 검토');
  });

  test('test_FR05_저장된_메모는_완료시각과_함께_해당_날짜_로그에_추가된다', () => {
    let logs = Core.emptyLogs();
    const at = Date.parse('2026-09-07T14:10:00');
    logs = Core.addCompletion(logs, '2026-09-07', at, '보고서');
    const day = Core.getDailyLog(logs, '2026-09-07');
    expect(day.memos[0]).toEqual({ completedAt: at, text: '보고서' });
  });

  test('test_FR06_표시되는_완료개수가_해당_날짜에_정상종료된_Focus_세션_수와_정확히_일치한다', () => {
    let logs = Core.emptyLogs();
    logs = Core.addCompletion(logs, '2026-09-07', Date.parse('2026-09-07T09:25:00'), 'a');
    logs = Core.addCompletion(logs, '2026-09-07', Date.parse('2026-09-07T10:00:00'), 'b');
    logs = Core.addCompletion(logs, '2026-09-08', Date.parse('2026-09-08T09:25:00'), 'c');
    expect(Core.getDailyLog(logs, '2026-09-07').count).toBe(2);
    expect(Core.getDailyLog(logs, '2026-09-08').count).toBe(1);
    expect(Core.getDailyLog(logs, '2026-09-09').count).toBe(0);
  });

  test('test_FR06_메모가_오래된순_시간순으로_정렬되어_표시된다', () => {
    let logs = Core.emptyLogs();
    // 일부러 역순으로 추가
    logs = Core.addCompletion(logs, '2026-09-07', Date.parse('2026-09-07T15:00:00'), 'late');
    logs = Core.addCompletion(logs, '2026-09-07', Date.parse('2026-09-07T09:00:00'), 'early');
    logs = Core.addCompletion(logs, '2026-09-07', Date.parse('2026-09-07T12:00:00'), 'mid');
    const texts = Core.getDailyLog(logs, '2026-09-07').memos.map((m) => m.text);
    expect(texts).toEqual(['early', 'mid', 'late']);
  });

  test('test_FR06_모든_시각은_기기의_로컬_타임존_기준으로_날짜키가_계산된다', () => {
    // dateKey 는 getFullYear/getMonth/getDate(로컬) 사용. UTC 자정 근처를 로컬로 해석.
    const ts = new Date(2026, 8, 7, 0, 30, 0).getTime();  // 로컬 2026-09-07 00:30
    expect(Core.dateKey(ts)).toBe('2026-09-07');
    const ts2 = new Date(2026, 8, 7, 23, 30, 0).getTime();
    expect(Core.dateKey(ts2)).toBe('2026-09-07');
  });
});

describe('EC-04 / NFR-01 / 12.2 시스템 시계 변경 감지 알고리즘', () => {
  test('test_EC04_앵커대비_델타차이가_정확히_5초면_시계변경으로_판정한다', () => {
    const anchor = { dateAnchor: 1_000_000, perfAnchor: 500 };
    // dateDelta = 5000, perfDelta = 0  → 차이 5000 = 임계값
    expect(Core.detectClockChange(anchor, 1_005_000, 500)).toBe(true);
  });

  test('test_EC04_델타차이가_5초미만이면_시계변경으로_판정하지_않는다_절전_백그라운드_동결_오탐지_방지', () => {
    const anchor = { dateAnchor: 1_000_000, perfAnchor: 500 };
    expect(Core.detectClockChange(anchor, 1_004_999, 500)).toBe(false);
  });

  test('test_EC04_원시값이_아니라_앵커대비_델타끼리_비교한다_기준점_다른_두_클록의_정상경과는_오탐지되지_않는다', () => {
    // Date 는 epoch(1e12대), performance 는 페이지 로드 기준(작은 값). 원시값 비교면 항상 참이 됨.
    const anchor = { dateAnchor: 1_700_000_000_000, perfAnchor: 12_345 };
    // 두 클록이 함께 정확히 30분 경과
    const elapsed = 30 * MIN;
    expect(Core.detectClockChange(anchor, 1_700_000_000_000 + elapsed, 12_345 + elapsed)).toBe(false);
  });

  test('test_EC04_시계변경_감지시_forcePauseForClockChange는_남은시간을_임의로_연장_단축하지_않는다', () => {
    const t = Core.startTimer(Core.createInitialTimer(S, 0, 0), S, 0, 0); // Running, 25:00
    const lastValid = 22 * MIN;                     // 감지 직전 마지막 유효 계산값
    const paused = Core.forcePauseForClockChange(t, lastValid);
    expect(paused.status).toBe(PAUSED);
    expect(paused.remainingMsSnapshot).toBe(22 * MIN);   // 고정, 연장/단축 없음
    expect(paused.endTimestamp).toBeNull();
  });

  test('test_EC04_사용자가_재개하면_현재시각_기준_새_endTimestamp를_계산하고_앵커를_재설정한다', () => {
    const paused = Core.forcePauseForClockChange(
      Core.startTimer(Core.createInitialTimer(S, 0, 0), S, 0, 0), 22 * MIN
    );
    const resumed = Core.resumeTimer(paused, 5_000_000, 9_000);
    expect(resumed.status).toBe(RUNNING);
    expect(resumed.endTimestamp).toBe(5_000_000 + 22 * MIN);
    expect(resumed.dateAnchor).toBe(5_000_000);
    expect(resumed.perfAnchor).toBe(9_000);
  });
});

/* ── 커밋 코드 기반(INT) ─────────────────────────────────────────────────────── */
describe('INT core 순수 함수 불변성·경계', () => {
  test('test_INT_addCompletion은_입력_logs_객체를_변형하지_않는다', () => {
    const logs = Core.emptyLogs();
    const frozen = Object.freeze(logs);
    const next = Core.addCompletion(frozen, '2026-09-07', 1, 'x');
    expect(next).not.toBe(frozen);
    expect(Object.keys(frozen)).toEqual([]);
  });

  test('test_INT_forcePauseForClockChange_lastValid가_0이하면_최소_스냅샷값으로_클램프된다', () => {
    const t = Core.startTimer(Core.createInitialTimer(S, 0, 0), S, 0, 0);
    const paused = Core.forcePauseForClockChange(t, -999);
    expect(paused.remainingMsSnapshot).toBe(Core.MIN_PAUSED_REMAINING_MS);
  });

  test('test_INT_advanceCycle은_알수없는_세션타입에_예외를_던진다', () => {
    expect(() => Core.advanceCycle('Nap', 0)).toThrow();
  });

  test('test_INT_detectClockChange는_앵커가_불완전하면_false를_반환한다', () => {
    expect(Core.detectClockChange(null, 1, 1)).toBe(false);
    expect(Core.detectClockChange({ dateAnchor: 1 }, 1, 1)).toBe(false);
  });
});
