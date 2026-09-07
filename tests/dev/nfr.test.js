'use strict';

/*
 * PRD 10. Non-Functional Requirements — NFR-01 ~ NFR-03.
 * 3.2 Out of Scope / 12.1 Technical Constraints 위배 여부도 함께 검증한다.
 */

const fs = require('fs');
const path = require('path');
const { boot, run, HTML_PATH } = require('./helpers/harness');

const HTML = fs.readFileSync(HTML_PATH, 'utf8');

// ───────────────────────── NFR-01 타이머 정확도 (드리프트 없음) ─────────────────────────

describe('NFR-01 타이머 정확도', () => {
  test('test_NFR01_장시간_연속구동해도_표시시간과_실제경과시간_누적오차_없음', () => {
    const { P, clock } = boot();
    P.saveSettings({ focusMin: 180, shortBreakMin: 5, longBreakMin: 15 });
    P.start();
    const end0 = P.getState().endTimestamp;
    // 2시간 50분을 5분 스텝으로 경과 (틱 34회)
    run(P, clock, 170 * 60000, 5 * 60000);
    expect(P.getState().endTimestamp).toBe(end0); // 재계산에 의한 이동 없음
    expect(P.getState().remainingMs).toBe(10 * 60000); // 정확히 10분
    // 이어서 1초 스텝으로 9분 59초 → 정확히 1초 남음
    run(P, clock, 10 * 60000 - 1000, 1000);
    expect(P.getState().remainingMs).toBe(1000);
  });

  test('test_NFR01_불규칙한_틱_간격에도_절대시각기준_남은시간_정확', () => {
    const { P, clock } = boot();
    P.start();
    const steps = [1234, 50, 9999, 300000, 7, 60000, 45000];
    let total = 0;
    for (const s of steps) { clock.advance(s); P.tick(); total += s; }
    expect(P.getState().remainingMs).toBe(25 * 60000 - total);
  });

  test('test_NFR01_시스템시계_변경감지는_EC04_델타비교_알고리즘으로_수행', () => {
    const { P, clock } = boot();
    P.start();
    run(P, clock, 10000, 1000);
    clock.jumpWall(5000); // 임계값 경계
    P.tick();
    expect(P.getState().sessionStatus).toBe('Paused');
    expect(P.getState().ui).toBe('clock');
  });
});

// ───────────────────────── NFR-02 오프라인 가용성 ─────────────────────────

describe('NFR-02 오프라인 가용성 (외부 리소스 미의존)', () => {
  test('test_NFR02_외부_네트워크_URL을_포함하지_않는다_W3C네임스페이스만_예외', () => {
    const urls = HTML.match(/(https?:)\/\/[^\s"'<>)]+/gi) || [];
    const external = urls.filter((u) => !/^https?:\/\/www\.w3\.org\//i.test(u));
    expect(external).toEqual([]);
  });

  test('test_NFR02_외부_스크립트_스타일_폰트_import를_사용하지_않는다', () => {
    expect(/<script\b[^>]*\bsrc\s*=/i.test(HTML)).toBe(false);
    expect(/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(HTML)).toBe(false);
    expect(/@import\b/i.test(HTML)).toBe(false);
    expect(/@font-face\b/i.test(HTML)).toBe(false);
  });

  test('test_NFR02_네트워크_API_fetch_XHR_WebSocket_sendBeacon_미사용', () => {
    expect(/\bfetch\s*\(/.test(HTML)).toBe(false);
    expect(/\bXMLHttpRequest\b/.test(HTML)).toBe(false);
    expect(/\bnew\s+WebSocket\b/.test(HTML)).toBe(false);
    expect(/\bnavigator\s*\.\s*sendBeacon\b/.test(HTML)).toBe(false);
    expect(/\bnew\s+EventSource\b/.test(HTML)).toBe(false);
  });

  test('test_NFR02_저장소_주입없이_부팅해도_예외없이_동작한다', () => {
    // localStorage 자체가 없는 환경 모사 (storage: null)
    const { P } = boot({ storage: null });
    expect(() => P.start()).not.toThrow();
    expect(P.getState().sessionStatus).toBe('Running');
    expect(P.getState().storageStatus).toBe('write-failed');
  });
});

// ───────────────────────── NFR-03 이식성 (단일 HTML 파일) ─────────────────────────

describe('NFR-03 이식성', () => {
  test('test_NFR03_배포대상은_단일_HTML_파일이다', () => {
    const rootHtml = fs
      .readdirSync(path.dirname(HTML_PATH))
      .filter((f) => f.toLowerCase().endsWith('.html'));
    expect(rootHtml).toEqual(['pomodoro.html']);
  });

  test('test_NFR03_HTML_CSS_JS가_한_파일에_인라인되어_있다', () => {
    expect(/<style[\s>]/i.test(HTML)).toBe(true);
    expect(/<script[\s>]/i.test(HTML)).toBe(true);
    // 인라인 스크립트에 앱 로직이 들어 있다
    expect(/window\.Pomodoro\s*=/.test(HTML)).toBe(true);
  });
});

// ───────────────────────── 12.1 기술 제약 / 3.2 Out of Scope ─────────────────────────

describe('12.1 Technical Constraints / 3.2 Out of Scope', () => {
  test('test_12_1_프레임워크_React_Vue_Angular_미사용', () => {
    // (근거: 12.1 "별도 프레임워크를 사용하지 않고 순수 HTML/CSS/JS")
    expect(/\breact(-dom)?\b/i.test(HTML)).toBe(false);
    expect(/\bvue(\.js)?\b/i.test(HTML)).toBe(false);
    expect(/\bangular\b/i.test(HTML)).toBe(false);
  });

  test('test_12_1_아이콘은_인라인_SVG로_구현되어_있다', () => {
    // (근거: 12.1 "아이콘 등 그래픽 요소는 인라인 SVG로 구현한다")
    expect(/<svg\b[\s\S]*?<\/svg>/i.test(HTML)).toBe(true);
    expect(/<img\b[^>]*\bsrc\s*=\s*["']https?:/i.test(HTML)).toBe(false);
  });

  test('test_12_2_타이머계산_절대_종료시각_사용_setInterval_카운트다운_아님', () => {
    // (근거: 12.2 "setInterval 카운트다운이 아닌 Date.now() 기반 endTimestamp")
    expect(/endTimestamp/.test(HTML)).toBe(true);
    expect(/Date\.now\(\)/.test(HTML) || /\.now\s*\(\)/.test(HTML)).toBe(true);
  });

  test('test_3_2_OS_브라우저_알림_미표시_감지_로직을_두지_않는다', () => {
    // 3.2: JS로 감지 불가능한 영역이므로 감지·보정하지 않는다.
    // 알림이 granted 이고 show 가 정상 호출되면, 표시 여부를 재확인하는 폴링/타이머가 없다.
    const notification = { permission: 'granted', show: jest.fn(), request: jest.fn(() => Promise.resolve('granted')) };
    const audio = { unlock: jest.fn(() => Promise.resolve()), beep: jest.fn(() => Promise.resolve()) };
    const { P, clock } = boot({ notification, audio });
    P.start();
    clock.advance(25 * 60000 + 1000);
    P.tick();
    expect(notification.show).toHaveBeenCalledTimes(1);
    // 추가 시간 경과에도 재검증 호출이 없다
    clock.advance(60 * 60000);
    P.tick();
    expect(notification.show).toHaveBeenCalledTimes(1);
  });
});
