/*
 * 자체 테스트 — 기술 제약 및 범위 (3.2 Out of Scope, 12.1 Technical Constraints,
 * NFR-02 오프라인 가용성, NFR-03 이식성)
 *
 * 배포 산출물(index.html)을 빌드해 그 내용으로 제약 위반 여부를 검사한다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'index.html');

let html = '';
beforeAll(() => {
  execFileSync(process.execPath, ['build.js'], { cwd: ROOT, stdio: 'pipe' });
  html = fs.readFileSync(OUT, 'utf8');
});

describe('12.1 / NFR-02 완전 오프라인 · 외부 리소스 미사용', () => {
  test('test_NFR02_외부_script_src를_포함하지_않는다', () => {
    expect(/<script[^>]+\bsrc\s*=/i.test(html)).toBe(false);
  });

  test('test_NFR02_외부_link_href_또는_CSS_import를_포함하지_않는다', () => {
    expect(/<link[^>]+href\s*=\s*["']?https?:/i.test(html)).toBe(false);
    expect(/@import\s+url\(/i.test(html)).toBe(false);
  });

  test('test_NFR02_http_또는_https_외부URL_참조가_없다 (w3.org 네임스페이스 URI 제외)', () => {
    const matches = html.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
    const external = matches.filter((u) => !/^https?:\/\/www\.w3\.org\//i.test(u));
    expect(external).toEqual([]);
  });

  test('test_NFR02_외부_음원_파일_참조_대신_Web_Audio로_합성한다', () => {
    expect(/\.(mp3|wav|ogg|m4a)\b/i.test(html)).toBe(false);
    expect(/createOscillator/.test(html)).toBe(true);
  });
});

describe('12.1 순수 HTML/CSS/JS · 프레임워크 미사용 · 인라인 SVG', () => {
  test('test_121_React_Vue_등_프레임워크_번들을_포함하지_않는다', () => {
    expect(/react|react-dom|vue(\.global)?\.js|angular|svelte/i.test(html)).toBe(false);
  });

  test('test_121_아이콘은_인라인_SVG로_구현한다', () => {
    expect(/<svg[\s>]/i.test(html)).toBe(true);
    expect(/<img[^>]+src=/i.test(html)).toBe(false);
  });

  test('test_122_타이머는_endTimestamp_절대시각_방식을_사용한다', () => {
    expect(/endTimestamp/.test(html)).toBe(true);
  });

  test('test_122_시계변경_감지는_performance_now_앵커_델타_비교를_사용한다', () => {
    expect(/performance\.now/.test(html)).toBe(true);
    expect(/perfAnchor/.test(html)).toBe(true);
  });
});

describe('NFR-03 이식성 — 단일 HTML 파일', () => {
  test('test_NFR03_단일_HTML_파일_하나로_실행_가능하다 (인라인 스크립트 포함)', () => {
    expect(fs.existsSync(OUT)).toBe(true);
    expect(/<script>[\s\S]*PomodoroApp[\s\S]*<\/script>/.test(html)).toBe(true);
  });
});

describe('3.2 Out of Scope — 요구되지 않은 기능이 포함되지 않는다', () => {
  test('test_32_앱_내부에_데이터_삭제_초기화_기능이_없다 (7.5)', () => {
    // 로그/설정/전체 데이터를 지우는 UI 컨트롤이 존재하지 않아야 한다.
    expect(/id=["'][^"']*(clear|delete|reset-all|wipe)[^"']*["']/i.test(html)).toBe(false);
    expect(/localStorage\.clear\s*\(/.test(html)).toBe(false);
  });
});
