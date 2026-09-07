'use strict';

/*
 * PRD 8. Error & Edge Cases — EC-01 ~ EC-05.
 * 예외 상황, 시스템 상태 전이, 재시도/복구/롤백 정책을 검증한다.
 */

const { boot, finishRunning, run, $, isHidden, makeFailingStorage, makeFlakyStorage } = require('./helpers/harness');
const H = require('./helpers/harness');

const okAudio = () => ({ unlock: jest.fn(() => Promise.resolve()), beep: jest.fn(() => Promise.resolve()) });
const failAudio = () => ({ unlock: jest.fn(() => Promise.resolve()), beep: jest.fn(() => Promise.reject(new Error('blocked'))) });
const grantedNotif = () => ({ permission: 'granted', show: jest.fn(), request: jest.fn(() => Promise.resolve('granted')) });
const deniedNotif = () => ({ permission: 'denied', show: jest.fn(), request: jest.fn(() => Promise.resolve('denied')) });

// ───────────────────────── EC-01 알림 권한 거부 / Notification 미지원 ─────────────────────────

describe('EC-01 브라우저 알림 권한 거부 또는 Notification API 미지원', () => {
  test('test_EC01_권한거부시_소리알림과_탭제목변경으로_대체_브라우저알림_미발송', async () => {
    const audio = okAudio();
    const notification = deniedNotif();
    const { P, clock } = boot({ audio, notification });
    const base = document.title;
    P.start();
    finishRunning(P, clock);
    await P.lastAlert();
    expect(notification.show).not.toHaveBeenCalled();
    expect(audio.beep).toHaveBeenCalledTimes(1);   // 소리는 항상 시도
    expect(document.title).not.toBe(base);
    expect(document.title).toContain('⏰');
  });

  test('test_EC01_Notification_API_미지원시_예외없이_폴백', async () => {
    const audio = okAudio();
    const { P, clock } = boot({ audio, notification: null });
    P.start();
    expect(() => finishRunning(P, clock)).not.toThrow();
    await P.lastAlert();
    expect(document.title).toContain('⏰');
    expect(P.getState().memoPending).toBe(true);
  });

  test('test_EC01_매_세션종료시_폴백수단으로_대체_데이터영향없음', async () => {
    const { P, clock } = boot({ audio: okAudio(), notification: deniedNotif() });
    P.start();
    finishRunning(P, clock); await P.lastAlert();      // Focus 종료
    P.submitMemo('m');                                  // → ShortBreak Running
    finishRunning(P, clock); await P.lastAlert();      // ShortBreak 종료
    const alerts = P.getState().alertLog;
    expect(alerts.length).toBe(2);
    expect(alerts.every((a) => a.titleFallback === true)).toBe(true);
    expect(P.getLog().count).toBe(1); // 알림 폴백은 데이터에 영향 없음
  });
});

// ───────────────────────── EC-02 탭 비활성(백그라운드) 중 세션 종료 ─────────────────────────

describe('EC-02 탭 비활성화 중 세션 종료', () => {
  test('test_EC02_탭복귀시_종료목표시각과_현재시각_비교하여_즉시_종료처리', () => {
    const { P, clock } = boot();
    P.start(); // Focus 25분
    // 백그라운드로 tick 이 멈춘 사이 26분 경과
    clock.advance(26 * 60000);
    P.onVisible();
    expect(P.getState().memoPending).toBe(true);
    expect(P.getLog().count).toBe(1);
  });

  test('test_EC02_백그라운드_다중세션경과여도_복귀시점_기준으로_1회_종료처리', () => {
    const { P, clock } = boot();
    P.start();
    clock.advance(3 * 60 * 60000); // 3시간
    P.onVisible();
    expect(P.getLog().count).toBe(1); // 여러 번이 아니라 1회
    expect(P.getState().memoPending).toBe(true);
  });

  test('test_EC02_절대시각_계산으로_경과시간_정확_화면갱신지연과_무관하게_정합성유지', () => {
    const { P, clock } = boot();
    P.start();
    const endTs = P.getState().endTimestamp;
    clock.advance(10 * 60000); // tick 없이 백그라운드
    P.onVisible();
    // 아직 만료 전 → Running 유지, 남은시간은 절대시각 기준 정확히 15분
    expect(P.getState().sessionStatus).toBe('Running');
    expect(P.getState().remainingMs).toBe(15 * 60000);
    expect(P.getState().endTimestamp).toBe(endTs); // 종료 목표 시각 불변
  });

  test('test_EC02_탭복귀는_실시간_사용_경로_Break만료시_다음Focus_자동시작', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock); P.submitMemo('m'); // ShortBreak Running
    clock.advance(6 * 60000); // ShortBreak(5분) 만료된 채 백그라운드
    P.onVisible();
    expect(P.getState().sessionType).toBe('Focus');
    expect(P.getState().sessionStatus).toBe('Running');
  });
});

