/*
 * 독립 테스트 — 세션 종료 알림의 소리 재생 실패 폴백 (src/app.js fireNotification)
 *
 * ── PRD 근거 ────────────────────────────────────────────────────────────────
 *   FR-02 Processing:
 *     "소리 알림은 브라우저 알림 권한 상태와 무관하게 항상 재생을 시도하는 주 알림 수단이다."
 *     "오디오 재생 실패는 play() 호출의 Promise 거부로 감지 가능하므로, 실패 시
 *      탭 제목 변경으로 즉시 대체한다."
 *   FR-02 Acceptance Criteria 2: 권한 허용 시 소리 재생과 브라우저 알림 호출이 함께 발생.
 *   FR-02 Acceptance Criteria 3: 오디오 재생이 실패로 감지되면 탭 제목 변경으로 대체된다.
 *   EC-01: 권한 거부/미지원 시 소리 + 탭 제목 변경.
 *
 * ── 최신 커밋 코드 근거 (git diff HEAD~1 HEAD -- src/app.js index.html) ──────
 *   fireNotification() 이 이번 회차에 다음과 같이 바뀌었다.
 *     (1) beeper.play() 의 "동기 예외"를 try/catch 로 흡수해 Promise.resolve(false) 로 정규화
 *     (2) soundPromise 를 Promise.resolve(x).then(onFulfilled, onRejected) 로 감싸
 *         Promise "거부"도 실패로 처리 (이전 코드에는 거부 핸들러가 없어 미처리 거부가 났음)
 *     (3) ok === false 이면 데스크톱 알림 호출 여부와 무관하게 탭 제목 폴백을 수행
 *   → 위 세 분기와 "예외 전파 없음 / 미처리 Promise 거부 없음" 을 검증한다.
 *
 * 외부 서비스(Web Audio / Notification)는 전부 테스트 더블로 대체한다
 * (§CI 계약 4-나: 실호출 테스트는 설계 제외).
 *
 * @jest-environment jsdom
 */
'use strict';

const { bootApp, teardown } = require('./_helpers');

afterEach(teardown);

/** 동기 예외를 던지는 beeper 더블. */
function throwingBeeper() {
  return { unlock: jest.fn(), play: jest.fn(() => { throw new Error('sync autoplay error'); }) };
}
/** Promise 를 거부하는 beeper 더블. */
function rejectingBeeper() {
  return { unlock: jest.fn(), play: jest.fn(() => Promise.reject(new Error('autoplay blocked'))) };
}
/** ok=false 로 resolve 하는(=재생 실패 감지) beeper 더블. */
function failingBeeper() {
  return { unlock: jest.fn(), play: jest.fn(() => Promise.resolve(false)) };
}
/** 정상 재생 beeper 더블. */
function okBeeper() {
  return { unlock: jest.fn(), play: jest.fn(() => Promise.resolve(true)) };
}

