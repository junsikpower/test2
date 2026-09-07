/*
 * 독립 테스트 — 재접속 복원 (src/core.js restoreTimer / resolveMemoAndAdvance)
 *
 * 근거: PRD FR-08, EC-03, BR-02, §12.2.
 * 직전 커밋(git diff HEAD~1 HEAD)의 핵심 변경 = restoredPending 플래그 도입:
 *   재접속 복원으로 만료된 Focus 를 메모 해소한 뒤에는 다음 세션을 자동 시작하지 않고
 *   Idle 로 대기시킨다(BR-02). 실시간 완료(restoredPending=false)는 종전대로 자동 시작.
 *
 * @jest-environment jsdom
 */
'use strict';

const { Core, MIN } = require('./_helpers');

const S = Core.defaultSettings();
const { FOCUS, SHORT_BREAK, LONG_BREAK } = Core.SESSION;
const { IDLE, RUNNING, PAUSED } = Core.STATUS;

function persistedRunningFocus({ endTimestamp, slots = 0 }) {
  return {
    sessionType: FOCUS, status: RUNNING,
    endTimestamp, remainingMsSnapshot: 0,
    focusSlotsConsumed: slots,
    dateAnchor: endTimestamp - 25 * MIN, perfAnchor: 0,
    memoPending: false, pendingCompletion: null, restoredPending: false
  };
}

describe('FR-08 / EC-03 재접속 복원 — Running 세션', () => {
  test('test_FR08_Running으로_저장된_세션이_아직_남아있으면_남은시간을_그대로_이어서_표시한다', () => {
    const endTs = Date.parse('2026-09-07T09:25:00');
    const persisted = persistedRunningFocus({ endTimestamp: endTs });
    const now = endTs - 8 * MIN;                       // 8분 남음
    const r = Core.restoreTimer(persisted, S, now, 0);
    expect(r.running).toBe(true);
    expect(r.expired).toBe(false);
    expect(r.timer.status).toBe(RUNNING);
    expect(Core.remainingMs(r.timer, now, S)).toBe(8 * MIN);
  });

  test('test_EC03_Running_만료시_경과세션수와_무관하게_중단시점_세션_1회만_종료처리한다', () => {
    const endTs = Date.parse('2026-09-07T09:25:00');
    const persisted = persistedRunningFocus({ endTimestamp: endTs });
    // 오프라인 10시간: 여러 세션이 경과했을 시간이지만 종료 처리는 1회.
    const now = endTs + 10 * 60 * MIN;
    const r = Core.restoreTimer(persisted, S, now, 0);
    expect(r.expired).toBe(true);
    expect(r.memoPending).toBe(true);
    expect(r.completion).toEqual({ dateKey: Core.dateKey(endTs), completedAt: endTs });
    // 메모 해소 후에도 그 다음 세션이 연쇄로 시작되지 않는다(1회 처리 + Idle 대기).
    const after = Core.resolveMemoAndAdvance(r.timer, S, now, 0);
    expect(after.timer.status).toBe(IDLE);
    expect(after.autoStarted).toBe(false);
  });

  test('test_FR08_완료처리된_세션의_로그귀속_날짜는_원래_종료목표시각_기준이다_현재시각_아님', () => {
    const endTs = Date.parse('2026-09-07T23:50:00');      // 9월 7일
    const persisted = persistedRunningFocus({ endTimestamp: endTs });
    const now = Date.parse('2026-09-09T10:00:00');        // 이틀 뒤 재접속
    const r = Core.restoreTimer(persisted, S, now, 0);
    expect(r.completion.dateKey).toBe('2026-09-07');
    expect(r.completion.dateKey).not.toBe(Core.dateKey(now));
  });

  test('test_BR02_복원후_다음세션은_자동시작되지_않고_Idle로_대기하며_사용자_시작조작을_요한다', () => {
    const endTs = Date.parse('2026-09-07T09:25:00');
    const persisted = persistedRunningFocus({ endTimestamp: endTs });
    const now = endTs + 3 * 60 * MIN;
    const r = Core.restoreTimer(persisted, S, now, 0);
    expect(r.autoStart).toBe(false);
    const after = Core.resolveMemoAndAdvance(r.timer, S, now, 0);
    expect(after.timer.status).toBe(IDLE);
    expect(after.timer.sessionType).toBe(SHORT_BREAK);
    // 사용자가 직접 시작해야 Running 이 된다.
    const started = Core.startTimer(after.timer, S, now, 0);
    expect(started.status).toBe(RUNNING);
  });

  test('test_EC03_Running_만료세션이_Break였다면_메모없이_다음_Focus를_Idle로_대기시킨다', () => {
    const endTs = Date.parse('2026-09-07T09:30:00');
    const persisted = {
      sessionType: SHORT_BREAK, status: RUNNING,
      endTimestamp: endTs, remainingMsSnapshot: 0, focusSlotsConsumed: 2,
      dateAnchor: endTs - 5 * MIN, perfAnchor: 0,
      memoPending: false, pendingCompletion: null, restoredPending: false
    };
    const now = endTs + 2 * 60 * MIN;
    const r = Core.restoreTimer(persisted, S, now, 0);
    expect(r.expired).toBe(true);
    expect(r.memoPending).toBe(false);
    expect(r.timer.sessionType).toBe(FOCUS);
    expect(r.timer.status).toBe(IDLE);
    expect(r.autoStart).toBe(false);
  });

  test('test_FR08_재접속_복원_경로에서_Focus_슬롯은_메모해소시_정확히_1회_소모된다_3에서_4_LongBreak', () => {
    const endTs = Date.parse('2026-09-07T09:25:00');
    const persisted = persistedRunningFocus({ endTimestamp: endTs, slots: 3 });
    const now = endTs + 60 * MIN;
    const r = Core.restoreTimer(persisted, S, now, 0);
    expect(r.timer.focusSlotsConsumed).toBe(3);            // 복원 시점엔 아직 미소모
    const after = Core.resolveMemoAndAdvance(r.timer, S, now, 0);
    expect(after.timer.focusSlotsConsumed).toBe(4);        // 소모는 정확히 1회
    expect(after.timer.sessionType).toBe(LONG_BREAK);
  });
});

