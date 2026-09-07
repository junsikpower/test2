'use strict';

/*
 * PRD 4. Functional Requirements — FR-01 ~ FR-08.
 * 각 기능의 Input / Processing / Output / Expected State / Acceptance Criteria 검증.
 */

const {
  boot, finishRunning, run, $, isHidden, makeMemoryStorage, dateKeyLocal,
} = require('./helpers/harness');

const okAudio = () => ({ unlock: jest.fn(() => Promise.resolve()), beep: jest.fn(() => Promise.resolve()) });
const failAudio = () => ({ unlock: jest.fn(() => Promise.resolve()), beep: jest.fn(() => Promise.reject(new Error('autoplay blocked'))) });
const grantedNotif = () => ({ permission: 'granted', show: jest.fn(), request: jest.fn(() => Promise.resolve('granted')) });
const deniedNotif = () => ({ permission: 'denied', show: jest.fn(), request: jest.fn(() => Promise.resolve('denied')) });
const defaultNotif = () => ({ permission: 'default', show: jest.fn(), request: jest.fn(() => Promise.resolve('granted')) });

// ───────────────────────── FR-01 타이머 시작/일시정지/리셋 ─────────────────────────

describe('FR-01 타이머 시작/일시정지/리셋', () => {
  test('test_FR01_시작후_남은시간이_실제경과와_일치', () => {
    const { P, clock } = boot();
    P.start();
    run(P, clock, 5 * 60000, 1000);
    expect(P.getState().remainingMs).toBe(20 * 60000);
    expect($('time-display').textContent).toBe('20:00');
    expect(P.getState().sessionStatus).toBe('Running');
  });

  test('test_FR01_일시정지후_남은시간_불변', () => {
    const { P, clock } = boot();
    P.start();
    run(P, clock, 10 * 60000, 1000);
    P.pause();
    const remAtPause = P.getState().remainingMs;
    expect(remAtPause).toBe(15 * 60000);
    clock.advance(30 * 60000);
    P.tick();
    expect(P.getState().remainingMs).toBe(remAtPause);
    expect(P.getState().sessionStatus).toBe('Paused');
  });

  test('test_FR01_리셋시_설정된길이의_Idle로_복귀', () => {
    const { P, clock } = boot();
    P.start();
    run(P, clock, 7 * 60000, 1000);
    P.reset();
    expect(P.getState().sessionStatus).toBe('Idle');
    expect(P.getState().remainingMs).toBe(25 * 60000);
  });

  test('test_FR01_리셋해도_소모된_Focus슬롯수_보존', () => {
    // 3개 슬롯 소모 상태에서 4번째 Focus 를 리셋 → 슬롯 수는 3 유지 (BR-03 병행)
    const { P } = boot();
    P.skip(); // Focus#1 스킵 → slots 1, ShortBreak 자동시작
    P.skip(); // ShortBreak 스킵 → Focus
    P.skip(); // Focus#2 스킵 → slots 2, ShortBreak
    P.skip(); // ShortBreak 스킵 → Focus
    P.skip(); // Focus#3 스킵 → slots 3, ShortBreak
    P.skip(); // ShortBreak 스킵 → Focus#4 (Running)
    expect(P.getState().focusSlotsConsumed).toBe(3);
    expect(P.getState().sessionType).toBe('Focus');
    P.reset();
    expect(P.getState().focusSlotsConsumed).toBe(3);
    expect(P.getState().sessionStatus).toBe('Idle');
    expect(P.getState().remainingMs).toBe(25 * 60000);
  });

  test('test_FR01_MemoInputPending에서는_시작_일시정지_리셋_버튼_미노출', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock); // Focus 정상 종료 → Memo-Input-Pending
    expect(P.getState().ui).toBe('memo');
    expect(isHidden('timer-controls')).toBe(true);
    expect(isHidden('memo-panel')).toBe(false);
  });
});

// ───────────────────────── FR-02 세션 종료 알림 ─────────────────────────