// ───────────────────────── EC-03 새로고침/재시작 시 진행중 세션 복원 (다중 만료 포함) ─────────────────────────

describe('EC-03 새로고침 / 브라우저 재시작 시 진행 중이던 세션 복원', () => {
  test('test_EC03_Running으로_저장_아직_남아있으면_복원된_세션과_남은시간_그대로_표시', () => {
    const now = Date.UTC(2026, 8, 7, 10, 0, 0);
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'Focus', sessionStatus: 'Running',
        endTimestamp: now + 12 * 60000, remainingSnapshot: null, focusSlotsConsumed: 0,
        dateAnchor: now - 13 * 60000, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(now) });
    expect(P.getState().sessionStatus).toBe('Running');
    expect(P.getState().remainingMs).toBe(12 * 60000);
  });

  test('test_EC03_Running으로_저장_이미지났으면_1회_종료처리후_다음세션_Idle대기', () => {
    const now = Date.UTC(2026, 8, 7, 10, 0, 0);
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'Focus', sessionStatus: 'Running',
        endTimestamp: now - 40 * 60000, remainingSnapshot: null, focusSlotsConsumed: 3,
        dateAnchor: now - 65 * 60000, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(now) });
    expect(P.getState().memoPending).toBe(true);
    P.submitMemo('복원 완료 메모');
    // slot 이 4가 되었으므로 다음은 LongBreak, 단 Idle 대기
    expect(P.getState().sessionType).toBe('LongBreak');
    expect(P.getState().sessionStatus).toBe('Idle');
  });

  test('test_EC03_Paused로_저장_endTimestamp없음_만료판단없이_스냅샷_그대로_복원', () => {
    const savedAt = Date.UTC(2026, 8, 7, 9, 0, 0);
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'LongBreak', sessionStatus: 'Paused',
        endTimestamp: null, remainingSnapshot: 9 * 60000, focusSlotsConsumed: 4,
        dateAnchor: savedAt, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(savedAt + 5 * 3600 * 1000) });
    expect(P.getState().sessionStatus).toBe('Paused');
    expect(P.getState().remainingMs).toBe(9 * 60000);
  });

  test('test_EC03_완료처리된_세션_로그는_원래_종료목표시각_기준_날짜로_귀속', () => {
    const now = Date.UTC(2026, 8, 12, 8, 0, 0);
    const endTs = now - 4 * 24 * 3600 * 1000;
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'Focus', sessionStatus: 'Running',
        endTimestamp: endTs, remainingSnapshot: null, focusSlotsConsumed: 0,
        dateAnchor: endTs - 60000, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(now) });
    P.skipMemo();
    expect(P.getLog(H.dateKeyLocal(endTs)).count).toBe(1);
    expect(P.getLog(H.dateKeyLocal(now)).count).toBe(0);
  });
});

// ───────────────────────── EC-04 시스템 시계(로컬 클록) 변경 ─────────────────────────