describe('FR-08 / EC-03 재접속 복원 — Paused 세션', () => {
  test('test_FR08_Paused로_저장된_세션은_오프라인시간과_무관하게_남은시간_스냅샷_그대로_복원되고_종료처리되지_않는다', () => {
    const persisted = {
      sessionType: SHORT_BREAK, status: PAUSED,
      endTimestamp: null, remainingMsSnapshot: 3 * MIN, focusSlotsConsumed: 1,
      dateAnchor: 0, perfAnchor: 0,
      memoPending: false, pendingCompletion: null, restoredPending: false
    };
    const now = Date.parse('2026-09-07T09:00:00') + 5 * 24 * 60 * MIN;  // 5일 뒤
    const r = Core.restoreTimer(persisted, S, now, 0);
    expect(r.timer.status).toBe(PAUSED);
    expect(r.timer.remainingMsSnapshot).toBe(3 * MIN);     // 변하지 않음
    expect(r.expired).toBe(false);
    expect(r.memoPending).toBe(false);
    expect(r.notify).toBe(false);
  });
});

describe('FR-08 재접속 복원 — Idle / Memo-Input-Pending 저장 상태', () => {
  test('test_FR08_Idle로_저장된_세션은_설정된_길이로_복원되고_만료판정을_하지_않는다', () => {
    const persisted = {
      sessionType: FOCUS, status: IDLE, endTimestamp: null,
      remainingMsSnapshot: 25 * MIN, focusSlotsConsumed: 2,
      dateAnchor: 0, perfAnchor: 0, memoPending: false, pendingCompletion: null, restoredPending: false
    };
    const r = Core.restoreTimer(persisted, S, 10_000_000, 0);
    expect(r.timer.status).toBe(IDLE);
    expect(r.timer.focusSlotsConsumed).toBe(2);
    expect(r.expired).toBe(false);
  });

  test('test_FR08_MemoInputPending으로_저장된_상태는_완료를_다시_세지_않고_메모대기로_복원된다', () => {
    const persisted = {
      sessionType: FOCUS, status: IDLE, endTimestamp: null,
      remainingMsSnapshot: 0, focusSlotsConsumed: 1,
      dateAnchor: 0, perfAnchor: 0,
      memoPending: true,
      pendingCompletion: { dateKey: '2026-09-07', completedAt: Date.parse('2026-09-07T09:25:00') },
      restoredPending: true
    };
    const r = Core.restoreTimer(persisted, S, 10_000_000, 0);
    expect(r.memoPending).toBe(true);
    expect(r.completion).toBeNull();      // 완료 카운트 재귀속 없음
  });
});