describe('FR-02 세션 종료 알림', () => {
  test('test_FR02_권한허용시_소리재생과_브라우저알림_동시발생', async () => {
    const audio = okAudio();
    const notification = grantedNotif();
    const { P, clock } = boot({ audio, notification });
    P.start();
    finishRunning(P, clock);
    await P.lastAlert();
    expect(notification.show).toHaveBeenCalledTimes(1);
    expect(audio.beep).toHaveBeenCalledTimes(1);
    expect(P.getState().titleFallback).toBe(false);
  });

  test('test_FR02_오디오재생_실패감지시_탭제목변경으로_대체', async () => {
    const audio = failAudio();
    const notification = grantedNotif();
    const { P, clock } = boot({ audio, notification });
    const baseTitle = document.title;
    P.start();
    finishRunning(P, clock);
    await P.lastAlert();
    expect(notification.show).toHaveBeenCalledTimes(1);
    expect(document.title).not.toBe(baseTitle);
    expect(document.title).toContain('⏰');
    expect(P.getState().titleFallback).toBe(true);
  });

  test('test_FR02_앱실행중_세션종료시점에_알림이_지체없이_발생', () => {
    const { P, clock } = boot({ audio: okAudio(), notification: grantedNotif() });
    P.start();
    expect(P.getState().alertLog.length).toBe(0);
    finishRunning(P, clock);
    expect(P.getState().alertLog.length).toBe(1);
    expect(P.getState().alertLog[0].endedType).toBe('Focus');
  });

  test('test_FR02_최초상호작용시_알림권한_요청', () => {
    const notification = defaultNotif();
    const { P } = boot({ audio: okAudio(), notification });
    P.start();
    expect(notification.request).toHaveBeenCalled();
  });
});

// ───────────────────────── FR-03 뽀모도로 사이클 자동 전환 ─────────────────────────

describe('FR-03 뽀모도로 사이클 자동 전환', () => {
  function completeFocus(P, clock, memo) {
    finishRunning(P, clock);
    expect(P.getState().ui).toBe('memo');
    P.submitMemo(memo == null ? '' : memo);
  }

  test('test_FR03_Focus정상종료시_완료카운트_증가_후_MemoInputPending', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock);
    expect(P.getState().memoPending).toBe(true);
    expect(P.getState().ui).toBe('memo');
    expect(P.getLog().count).toBe(1);
    // 이 상태에서는 다음 세션 타이머가 시작되지 않는다
    expect(P.getState().sessionStatus).toBe('Idle');
  });

  test('test_FR03_메모제출후_다음세션_자동_카운트다운_시작', () => {
    const { P, clock } = boot();
    P.start();
    completeFocus(P, clock, '작업 A');
    expect(P.getState().sessionType).toBe('ShortBreak');
    expect(P.getState().sessionStatus).toBe('Running');
  });

  test('test_FR03_4번째_Focus슬롯_소모직후_LongBreak로_전환', () => {
    const { P, clock } = boot();
    P.start();
    completeFocus(P, clock, 'f1');           // slots 1 → ShortBreak
    finishRunning(P, clock);                  // ShortBreak 종료 → Focus 자동
    completeFocus(P, clock, 'f2');           // slots 2 → ShortBreak
    finishRunning(P, clock);
    completeFocus(P, clock, 'f3');           // slots 3 → ShortBreak
    finishRunning(P, clock);
    completeFocus(P, clock, 'f4');           // slots 4 → LongBreak
    expect(P.getState().focusSlotsConsumed).toBe(4);
    expect(P.getState().sessionType).toBe('LongBreak');
    expect(P.getState().sessionStatus).toBe('Running');
    expect(P.getLog().count).toBe(4);
  });

  test('test_FR03_그외_Focus종료시_ShortBreak로_전환', () => {
    const { P, clock } = boot();
    P.start();
    completeFocus(P, clock, 'x');
    expect(P.getState().sessionType).toBe('ShortBreak');
  });

  test('test_FR03_Break종료후_메모없이_곧바로_다음Focus_시작', () => {
    const { P, clock } = boot();
    P.start();
    completeFocus(P, clock, 'x');            // → ShortBreak Running
    finishRunning(P, clock);                  // ShortBreak 종료
    expect(P.getState().ui).not.toBe('memo');
    expect(P.getState().sessionType).toBe('Focus');
    expect(P.getState().sessionStatus).toBe('Running');
  });

  test('test_FR03_LongBreak_종료후_사이클초기화되어_Focus부터_재시작', () => {
    const { P, clock } = boot();
    P.start();
    completeFocus(P, clock, 'f1'); finishRunning(P, clock);
    completeFocus(P, clock, 'f2'); finishRunning(P, clock);
    completeFocus(P, clock, 'f3'); finishRunning(P, clock);
    completeFocus(P, clock, 'f4');           // → LongBreak Running
    expect(P.getState().sessionType).toBe('LongBreak');
    finishRunning(P, clock);                  // LongBreak 종료
    expect(P.getState().sessionType).toBe('Focus');
    expect(P.getState().focusSlotsConsumed).toBe(0);
    expect(P.getState().sessionStatus).toBe('Running');
  });
});

