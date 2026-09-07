/*
 * 자체 테스트 — 데이터 영속성 및 상태 복원 (FR-08),
 * 새로고침/재시작 시 진행중 세션 복원 및 다중 세션 만료 (EC-03),
 * 자동 시작의 적용 범위 (BR-02)
 *
 * 대상: src/core.js restoreTimer()
 */
'use strict';

const Core = require('../../src/core.js');
const MIN = Core.MS_PER_MIN;
const S = () => Core.defaultSettings();

describe('FR-08 / EC-03 재접속 복원 — Running', () => {
  test('test_FR08_Running_미만료_복원시_남은시간을_그대로_이어서_표시한다', () => {
    const s = S();
    const savedAt = 1_000_000;
    const persisted = {
      sessionType: Core.SESSION.FOCUS, status: Core.STATUS.RUNNING,
      endTimestamp: savedAt + 25 * MIN, remainingMsSnapshot: 25 * MIN,
      focusSlotsConsumed: 1, dateAnchor: savedAt, perfAnchor: 5
    };
    const reloadNow = savedAt + 10 * MIN; // 10분 경과, 15분 남음
    const r = Core.restoreTimer(persisted, s, reloadNow, 999);
    expect(r.expired).toBe(false);
    expect(r.running).toBe(true);
    expect(r.timer.status).toBe(Core.STATUS.RUNNING);
    expect(Core.remainingMs(r.timer, reloadNow, s)).toBe(15 * MIN);
  });

  test('test_EC03_Running_만료_복원시_경과세션수와_무관하게_1회만_종료처리한다', () => {
    const s = S();
    const savedAt = 1_000_000;
    const persisted = {
      sessionType: Core.SESSION.FOCUS, status: Core.STATUS.RUNNING,
      endTimestamp: savedAt + 25 * MIN, remainingMsSnapshot: 25 * MIN,
      focusSlotsConsumed: 0, dateAnchor: savedAt, perfAnchor: 5
    };
    // 저장 후 10시간 경과 — 여러 세션이 지났을 시간
    const reloadNow = savedAt + 10 * 60 * MIN;
    const r = Core.restoreTimer(persisted, s, reloadNow, 999);
    expect(r.expired).toBe(true);
    // Focus 만료 → 완료 처리 1회 (completion 1건)
    expect(r.completion).toEqual({
      dateKey: Core.dateKey(savedAt + 25 * MIN),
      completedAt: savedAt + 25 * MIN
    });
    expect(r.memoPending).toBe(true);
    expect(r.notify).toBe(true);
  });

  test('test_FR08_만료된_Focus세션의_로그귀속날짜는_원래_종료목표시각_기준이다', () => {
    const s = S();
    // 종료 목표 시각을 특정 날짜로 못박는다
    const endTs = new Date(2026, 0, 2, 23, 30, 0).getTime(); // 2026-01-02 23:30 local
    const persisted = {
      sessionType: Core.SESSION.FOCUS, status: Core.STATUS.RUNNING,
      endTimestamp: endTs, remainingMsSnapshot: 25 * MIN,
      focusSlotsConsumed: 0, dateAnchor: endTs - 25 * MIN, perfAnchor: 0
    };
    // 재접속은 다음 날
    const reloadNow = new Date(2026, 0, 3, 9, 0, 0).getTime();
    const r = Core.restoreTimer(persisted, s, reloadNow, 0);
    expect(r.completion.dateKey).toBe('2026-01-02');
  });

  test('test_BR02_복원_후_다음세션은_자동시작되지_않고_Idle로_대기한다 (Running 만료)', () => {
    const s = S();
    const savedAt = 1_000_000;
    // Break 가 만료된 경우: 메모 없이 다음 Focus 를 Idle 로
    const persisted = {
      sessionType: Core.SESSION.SHORT_BREAK, status: Core.STATUS.RUNNING,
      endTimestamp: savedAt + 5 * MIN, remainingMsSnapshot: 5 * MIN,
      focusSlotsConsumed: 2, dateAnchor: savedAt, perfAnchor: 0
    };
    const r = Core.restoreTimer(persisted, s, savedAt + 3 * 60 * MIN, 0);
    expect(r.expired).toBe(true);
    expect(r.autoStart).toBe(false);
    expect(r.timer.sessionType).toBe(Core.SESSION.FOCUS);
    expect(r.timer.status).toBe(Core.STATUS.IDLE);
  });

  test('test_BR02_복원된_만료Focus의_메모해소_후에도_다음세션은_자동시작되지_않는다', () => {
    const s = S();
    const savedAt = 1_000_000;
    const persisted = {
      sessionType: Core.SESSION.FOCUS, status: Core.STATUS.RUNNING,
      endTimestamp: savedAt + 25 * MIN, remainingMsSnapshot: 25 * MIN,
      focusSlotsConsumed: 0, dateAnchor: savedAt, perfAnchor: 0
    };
    const r = Core.restoreTimer(persisted, s, savedAt + 3 * 60 * MIN, 0);
    const resolved = Core.resolveMemoAndAdvance(r.timer, s, savedAt + 3 * 60 * MIN + 1000, 0);
    expect(resolved.autoStarted).toBe(false);
    expect(resolved.timer.status).toBe(Core.STATUS.IDLE);
    expect(resolved.timer.sessionType).toBe(Core.SESSION.SHORT_BREAK);
    // 슬롯은 1회만 소모
    expect(resolved.timer.focusSlotsConsumed).toBe(1);
  });
});