/* ── 커밋 코드 기반(INT): restoredPending 분기 및 손상 상태 방어 ─────────────── */
describe('INT restoreTimer / resolveMemoAndAdvance 분기·예외 처리', () => {
  test('test_INT_restoredPending_true면_메모해소가_Idle을_반환하고_false면_Running을_반환한다', () => {
    const base = {
      sessionType: FOCUS, status: IDLE, endTimestamp: null, remainingMsSnapshot: 0,
      focusSlotsConsumed: 0, dateAnchor: 0, perfAnchor: 0,
      memoPending: true, pendingCompletion: null
    };
    const restored = Core.resolveMemoAndAdvance(Object.assign({}, base, { restoredPending: true }), S, 0, 0);
    const live = Core.resolveMemoAndAdvance(Object.assign({}, base, { restoredPending: false }), S, 0, 0);
    expect(restored.timer.status).toBe(IDLE);
    expect(restored.autoStarted).toBe(false);
    expect(live.timer.status).toBe(RUNNING);
    expect(live.autoStarted).toBe(true);
  });

  test('test_INT_resolveMemoAndAdvance는_memoPending이_아니면_예외를_던진다', () => {
    const t = Core.createInitialTimer(S, 0, 0);      // memoPending false
    expect(() => Core.resolveMemoAndAdvance(t, S, 0, 0)).toThrow();
  });

  test('test_INT_restoreTimer_null_입력시_초기_Focus_Idle_타이머를_반환한다', () => {
    const r = Core.restoreTimer(null, S, 123, 0);
    expect(r.timer.sessionType).toBe(FOCUS);
    expect(r.timer.status).toBe(IDLE);
    expect(r.expired).toBe(false);
  });

  test('test_INT_restoreTimer_Running인데_endTimestamp가_손상됐으면_안전하게_Idle로_정리한다', () => {
    const persisted = {
      sessionType: FOCUS, status: RUNNING, endTimestamp: 'corrupt',
      remainingMsSnapshot: 0, focusSlotsConsumed: 1,
      dateAnchor: 0, perfAnchor: 0, memoPending: false, pendingCompletion: null, restoredPending: false
    };
    const r = Core.restoreTimer(persisted, S, 10_000, 0);
    expect(r.timer.status).toBe(IDLE);
    expect(r.expired).toBe(false);
    expect(r.timer.focusSlotsConsumed).toBe(1);
  });

  test('test_INT_restoreTimer_Paused_스냅샷이_비정상값이면_세션길이로_보정하고_최소값_이상을_보장한다', () => {
    const persisted = {
      sessionType: LONG_BREAK, status: PAUSED, endTimestamp: null,
      remainingMsSnapshot: NaN, focusSlotsConsumed: 4,
      dateAnchor: 0, perfAnchor: 0, memoPending: false, pendingCompletion: null, restoredPending: false
    };
    const r = Core.restoreTimer(persisted, S, 0, 0);
    expect(r.timer.status).toBe(PAUSED);
    expect(r.timer.remainingMsSnapshot).toBeGreaterThanOrEqual(Core.MIN_PAUSED_REMAINING_MS);
    expect(Number.isFinite(r.timer.remainingMsSnapshot)).toBe(true);
  });
});