describe('EC-04 시스템 시계 변경', () => {
  test('test_EC04_앵커대비_델타차이가_5초이상이면_세션을_즉시_Paused로_전환', () => {
    const { P, clock } = boot();
    P.start();
    run(P, clock, 30000, 1000); // 30초 정상 경과
    const remBefore = P.getState().remainingMs;
    clock.jumpWall(6000); // 시스템 시계만 +6초 (단조 시계는 그대로)
    P.tick();
    expect(P.getState().sessionStatus).toBe('Paused');
    expect(P.getState().ui).toBe('clock');
    expect(isHidden('clock-modal')).toBe(false);
    // 임의로 늘리거나 줄이지 않음: 이상 감지 직전 마지막 유효값으로 고정
    expect(P.getState().remainingMs).toBe(remBefore);
  });

  test('test_EC04_시계변경_감지시_확인알림_표시하고_재개버튼_제공', () => {
    const { P, clock } = boot();
    P.start();
    run(P, clock, 5000, 1000);
    clock.jumpWall(-10000); // 뒤로 감김
    P.tick();
    expect(P.getState().ui).toBe('clock');
    expect(isHidden('clock-modal')).toBe(false);
    expect($('btn-clock-resume')).not.toBeNull();
    expect($('clock-modal').textContent).toContain('시스템 시간 변경이 감지되어 타이머가 일시정지되었습니다');
  });

  test('test_EC04_사용자가_재개하면_현재시각기준_새_종료목표시각_계산하고_앵커_재설정', () => {
    const { P, clock } = boot();
    P.start();
    run(P, clock, 60000, 1000);
    const remBefore = P.getState().remainingMs; // 24:00
    clock.jumpWall(9000);
    P.tick(); // → Paused/clock
    clock.advance(120000); // 사용자가 2분 뒤 재개
    P.resumeAfterClockChange();
    expect(P.getState().sessionStatus).toBe('Running');
    expect(P.getState().ui).toBe('timer');
    // 남은시간은 고정되었던 값에서 이어짐 (임의 연장/단축 없음)
    expect(P.getState().remainingMs).toBe(remBefore);
    expect(P.getState().endTimestamp).toBe(clock.wall + remBefore);
    // 앵커 재설정 확인
    expect(P.getState().dateAnchor).toBe(clock.wall);
  });

  test('test_EC04_원시값_직접비교가_아니라_앵커대비_델타비교', () => {
    // Date.now() 와 performance.now() 의 원시 절대값은 크게 다르지만(1.7e12 vs 수천),
    // 델타가 함께 흐르면 시계 변경으로 오판하지 않는다.
    const clock = H.makeClock(Date.UTC(2026, 8, 7, 9, 0, 0)); // wall ~1.7e12, perf 5000
    const { P } = boot({ clock });
    P.start();
    for (let i = 0; i < 20; i++) { clock.advance(1000); P.tick(); }
    expect(P.getState().sessionStatus).toBe('Running'); // 오판 없음
  });

  test('test_EC04_탭복귀시_앵커재설정으로_절전_백그라운드동결_후_오탐지_없음', () => {
    const { P, clock } = boot();
    P.saveSettings({ focusMin: 180, shortBreakMin: 5, longBreakMin: 15 });
    P.start();
    run(P, clock, 60000, 1000);
    // 절전: 두 시계가 함께 2시간 흐른 뒤 탭 복귀
    clock.advance(2 * 3600 * 1000);
    P.onVisible(); // 앵커 재설정
    P.tick();
    expect(P.getState().sessionStatus).toBe('Running');
    expect(P.getState().ui).toBe('timer'); // 시계변경 오탐지 아님
  });
});

// ───────────────────────── EC-05 localStorage 쓰기 실패 ─────────────────────────

describe('EC-05 localStorage 쓰기 실패', () => {
  test('test_EC05_쓰기실패시_타이머_중단없이_메모리상_계속동작_경고배너_표시', () => {
    const { P, clock } = boot({ storage: makeFailingStorage() });
    P.start();
    expect(P.getState().storageStatus).toBe('write-failed');
    expect(isHidden('storage-warning')).toBe(false);
    expect(P.getState().sessionStatus).toBe('Running');
    run(P, clock, 3 * 60000, 1000);
    expect(P.getState().remainingMs).toBe(22 * 60000); // 계속 동작
  });

  test('test_EC05_경고배너_문구가_저장실패_유실가능성을_알린다', () => {
    const { P } = boot({ storage: makeFailingStorage() });
    P.start();
    expect($('storage-warning').textContent).toContain('저장되지 않고 있습니다');
  });

  test('test_EC05_이후_상태변경시점마다_자동재시도_성공하면_Synced복귀_경고해제', () => {
    const storage = makeFlakyStorage();
    storage.failWrites = true;
    const { P, clock } = boot({ storage });
    P.start();
    expect(P.getState().storageStatus).toBe('write-failed');

    storage.failWrites = false; // 저장소 회복
    P.reset();                  // 상태 변경 → persist 재시도
    expect(P.getState().storageStatus).toBe('synced');
    expect(isHidden('storage-warning')).toBe(true);
  });

  test('test_EC05_자동재시도는_tick에서도_수행되어_사용자_조작없이_회복', () => {
    const storage = makeFlakyStorage();
    storage.failWrites = true;
    const { P, clock } = boot({ storage });
    P.start();
    expect(P.getState().storageStatus).toBe('write-failed');
    storage.failWrites = false;
    clock.advance(1000);
    P.tick(); // 조작 없이 tick 만으로 재시도
    expect(P.getState().storageStatus).toBe('synced');
  });

  test('test_EC05_쓰기실패가_사용자조작을_막지_않는다', () => {
    const { P } = boot({ storage: makeFailingStorage() });
    expect(() => {
      P.start();
      P.pause();
      P.reset();
      P.skip();
    }).not.toThrow();
  });
});