describe('FR-08 / EC-03 재접속 복원 — Paused', () => {
  test('test_FR08_Paused_복원시_오프라인시간과_무관하게_남은시간_스냅샷이_그대로_복원된다', () => {
    const s = S();
    const persisted = {
      sessionType: Core.SESSION.FOCUS, status: Core.STATUS.PAUSED,
      endTimestamp: null, remainingMsSnapshot: 12 * MIN + 34 * 1000,
      focusSlotsConsumed: 1, dateAnchor: 500, perfAnchor: 5
    };
    // 저장 후 3일 경과
    const reloadNow = 500 + 3 * 24 * 60 * MIN;
    const r = Core.restoreTimer(persisted, s, reloadNow, 0);
    expect(r.expired).toBe(false);
    expect(r.timer.status).toBe(Core.STATUS.PAUSED);
    expect(r.timer.remainingMsSnapshot).toBe(12 * MIN + 34 * 1000);
    expect(Core.remainingMs(r.timer, reloadNow, s)).toBe(12 * MIN + 34 * 1000);
  });

  test('test_EC03_Paused_복원시_endTimestamp가_없으므로_만료판단을_하지_않는다', () => {
    const s = S();
    const persisted = {
      sessionType: Core.SESSION.LONG_BREAK, status: Core.STATUS.PAUSED,
      endTimestamp: null, remainingMsSnapshot: 1 * MIN,
      focusSlotsConsumed: 4, dateAnchor: 0, perfAnchor: 0
    };
    const r = Core.restoreTimer(persisted, s, 999_999_999_999, 0);
    expect(r.expired).toBe(false);
    expect(r.notify).toBe(false);
    expect(r.timer.sessionType).toBe(Core.SESSION.LONG_BREAK);
  });
});

describe('FR-08 재접속 복원 — 설정/슬롯/Idle', () => {
  test('test_FR08_저장된_설정값과_사이클슬롯수가_그대로_복원된다', () => {
    const s = Core.cloneSettings({ focusMin: 40, shortBreakMin: 8, longBreakMin: 30 });
    const persisted = {
      sessionType: Core.SESSION.FOCUS, status: Core.STATUS.IDLE,
      endTimestamp: null, remainingMsSnapshot: 40 * MIN,
      focusSlotsConsumed: 3, dateAnchor: 0, perfAnchor: 0
    };
    const r = Core.restoreTimer(persisted, s, 1000, 0);
    expect(r.timer.focusSlotsConsumed).toBe(3);
    expect(Core.remainingMs(r.timer, 1000, s)).toBe(40 * MIN);
  });

  test('test_FR08_저장된_상태가_없으면_Focus_Idle_슬롯0으로_초기화된다', () => {
    const r = Core.restoreTimer(null, S(), 1000, 0);
    expect(r.timer.sessionType).toBe(Core.SESSION.FOCUS);
    expect(r.timer.status).toBe(Core.STATUS.IDLE);
    expect(r.timer.focusSlotsConsumed).toBe(0);
  });

  test('test_INT_손상된_Running상태_endTimestamp누락시_안전하게_Idle로_정리된다', () => {
    // 코드 방어 로직 검증 (PRD 조항 아님)
    const persisted = {
      sessionType: Core.SESSION.FOCUS, status: Core.STATUS.RUNNING,
      endTimestamp: null, remainingMsSnapshot: null,
      focusSlotsConsumed: 1, dateAnchor: 0, perfAnchor: 0
    };
    const r = Core.restoreTimer(persisted, S(), 1000, 0);
    expect(r.timer.status).toBe(Core.STATUS.IDLE);
    expect(r.expired).toBe(false);
  });
});
