#!/usr/bin/env node
/*
 * build.js — 배포용 단일 HTML 파일 생성 (NFR-02 / NFR-03 / 12.1)
 *
 * src/*.js (UMD 모듈)를 순서대로 index.template.html 의 <!--BUNDLE--> 자리에
 * 인라인으로 삽입하여 프로젝트 루트에 index.html 을 만든다.
 *
 * 이 스택에는 트랜스파일/번들러가 없으므로 "빌드" = 인라인 결합 + 오프라인 제약 검사.
 * 검사에 실패하면 0 이 아닌 종료 코드로 끝난다 (실패 은폐 금지).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TEMPLATE = path.join(ROOT, 'index.template.html');
const OUT = path.join(ROOT, 'index.html');
const SRC_FILES = ['src/core.js', 'src/storage.js', 'src/app.js'];

function fail(msg) {
  console.error('[build] 실패: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(TEMPLATE)) fail('템플릿이 없습니다: ' + TEMPLATE);

let template = fs.readFileSync(TEMPLATE, 'utf8');
if (template.indexOf('<!--BUNDLE-->') === -1) fail('템플릿에 <!--BUNDLE--> 자리표시자가 없습니다');

const parts = [];
parts.push('/* 생성된 파일 — 편집하지 마세요. 원본: src/*.js, index.template.html */');
parts.push('(function () {');
parts.push('  "use strict";');
parts.push('  var module; // UMD 의 CommonJS 분기를 브라우저에서 비활성화');
for (const rel of SRC_FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) fail('소스 파일이 없습니다: ' + rel);
  parts.push('  /* ==== ' + rel + ' ==== */');
  parts.push(fs.readFileSync(abs, 'utf8'));
}
parts.push('  /* ==== 부트스트랩 ==== */');
parts.push('  if (document.readyState === "loading") {');
parts.push('    document.addEventListener("DOMContentLoaded", boot);');
parts.push('  } else { boot(); }');
parts.push('  function boot() {');
parts.push('    try { window.PomodoroApp.createApp({}).start(); }');
parts.push('    catch (e) { console.error("앱 시작 실패", e); }');
parts.push('  }');
parts.push('})();');

const bundle = parts.join('\n');
const html = template.replace('<!--BUNDLE-->', function () { return bundle; });

// ── 오프라인 제약 검사 (NFR-02 / 12.1) ──────────────────────────────────────
const violations = [];
if (/<script[^>]+src=/i.test(html)) violations.push('외부 <script src> 발견');
if (/<link[^>]+href\s*=\s*["']?https?:/i.test(html)) violations.push('외부 <link href> 발견');
if (/@import\s+url\(/i.test(html)) violations.push('CSS @import 발견');
if (/https?:\/\/(?!www\.w3\.org)/i.test(html.replace(/lang="ko"/g, ''))) {
  // w3.org 는 SVG/HTML 네임스페이스 URI 로만 등장할 수 있어 예외.
  const bad = html.match(/https?:\/\/(?!www\.w3\.org)[^\s"'<>)]+/i);
  if (bad) violations.push('외부 URL 참조: ' + bad[0]);
}
if (/\bsrc\s*=\s*["']http/i.test(html)) violations.push('http(s) src 발견');
if (violations.length) fail('오프라인 제약 위반 — ' + violations.join(', '));

fs.writeFileSync(OUT, html, 'utf8');
console.log('[build] 생성 완료: ' + path.relative(ROOT, OUT) + ' (' + html.length + ' bytes)');