// ───────────────────────── FR-04 세션 건너뛰기 (Skip) ─────────────────────────

describe('FR-04 세션 건너뛰기', () => {
  test('test_FR04_Focus스킵시_완료개수_불변_메모요구없음', () => {
    const { P } = boot();
    P.start();
    P.skip();
    expect(P.getLog().count).toBe(0);
    expect(P.getState().ui).toBe('timer');
    expect(P.getState().memoPending).toBe(false);
    expect(P.getState().sessionType).toBe('ShortBreak');
    expect(P.getState().sessionStatus).toBe('Running');
  });

  test('test_FR04_Focus스킵도_슬롯소모에_반영되어_LongBreak순서_정상', () => {
    // Focus 2회 스킵 + 정상 완료 2회 → 슬롯 4 소모 → LongBreak, 완료 카운트 2
    const { P, clock } = boot();
    P.start();
    P.skip();                 // Focus#1 스킵 → slots 1, ShortBreak Running
    P.skip();                 // ShortBreak 스킵 → Focus Running
    P.skip();                 // Focus#2 스킵 → slots 2, ShortBreak Running
    P.skip();                 // ShortBreak 스킵 → Focus Running
    finishRunning(P, clock);  // Focus#3 정상 종료 → slots 3, memo
    P.submitMemo('c3');       // → ShortBreak Running
    finishRunning(P, clock);  // ShortBreak 종료 → Focus Running
    finishRunning(P, clock);  // Focus#4 정상 종료 → slots 4, memo
    P.submitMemo('c4');       // → LongBreak
    expect(P.getState().focusSlotsConsumed).toBe(4);
    expect(P.getState().sessionType).toBe('LongBreak');
    expect(P.getLog().count).toBe(2);
  });

  test('test_FR04_MemoInputPending에서는_스킵버튼_미노출', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock); // → memo
    expect(isHidden('timer-controls')).toBe(true); // 스킵 버튼 포함
    const before = P.getState();
    P.skip(); // 무시되어야 함
    expect(P.getState().memoPending).toBe(true);
    expect(P.getState().sessionType).toBe(before.sessionType);
  });
});

// ───────────────────────── FR-05 작업 메모 기록 ─────────────────────────

describe('FR-05 작업 메모 기록', () => {
  test('test_FR05_Focus정상종료마다_메모입력창_표시', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock);
    expect(isHidden('memo-panel')).toBe(false);
    expect(P.getState().ui).toBe('memo');
  });

  test('test_FR05_빈값제출해도_완료카운트_정상증가_메모는_메모없음표시', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock);
    P.submitMemo('   '); // 공백만
    expect(P.getLog().count).toBe(1);
    const memos = P.getLog().memos;
    expect(memos.length).toBe(1);
    expect(memos[0].text).toBe('');
  });

  test('test_FR05_건너뛰기해도_완료카운트_정상증가', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock);
    P.skipMemo();
    expect(P.getLog().count).toBe(1);
    expect(P.getLog().memos.length).toBe(1);
    expect(P.getLog().memos[0].text).toBe('');
  });

  test('test_FR05_제출한_메모텍스트가_완료시각과_함께_로그에_추가', () => {
    const { P, clock } = boot();
    P.start();
    const endTs = P.getState().endTimestamp;
    finishRunning(P, clock);
    P.submitMemo('리팩터링 마무리');
    const entry = P.getLog().memos[0];
    expect(entry.text).toBe('리팩터링 마무리');
    expect(entry.time).toBe(endTs); // 완료 시각 = 원래 종료 목표 시각
  });
});

// ───────────────────────── FR-06 일별 로그 화면 ─────────────────────────

