#!/usr/bin/env node
/*
 * lint.js — 정적 검사.
 *
 * A. 오프라인 제약(NFR-02 / 12.1): 배포 HTML 이 외부 네트워크 리소스에 의존하지 않는지
 *    - http(s):// 절대 URL (SVG 네임스페이스 www.w3.org 만 허용)
 *    - <script src> / <link rel=stylesheet> / <img src=http...> / @import
 *    - fetch( / XMLHttpRequest / navigator.sendBeacon / EventSource / WebSocket / importScripts
 *    - 프레임워크(react/vue/angular) 로드 흔적
 * B. 프로젝트 내 모든 .js (scripts/, tests/) 를 `node --check` 로 문법 검사
 *
 * 위반이 하나라도 있으면 0이 아닌 코드로 종료한다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'pomodoro.html');
const errors = [];
const fail = (msg) => errors.push(msg);

// ---------- A. 오프라인 제약 ----------
const html = fs.readFileSync(APP, 'utf8');
const lines = html.split(/\r?\n/);

const urlRe = /(https?:)\/\/[^\s"'<>)]+/gi;
lines.forEach((line, i) => {
  let m;
  urlRe.lastIndex = 0;
  while ((m = urlRe.exec(line)) !== null) {
    const url = m[0];
    // 인라인 SVG 에 필요한 W3C 네임스페이스 URI 는 네트워크 접근이 아니므로 허용
    if (/^https?:\/\/www\.w3\.org\//i.test(url)) continue;
    fail(`외부 URL 발견 (line ${i + 1}): ${url}`);
  }
});

const forbidden = [
  [/<script\b[^>]*\bsrc\s*=/i, '<script src> 외부 스크립트'],
  [/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i, '<link rel=stylesheet> 외부 스타일'],
  [/<link\b[^>]*\bhref\s*=\s*["']https?:/i, '<link href=http...> 외부 리소스'],
  [/@import\b/i, '@import 규칙'],
  [/\bfetch\s*\(/, 'fetch() 네트워크 호출'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bnavigator\s*\.\s*sendBeacon\b/, 'navigator.sendBeacon'],
  [/\bnew\s+EventSource\b/, 'EventSource'],
  [/\bnew\s+WebSocket\b/, 'WebSocket'],
  [/\bimportScripts\s*\(/, 'importScripts()'],
  [/\bcdn\b/i, 'CDN 참조로 보이는 문자열'],
  [/\breact(-dom)?\b/i, 'React 로드 흔적'],
  [/\bvue(\.js)?\b/i, 'Vue 로드 흔적'],
  [/\bangular\b/i, 'Angular 로드 흔적'],
];
forbidden.forEach(([re, label]) => {
  if (re.test(html)) fail(`금지된 패턴: ${label}`);
});

// ---------- B. .js 문법 검사 ----------
function collectJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectJs(p));
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const jsFiles = [
  ...collectJs(path.join(ROOT, 'scripts')),
  ...collectJs(path.join(ROOT, 'tests')),
  path.join(ROOT, 'jest.config.js'),
];
jsFiles.forEach((f) => {
  if (!fs.existsSync(f)) return;
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail(`문법 오류: ${path.relative(ROOT, f)} — ${String(e.stderr || e.message).trim()}`);
  }
});

// ---------- 결과 ----------
if (errors.length) {
  console.error('lint 실패:');
  errors.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
console.log(`lint 통과: 오프라인 제약 위반 없음, .js ${jsFiles.length}개 문법 정상.`);
process.exit(0);