async function flushMicrotasks() {
  // Promise.resolve(soundPromise).then(...) 체인은 최대 2 마이크로태스크 뒤에 폴백을 건다.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const FALLBACK_MARK = /●/; // activateTitleFallback 이 붙이는 접두 마커

describe('FR-02 세션 종료 알림 — 소리 재생 실패 시 탭 제목 폴백', () => {
  test('test_FR02_소리재생이_실패로_감지되면_탭제목_변경으로_대체된다', async () => {
    // 재현: 권한 허용 + 오디오 재생 실패(ok=false) 상태에서 세션 종료 알림 발생.
    const { ctrl } = bootApp({ notification: 'granted', beeper: failingBeeper() });
    expect(document.title).not.toMatch(FALLBACK_MARK);

    ctrl._internals.fireNotification('집중 세션 완료 — 메모를 입력하세요');
    await flushMicrotasks();

    expect(document.title).toMatch(FALLBACK_MARK);
    expect(document.title).toContain('집중 세션 완료');
  });

  test('test_FR02_소리재생_Promise가_거부되면_실패로_보고_탭제목_변경으로_대체된다', async () => {
    // FR-02 Processing: "오디오 재생 실패는 play() 호출의 Promise 거부로 감지 가능"
    const { ctrl } = bootApp({ notification: 'granted', beeper: rejectingBeeper() });
    const before = document.title;

    ctrl._internals.fireNotification('휴식 종료 — 다음 집중을 시작합니다');
    await flushMicrotasks();

    expect(document.title).not.toBe(before);
    expect(document.title).toMatch(FALLBACK_MARK);
  });

  test('test_FR02_권한허용_소리재생_성공시에는_탭제목을_변경하지_않는다', async () => {
    // FR-02 AC2: 권한 허용 + 소리 성공이면 소리+데스크톱 알림만. 탭 제목 폴백은 일어나지 않아야 한다.
    const beeper = okBeeper();
    const { ctrl, notification } = bootApp({ notification: 'granted', beeper });
    const before = document.title;

    ctrl._internals.fireNotification('집중 세션 완료 — 메모를 입력하세요');
    await flushMicrotasks();

    expect(beeper.play).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledTimes(1); // 브라우저 알림 동시 발송
    expect(document.title).toBe(before);           // 소리 성공 → 폴백 없음
    expect(document.title).not.toMatch(FALLBACK_MARK);
  });

  test('test_FR02_세션_만료_실제경로에서도_소리실패시_탭제목으로_대체된다', async () => {
    // 직접 호출이 아닌 실제 만료 경로(evaluate → completeExpiredSession → fireNotification).
    const MIN = 60 * 1000;
    const { ctrl, clock } = bootApp({ notification: 'granted', beeper: failingBeeper() });
    const before = document.title;
    ctrl._internals.onStartPause();                 // Focus 시작
    clock.advance(25 * MIN + 1000);
    ctrl.evaluate();                                // 만료 → 알림
    await flushMicrotasks();

    expect(document.title).not.toBe(before);
    expect(document.title).toMatch(FALLBACK_MARK);
  });
});

/* ── 커밋 코드 기반(INT): fireNotification 의 이번 회차 변경 분기 ─────────────── */
describe('INT fireNotification — 동기 예외 흡수 / Promise 거부 처리 / !ok 무조건 폴백', () => {
  test('test_INT_beeper_play가_동기예외를_던져도_fireNotification은_예외를_전파하지_않는다', () => {
    const { ctrl } = bootApp({ notification: 'granted', beeper: throwingBeeper() });
    expect(() => ctrl._internals.fireNotification('세션 종료')).not.toThrow();
  });

  test('test_INT_beeper_play_동기예외시에도_탭제목_폴백이_수행된다', async () => {
    // 커밋 변경: catch → Promise.resolve(false) → then(onFulfilled) 에서 !ok 분기로 폴백.
    const { ctrl } = bootApp({ notification: 'granted', beeper: throwingBeeper() });
    const before = document.title;

    ctrl._internals.fireNotification('세션 종료');
    await flushMicrotasks();

    expect(document.title).not.toBe(before);
    expect(document.title).toMatch(FALLBACK_MARK);
  });

  test('test_INT_소리재생_Promise거부시_미처리_unhandledRejection이_발생하지_않는다', async () => {
    // 커밋 변경: Promise.resolve(x).then(onFulfilled, onRejected) 로 거부 핸들러를 신설.
    // 이전 코드(soundPromise.then(fn)) 였다면 여기서 미처리 Promise 거부가 발생한다.
    const seen = [];
    const onUnhandled = (reason) => { seen.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { ctrl } = bootApp({ notification: 'granted', beeper: rejectingBeeper() });
      ctrl._internals.fireNotification('세션 종료');
      await new Promise((r) => setTimeout(r, 40));
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });

  test('test_INT_ok가_false면_데스크톱알림이_호출된_granted상황에서도_탭제목_폴백한다', async () => {
    // 커밋 변경: usedDesktop 여부와 무관하게 if(!ok) activateTitleFallback.
    const beeper = failingBeeper();
    const { ctrl, notification } = bootApp({ notification: 'granted', beeper });
    const before = document.title;

    ctrl._internals.fireNotification('휴식이 종료되었습니다');
    await flushMicrotasks();

    expect(notification).toHaveBeenCalledTimes(1); // 데스크톱 알림은 호출됨
    expect(document.title).not.toBe(before);       // 그래도 탭 제목 폴백
    expect(document.title).toMatch(FALLBACK_MARK);
  });

  test('test_INT_fireNotification_반복호출시_소리성공이면_제목이_원복상태로_유지된다', async () => {
    // 폴백이 없는 정상 경로를 반복해도 제목 오염이 누적되지 않는지(회귀) 확인.
    const beeper = okBeeper();
    const { ctrl } = bootApp({ notification: 'granted', beeper });
    const before = document.title;

    ctrl._internals.fireNotification('a');
    ctrl._internals.fireNotification('b');
    await flushMicrotasks();

    expect(document.title).toBe(before);
    expect(beeper.play).toHaveBeenCalledTimes(2);
  });
});