describe('FR-06 일별 로그 화면', () => {
  test('test_FR06_완료개수가_해당날짜_정상종료_Focus수와_일치', () => {
    const { P, clock } = boot();
    P.start();
    for (let i = 0; i < 3; i++) {
      finishRunning(P, clock);
      P.submitMemo('m' + i);
      finishRunning(P, clock); // break 종료 → 다음 Focus 자동
    }
    expect(P.getLog().count).toBe(3);
  });

  test('test_FR06_메모가_오래된순으로_정렬되어_표시', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock); P.submitMemo('첫번째');   // → ShortBreak Running
    finishRunning(P, clock);                            // ShortBreak 종료 → Focus Running
    clock.advance(3 * 60000); P.tick();                 // 조작 사이 시간 경과
    finishRunning(P, clock); P.submitMemo('두번째');   // → ShortBreak Running
    finishRunning(P, clock);                            // → Focus Running
    clock.advance(4 * 60000); P.tick();
    finishRunning(P, clock); P.submitMemo('세번째');
    const texts = P.getLog().memos.map((m) => m.text);
    expect(texts).toEqual(['첫번째', '두번째', '세번째']);
    const times = P.getLog().memos.map((m) => m.time);
    expect(times.slice().sort((a, b) => a - b)).toEqual(times);
  });

  test('test_FR06_로그화면은_저장된_데이터와_일치_DOM반영', () => {
    const { P, clock } = boot();
    P.start();
    finishRunning(P, clock); P.submitMemo('DOM 확인용');
    P.setView('log');
    expect($('log-count').textContent).toBe('1');
    const items = $('log-memos').querySelectorAll('li');
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain('DOM 확인용');
  });

  test('test_FR06_선택날짜_기본값은_오늘', () => {
    const { P, clock } = boot();
    P.setView('log');
    expect($('log-date').value).toBe(dateKeyLocal(clock.wall));
  });
});

// ───────────────────────── FR-07 설정 (세션 길이 커스터마이징) ─────────────────────────

describe('FR-07 설정', () => {
  test('test_FR07_변경저장후_새로고침해도_값_유지', () => {
    const storage = makeMemoryStorage();
    let ctx = boot({ storage });
    const r = ctx.P.saveSettings({ focusMin: 33, shortBreakMin: 7, longBreakMin: 22 });
    expect(r.ok).toBe(true);
    ctx = boot({ storage });
    expect(ctx.P.getState().settings).toEqual({ focusMin: 33, shortBreakMin: 7, longBreakMin: 22 });
  });

  test('test_FR07_범위밖_값은_저장되지_않는다', () => {
    const { P } = boot();
    const base = P.getState().settings;
    for (const bad of [0, -5, 181, 500, 5.5, 'abc', '', '  ', '10.0.1', '3e1']) {
      const r = P.saveSettings({ focusMin: bad, shortBreakMin: 5, longBreakMin: 15 });
      expect(r.ok).toBe(false);
      expect(P.getState().settings).toEqual(base);
    }
  });

  test('test_FR07_Idle세션_설정변경은_화면에_즉시_반영', () => {
    const { P } = boot();
    expect(P.getState().remainingMs).toBe(25 * 60000);
    P.saveSettings({ focusMin: 30, shortBreakMin: 5, longBreakMin: 15 });
    expect(P.getState().remainingMs).toBe(30 * 60000);
    expect($('time-display').textContent).toBe('30:00');
  });

  test('test_FR07_Running세션_설정변경은_그세션에_미적용_다음세션부터_적용', () => {
    const { P, clock } = boot();
    P.start(); // Focus 25분 Running
    clock.advance(60000); P.tick();
    expect(P.getState().remainingMs).toBe(24 * 60000);
    P.saveSettings({ focusMin: 40, shortBreakMin: 5, longBreakMin: 15 });
    expect(P.getState().remainingMs).toBe(24 * 60000); // 기존 길이 유지
    finishRunning(P, clock); P.submitMemo('m'); // → ShortBreak Running
    finishRunning(P, clock);                     // ShortBreak 종료 → 다음 Focus 자동시작
    expect(P.getState().sessionType).toBe('Focus');
    expect(P.getState().remainingMs).toBe(40 * 60000); // 새 값 적용
  });

  test('test_FR07_Paused세션_설정변경은_그세션에_미적용', () => {
    const { P, clock } = boot();
    P.start();
    run(P, clock, 5 * 60000, 1000);
    P.pause();
    expect(P.getState().remainingMs).toBe(20 * 60000);
    P.saveSettings({ focusMin: 50, shortBreakMin: 5, longBreakMin: 15 });
    expect(P.getState().remainingMs).toBe(20 * 60000); // 스냅샷 유지
  });
});

// ───────────────────────── FR-08 데이터 영속성 및 상태 복원 ─────────────────────────

