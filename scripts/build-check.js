#!/usr/bin/env node
/*
 * build-check.js — 빌드 개념이 없는 단일 HTML 스택의 "빌드" 대체(문법·구조 검사).
 *
 * 1. 프로젝트 루트에 배포 대상 HTML 이 정확히 하나만 존재하는지 (NFR-03 단일 파일)
 * 2. 인라인 <script> 가 문법적으로 유효한지 (vm.Script 파싱)
 * 3. 앱이 참조하는 필수 DOM 요소 id 가 마크업에 존재하는지
 *
 * 하나라도 실패하면 0이 아닌 코드로 종료한다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'pomodoro.html');

const errors = [];

function fail(msg) { errors.push(msg); }

// 1) 단일 HTML 파일
const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith('.html'));
if (htmlFiles.length !== 1) {
  fail(`루트 HTML 파일은 정확히 1개여야 합니다. 발견: ${JSON.stringify(htmlFiles)}`);
}
if (!fs.existsSync(APP)) {
  fail('pomodoro.html 이 존재하지 않습니다.');
}

if (errors.length) { report(); }

const html = fs.readFileSync(APP, 'utf8');

// 2) 인라인 스크립트 문법 검사
const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m;
let scriptCount = 0;
while ((m = scriptRe.exec(html)) !== null) {
  const attrs = m[1] || '';
  if (/\bsrc\s*=/.test(attrs)) {
    fail(`외부 스크립트 참조가 발견되었습니다 (src 속성): ${attrs.trim()}`);
    continue;
  }
  scriptCount += 1;
  try {
    // eslint-disable-next-line no-new
    new vm.Script(m[2], { filename: `pomodoro.html#script${scriptCount}` });
  } catch (e) {
    fail(`인라인 스크립트 #${scriptCount} 문법 오류: ${e.message}`);
  }
}
if (scriptCount === 0) {
  fail('인라인 <script> 를 찾지 못했습니다.');
}

// 3) 필수 DOM 요소 id
const requiredIds = [
  'app', 'time-display', 'session-label', 'cycle-indicator',
  'timer-controls', 'btn-start', 'btn-reset', 'btn-skip',
  'memo-panel', 'memo-input', 'btn-memo-submit', 'btn-memo-skip',
  'clock-modal', 'btn-clock-resume', 'storage-warning',
  'nav-timer', 'nav-log', 'nav-settings',
  'view-timer', 'view-log', 'view-settings',
  'log-date', 'log-count', 'log-memos',
  'set-focus', 'set-short', 'set-long', 'btn-save-settings', 'settings-error',
];
requiredIds.forEach((id) => {
  const re = new RegExp(`\\bid=["']${id}["']`);
  if (!re.test(html)) fail(`필수 DOM 요소 id="${id}" 가 마크업에 없습니다.`);
});

report();

function report() {
  if (errors.length) {
    console.error('build-check 실패:');
    errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }
  console.log('build-check 통과: 단일 HTML, 인라인 스크립트 문법, 필수 DOM 요소 확인됨.');
  process.exit(0);
}
