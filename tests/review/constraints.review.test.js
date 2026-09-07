/*
 * 독립 테스트 — 기술 제약 / 범위 검증
 *   §3.2 Out of Scope, §12.1 Technical Constraints, §12.2 Approved Decisions,
 *   NFR-02(오프라인 가용성), NFR-03(이식성)
 *
 * 배포 산출물(프로젝트 루트 index.html)의 내용으로 제약 위반 여부를 검사한다.
 * index.html 은 커밋된 배포물을 그대로 읽는다(개발 코드 수정·빌드 재실행 없음).
 *
 * @jest-environment node
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'index.html');

let html = '';
beforeAll(() => {
  expect(fs.existsSync(OUT)).toBe(true);
  html = fs.readFileSync(OUT, 'utf8');
});

describe('NFR-02 / §12.1 완전 오프라인 · 외부 네트워크 리소스 미사용', () => {
  test('test_NFR02_외부_script_src를_포함하지_않는다', () => {
    expect(/<script[^>]+\bsrc\s*=/i.test(html)).toBe(false);
  });

  test('test_NFR02_외부_link_href_또는_CSS_import를_포함하지_않는다', () => {
    expect(/<link[^>]+href\s*=\s*["']?https?:/i.test(html)).toBe(false);
    expect(/@import\b/i.test(html)).toBe(false);
  });

  test('test_NFR02_w3org_네임스페이스_URI를_제외하면_외부_http_https_URL_참조가_전혀_없다', () => {
    const matches = html.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
    const external = matches.filter((u) => !/^https?:\/\/www\.w3\.org\//i.test(u));
    expect(external).toEqual([]);
  });

  test('test_NFR02_외부_음원_파일을_참조하지_않고_Web_Audio로_합성한다 (§12.2)', () => {
    expect(/\.(mp3|wav|ogg|m4a|aac|flac|opus)\b/i.test(html)).toBe(false);
    expect(/createOscillator/.test(html)).toBe(true);
  });

  test('test_NFR02_data_URL로_외부폰트_이미지_음원을_우회_삽입하지_않는다', () => {
    expect(/url\(\s*["']?data:/i.test(html)).toBe(false);
    expect(/src\s*=\s*["']data:/i.test(html)).toBe(false);
  });
});

describe('§12.1 순수 HTML/CSS/JS · 프레임워크 미사용 · 인라인 SVG', () => {
  test('test_121_React_Vue_Angular_Svelte_등_프레임워크_번들을_포함하지_않는다', () => {
    expect(/\b(react|react-dom|vue(\.global|\.runtime)?\.js|angular|svelte|preact)\b/i.test(html)).toBe(false);
  });

  test('test_121_아이콘_등_그래픽요소는_인라인_SVG로_구현하고_외부_이미지를_쓰지_않는다', () => {
    expect(/<svg[\s>]/i.test(html)).toBe(true);
    expect(/<img\b/i.test(html)).toBe(false);
  });
});

describe('§12.2 승인된 기술 결정', () => {
  test('test_122_타이머는_setInterval_카운트다운이_아니라_endTimestamp_절대시각_방식을_사용한다', () => {
    expect(/endTimestamp/.test(html)).toBe(true);
    // 남은 시간 계산이 endTimestamp - now 형태로 존재
    expect(/endTimestamp\s*-\s*now/.test(html)).toBe(true);
  });

  test('test_122_시계변경_감지는_performance_now_앵커_델타_비교_방식이며_임계값_5초를_사용한다', () => {
    expect(/performance\.now/.test(html)).toBe(true);
    expect(/perfAnchor/.test(html)).toBe(true);
    expect(/5000/.test(html)).toBe(true);
  });

  test('test_122_localStorage를_설정_로그_타이머_별도_키로_분리_저장한다', () => {
    expect(/pomodoro\.v1\.settings/.test(html)).toBe(true);
    expect(/pomodoro\.v1\.logs/.test(html)).toBe(true);
    expect(/pomodoro\.v1\.timer/.test(html)).toBe(true);
  });
});

describe('NFR-03 이식성 — 단일 HTML 파일', () => {
  test('test_NFR03_앱_로직이_단일_HTML_파일_내_인라인_script에_포함되어_있다', () => {
    expect(/<script>[\s\S]*PomodoroApp[\s\S]*<\/script>/.test(html)).toBe(true);
  });

  test('test_NFR03_외부_모듈_로더나_import구문에_의존하지_않는다', () => {
    expect(/<script[^>]+type\s*=\s*["']module["']/i.test(html)).toBe(false);
    expect(/\bimport\s+.*\bfrom\s+["']https?:/i.test(html)).toBe(false);
  });
});

describe('§3.2 Out of Scope — 요구되지 않은 기능이 포함되지 않는다', () => {
  test('test_32_앱_내부에_데이터_삭제_전체초기화_기능이_없다 (§7.5)', () => {
    expect(/id=["'][^"']*(clear|delete|wipe|reset-all|purge)[^"']*["']/i.test(html)).toBe(false);
    expect(/localStorage\.clear\s*\(/.test(html)).toBe(false);
  });
});