describe('FR-08 데이터 영속성 및 상태 복원', () => {
  test('test_FR08_임의시점_새로고침해도_진행상태_설정_로그_유지', () => {
    const storage = makeMemoryStorage();
    let ctx = boot({ storage });
    ctx.P.saveSettings({ focusMin: 20, shortBreakMin: 5, longBreakMin: 15 });
    ctx.P.start();
    run(ctx.P, ctx.clock, 7 * 60000, 1000); // 13분 남음
    ctx.P.setView('log'); // no-op for data
    const remBefore = ctx.P.getState().remainingMs;
    expect(remBefore).toBe(13 * 60000);

    // 같은 저장소 + 같은 시각으로 재부팅(새로고침)
    const clock2 = ctx.clock;
    ctx = boot({ storage, clock: clock2 });
    expect(ctx.P.getState().sessionType).toBe('Focus');
    expect(ctx.P.getState().sessionStatus).toBe('Running');
    expect(ctx.P.getState().remainingMs).toBe(13 * 60000);
    expect(ctx.P.getState().settings.focusMin).toBe(20);
  });

  test('test_FR08_Running저장_다중세션경과후_재접속_1회만_종료처리_후_다음세션_Idle대기', () => {
    const now = Date.UTC(2026, 8, 7, 12, 0, 0);
    // 90분 전에 25분짜리 Focus 가 시작되어 이미 만료됨 (여러 세션 경과 가능)
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'Focus', sessionStatus: 'Running',
        endTimestamp: now - 65 * 60000,
        remainingSnapshot: null, focusSlotsConsumed: 1,
        dateAnchor: now - 90 * 60000, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const storage = require('./helpers/harness').makeMemoryStorage(seed);
    const clock = require('./helpers/harness').makeClock(now);
    const { P } = boot({ storage, clock });
    // 1회만 종료 처리 → Focus 였으므로 완료 카운트 +1 & Memo-Input-Pending(복원 경로)
    expect(P.getState().memoPending).toBe(true);
    expect(P.getState().pendingFromRestore).toBe(true);
    expect(P.getLog(dateKeyLocal(now - 65 * 60000)).count).toBe(1);
    // 메모 제출 → 다음 세션은 자동 시작되지 않고 Idle 대기 (BR-02)
    P.submitMemo('복원 후 메모');
    expect(P.getState().sessionStatus).toBe('Idle');
    expect(P.getState().sessionType).toBe('ShortBreak');
  });

  test('test_FR08_완료처리된_세션의_로그귀속날짜는_원래_종료목표시각_기준', () => {
    const now = Date.UTC(2026, 8, 10, 9, 0, 0);
    const endTs = now - 3 * 24 * 3600 * 1000; // 3일 전
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'Focus', sessionStatus: 'Running',
        endTimestamp: endTs, remainingSnapshot: null, focusSlotsConsumed: 0,
        dateAnchor: endTs - 60000, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const H = require('./helpers/harness');
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(now) });
    P.submitMemo('오래된 세션');
    const oldKey = dateKeyLocal(endTs);
    const todayKey = dateKeyLocal(now);
    expect(oldKey).not.toBe(todayKey);
    expect(P.getLog(oldKey).count).toBe(1);
    expect(P.getLog(todayKey).count).toBe(0);
  });

  test('test_FR08_Paused저장_재접속시_오프라인시간과_무관하게_남은시간_스냅샷_그대로', () => {
    const savedAt = Date.UTC(2026, 8, 7, 9, 0, 0);
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'Focus', sessionStatus: 'Paused',
        endTimestamp: null, remainingSnapshot: 7 * 60000, focusSlotsConsumed: 2,
        dateAnchor: savedAt, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const H = require('./helpers/harness');
    // 10시간 뒤에 재접속
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(savedAt + 10 * 3600 * 1000) });
    expect(P.getState().sessionStatus).toBe('Paused');
    expect(P.getState().remainingMs).toBe(7 * 60000);
    expect(P.getState().focusSlotsConsumed).toBe(2);
  });

  test('test_FR08_복원후_다음세션은_자동시작되지_않고_Idle로_대기', () => {
    const now = Date.UTC(2026, 8, 7, 12, 0, 0);
    const seed = {
      'pomodoro.timer': JSON.stringify({
        sessionType: 'ShortBreak', sessionStatus: 'Running',
        endTimestamp: now - 10 * 60000, remainingSnapshot: null, focusSlotsConsumed: 1,
        dateAnchor: now - 15 * 60000, perfAnchor: 1000,
        memoPending: false, pendingCompletionTime: null, pendingFromRestore: false,
      }),
    };
    const H = require('./helpers/harness');
    const { P } = boot({ storage: H.makeMemoryStorage(seed), clock: H.makeClock(now) });
    // 만료된 ShortBreak 1회 종료 → 다음 Focus 는 Idle 대기 (자동 시작 아님)
    expect(P.getState().sessionType).toBe('Focus');
    expect(P.getState().sessionStatus).toBe('Idle');
  });
});
