'use strict';
/*
 * 자체 테스트 계획 (CLAUDE.md 요구사항)
 * ----------------------------------------------------------------------
 * pomodoro-timer.html의 인라인 <script>를 추출해 실제 배포 코드 그대로
 * Node.js에서 require() 하고, localStorage/Notification을 모킹하며
 * Date.now()/performance.now()를 조작 가능한 가짜 시계로 대체해
 * 실시간 대기 없이 정밀하게 검증한다.
 *
 * 실행: node tests/run-tests.js
 *
 * 커버리지:
 *   - FR-01~FR-08 각 Acceptance Criteria
 *   - BR-01~BR-04
 *   - EC-01, EC-03, EC-04, EC-05 (EC-02는 visibilitychange 실제 DOM 이벤트에
 *     의존하므로 Node 단위테스트 범위 밖 — 기반 로직인 endTimestamp 재계산은
 *     다른 테스트로 커버되며, 실제 이벤트 배선은 코드 리뷰로 확인)
 *   - NFR-01 (장시간 무드리프트)
 *   - 13.2 System Acceptance (정상 흐름 + 재접속 복원 Running/Paused 각각)
 *   - 손상된 저장 데이터에 대한 방어적 정규화
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HTML_PATH = path.join(__dirname, '..', 'pomodoro-timer.html');
const TMP_JS = path.join(os.tmpdir(), 'pomodoro-app-under-test.' + process.pid + '.js');

const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptMatch = html.match(/<script>\n\(function[\s\S]*?\)\(typeof window[\s\S]*?\);\n<\/script>/);
if (!scriptMatch) throw new Error('인라인 스크립트를 찾을 수 없습니다.');
const scriptBody = scriptMatch[0].replace(/^<script>\n/, '').replace(/\n<\/script>$/, '');
fs.writeFileSync(TMP_JS, scriptBody, 'utf8');

/* ---------------- Mocks ---------------- */
function makeLocalStorageMock() {
  const store = new Map();
  let failing = false;
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) {
      if (failing) throw new Error('QuotaExceededError (simulated)');
      store.set(k, String(v));
    },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
    _setFailing(v) { failing = v; }
  };
}

let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
let fakePerf = 0;
const realDateNow = Date.now.bind(Date);
const realPerfNow = performance.now.bind(performance);
Date.now = () => fakeNow;
performance.now = () => fakePerf;
function advance(ms) { fakeNow += ms; fakePerf += ms; }
function jumpClockOnly(ms) { fakeNow += ms; }

global.localStorage = makeLocalStorageMock();

let notifCalls = [];
global.Notification = function (title, opts) { notifCalls.push({ title: title, opts: opts }); };
global.Notification.permission = 'granted';
global.Notification.requestPermission = function () { return Promise.resolve('granted'); };

function flushMicrotasks() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

/* ---------------- Runner ---------------- */
let pass = 0, fail = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { pass++; } else { fail++; failures.push(msg); console.log('  FAIL: ' + msg); }
}
function assertEqual(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, msg + '  [expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual) + ']');
}

function freshMod() {
  delete require.cache[require.resolve(TMP_JS)];
  return require(TMP_JS);
}

function resetStorage() {
  global.localStorage.clear();
  global.localStorage._setFailing(false);
  notifCalls = [];
}

/* ================= TEST GROUPS ================= */

async function testPureHelpers() {
  console.log('* pure helpers');
  const mod = freshMod();
  assertEqual(mod.formatMMSS(0), '00:00', 'formatMMSS 0ms');
  assertEqual(mod.formatMMSS(59000), '00:59', 'formatMMSS 59s');
  assertEqual(mod.formatMMSS(60000), '01:00', 'formatMMSS 60s');
  assertEqual(mod.formatMMSS(180 * 60000), '180:00', 'formatMMSS 180min boundary (FR-07 max)');
  assertEqual(mod.formatMMSS(-500), '00:00', 'formatMMSS negative clamps to 0');

  assert(mod.validateSessionMinutes(1) === true, 'validate 1 ok (boundary)');
  assert(mod.validateSessionMinutes(180) === true, 'validate 180 ok (boundary)');
  assert(mod.validateSessionMinutes(0) === false, 'validate 0 rejected');
  assert(mod.validateSessionMinutes(181) === false, 'validate 181 rejected');
  assert(mod.validateSessionMinutes(1.5) === false, 'validate 1.5 (decimal) rejected');
  assert(mod.validateSessionMinutes(NaN) === false, 'validate NaN rejected');

  assertEqual(mod.sanitizeSettings({ focus: 10, shortBreak: 999, longBreak: 'x' }),
    { focus: 10, shortBreak: 5, longBreak: 15 }, 'sanitizeSettings partial per-field fallback');
  assertEqual(mod.sanitizeSettings(null), mod.DEFAULT_SETTINGS, 'sanitizeSettings null -> defaults');

  assertEqual(mod.computeNextType('focus', 1), 'shortBreak', 'BR-01: next after 1st focus -> shortBreak');
  assertEqual(mod.computeNextType('focus', 4), 'longBreak', 'BR-01: next after 4th focus -> longBreak');
  assertEqual(mod.computeNextType('shortBreak', 2), 'focus', 'BR-01: next after shortBreak -> focus');
  assertEqual(mod.computeNextType('longBreak', 4), 'focus', 'BR-01: next after longBreak -> focus');
}

async function testStartPauseReset() {
  console.log('* FR-01 start/pause/reset');
  resetStorage();
  const mod = freshMod();
  mod.boot();
  let s = mod.getState();
  assertEqual(s.timer.status, 'idle', 'initial idle');
  assertEqual(s.timer.sessionType, 'focus', 'initial focus');

  mod.startOrResume();
  s = mod.getState();
  assertEqual(s.timer.status, 'running', 'after start -> running');
  assertEqual(s.timer.endTimestamp, fakeNow + 25 * 60000, 'endTimestamp = now + 25min (default)');

  advance(10 * 60000);
  mod.pause();
  s = mod.getState();
  assertEqual(s.timer.status, 'paused', 'after pause -> paused');
  assertEqual(s.timer.remainingMs, 15 * 60000, 'remaining snapshot = 15min');

  advance(999999);
  s = mod.getState();
  assertEqual(s.timer.remainingMs, 15 * 60000, 'AC: paused remaining does not change while paused');

  mod.resetCurrentSession();
  s = mod.getState();
  assertEqual(s.timer.status, 'idle', 'AC: reset returns to idle');
  assertEqual(s.timer.remainingMs, null, 'reset clears remaining snapshot');
}

async function testFullCycleAndSlots() {
  console.log('* BR-01/BR-03/BR-04/FR-03/FR-04 full cycle');
  resetStorage();
  const mod = freshMod();
  mod.boot();

  function expectTypeStatus(type, status, msg) {
    const s = mod.getState();
    assertEqual(s.timer.sessionType, type, msg + ' [type]');
    assertEqual(s.timer.status, status, msg + ' [status]');
  }

  mod.skip();
  let s = mod.getState();
  assertEqual(s.timer.slotsConsumed, 1, 'FR-04: slot=1 after skipping focus#1');
  assertEqual(Object.keys(s.logs).length, 0, 'FR-04 AC: skip does not change completed-count log');
  expectTypeStatus('shortBreak', 'running', 'focus#1 skip -> shortBreak auto-started');

  advance(mod.getState().settings.shortBreak * 60000 + 100);
  mod.tick();
  expectTypeStatus('focus', 'running', 'FR-03 AC: break end -> next focus starts w/o memo step');

  advance(mod.getState().settings.focus * 60000 + 100);
  mod.tick();
  s = mod.getState();
  assert(s.timer.memoPending === true, 'FR-03: natural focus completion -> Memo-Input-Pending');
  assertEqual(s.timer.status, 'idle', '6.2: underlying status is idle during Memo-Input-Pending');
  assertEqual(s.timer.slotsConsumed, 2, 'slot=2 after focus#2 completes');
  const todayKey = mod.todayDateKey();
  assertEqual(s.logs[todayKey].count, 1, 'FR-03: completion count += 1 on natural end');

  const beforeGuard = JSON.stringify(mod.getState().timer);
  mod.skip(); mod.pause(); mod.resetCurrentSession(); mod.startOrResume();
  s = mod.getState();
  assertEqual(JSON.stringify(s.timer), beforeGuard, 'BR-04: control functions are no-ops during Memo-Input-Pending');

  mod.submitMemo('작업 내용 테스트');
  s = mod.getState();
  assert(s.timer.memoPending === false, 'memoPending cleared after submit');
  expectTypeStatus('shortBreak', 'running', 'after memo submit -> next session auto-started');
  assertEqual(s.logs[todayKey].memos[0].text, '작업 내용 테스트', 'FR-05: memo text stored correctly');

  mod.skip();
  expectTypeStatus('focus', 'running', 'shortBreak#2 skip -> focus');
  mod.skip();
  s = mod.getState();
  assertEqual(s.timer.slotsConsumed, 3, 'slot=3 after focus#3 skip');
  expectTypeStatus('shortBreak', 'running', 'focus#3 skip -> shortBreak');
  mod.skip();
  expectTypeStatus('focus', 'running', 'shortBreak#3 skip -> focus (4th slot upcoming)');

  advance(mod.getState().settings.focus * 60000 + 100);
  mod.tick();
  s = mod.getState();
  assertEqual(s.timer.slotsConsumed, 4, 'slot=4 after focus#4 completes');
  mod.submitMemo('');
  s = mod.getState();
  expectTypeStatus('longBreak', 'running', 'FR-03/BR-01 AC: 4th focus slot -> Long Break');
  assertEqual(s.logs[todayKey].count, 2, 'FR-04 AC: count=2 (2 natural completions; 2 skips excluded)');
  assertEqual(s.logs[todayKey].memos[1].text, '', 'FR-05 AC: empty memo still counts, stored as empty text');

  mod.skip();
  s = mod.getState();
  expectTypeStatus('focus', 'running', 'BR-01: longBreak end -> focus, cycle restarts');
  assertEqual(s.timer.slotsConsumed, 0, 'BR-01: slotsConsumed resets to 0 after Long Break ends (even via skip)');
}

async function testFR04ExactACOrder() {
  console.log('* FR-04 AC literal order (2 skips then 2 completions)');
  resetStorage();
  const mod = freshMod();
  mod.boot();

  mod.skip(); // focus1 skip -> shortBreak
  mod.skip(); // shortBreak skip -> focus2
  mod.skip(); // focus2 skip -> shortBreak
  mod.skip(); // shortBreak skip -> focus3
  let s = mod.getState();
  assertEqual(s.timer.slotsConsumed, 2, 'exact-AC: 2 focus skips -> slot=2');

  advance(s.settings.focus * 60000 + 50);
  mod.tick();
  mod.submitMemo('');
  s = mod.getState();
  assertEqual(s.timer.slotsConsumed, 3, 'slot=3 after focus3 natural completion');

  mod.skip(); // shortBreak skip -> focus4
  advance(mod.getState().settings.focus * 60000 + 50);
  mod.tick();
  mod.submitMemo('');
  s = mod.getState();
  assertEqual(s.timer.slotsConsumed, 4, 'exact-AC: 4 slots via 2 skip + 2 complete');
  assertEqual(s.timer.sessionType, 'longBreak', 'exact-AC: -> Long Break');
  const key = mod.todayDateKey();
  assertEqual(s.logs[key].count, 2, 'exact-AC: completion count = 2');
}

async function testSettingsValidationAndTiming() {
  console.log('* FR-07 settings validation + application timing');
  resetStorage();
  const mod = freshMod();
  mod.boot();

  let r = mod.handleSettingsSave({ focus: '0', shortBreak: '5', longBreak: '15' });
  assert(r.ok === false && !!r.errors.focus, 'reject focus=0');
  r = mod.handleSettingsSave({ focus: '181', shortBreak: '5', longBreak: '15' });
  assert(r.ok === false && !!r.errors.focus, 'reject focus=181');
  r = mod.handleSettingsSave({ focus: '25.5', shortBreak: '5', longBreak: '15' });
  assert(r.ok === false && !!r.errors.focus, 'reject focus=25.5 (decimal)');
  r = mod.handleSettingsSave({ focus: 'abc', shortBreak: '5', longBreak: '15' });
  assert(r.ok === false && !!r.errors.focus, 'reject focus=abc (non-numeric)');
  r = mod.handleSettingsSave({ focus: '', shortBreak: '5', longBreak: '15' });
  assert(r.ok === false && !!r.errors.focus, 'reject focus=empty string');

  r = mod.handleSettingsSave({ focus: '1', shortBreak: '1', longBreak: '180' });
  assert(r.ok === true, 'accept boundary values 1 and 180');
  let s = mod.getState();
  assertEqual(s.settings, { focus: 1, shortBreak: 1, longBreak: 180 }, 'valid settings persisted');

  s = mod.getState();
  assertEqual(s.timer.status, 'idle', 'session still idle (never started)');
  assertEqual(s.settings.focus * 60000, 60000, 'AC: idle session reflects new value immediately (live-derived display)');

  mod.startOrResume();
  s = mod.getState();
  const originalEnd = s.timer.endTimestamp;
  mod.handleSettingsSave({ focus: '50', shortBreak: '1', longBreak: '180' });
  s = mod.getState();
  assertEqual(s.timer.endTimestamp, originalEnd, 'AC: running session endTimestamp unaffected by settings change');
  assertEqual(s.settings.focus, 50, 'setting value itself updates for future sessions');

  advance(60000 + 50);
  mod.tick();
  mod.submitMemo('');
  advance(60000 + 50);
  mod.tick();
  s = mod.getState();
  assertEqual(s.timer.endTimestamp - fakeNow, 50 * 60000, 'AC: next focus session applies updated setting only after current session ends');
}

async function testEC03RunningStillValid() {
  console.log('* EC-03/FR-08 running session still valid on reload');
  resetStorage();
  let mod = freshMod();
  mod.boot();
  mod.startOrResume();
  let s = mod.getState();
  const endTs = s.timer.endTimestamp;

  advance(5 * 60000);
  mod = freshMod();
  mod.boot();
  s = mod.getState();
  assertEqual(s.timer.status, 'running', 'still-valid running session restored as running');
  assertEqual(s.timer.endTimestamp, endTs, 'endTimestamp preserved exactly across reload');
}

async function testEC03RunningExpiredSingleAndMultiSession() {
  console.log('* EC-03/BR-02 running session expired offline (multi-session gap -> 1x only)');
  resetStorage();
  let mod = freshMod();
  mod.boot();
  mod.startOrResume();
  const startedKey = mod.todayDateKey();

  advance(5 * 60 * 60000); // 5시간 오프라인 (25분 세션 여러 개 분량)
  mod = freshMod();
  mod.boot();
  await flushMicrotasks();
  let s = mod.getState();
  assert(s.timer.memoPending === true, 'EC-03: expired focus restore -> memo step still included');
  assertEqual(s.timer.pendingMemo.autoStart, false, 'BR-02: pending memo carries autoStart=false');
  assertEqual(s.logs[startedKey].count, 1, 'EC-03: exactly 1 completion regardless of elapsed session count');

  mod.submitMemo('복귀 후 메모');
  s = mod.getState();
  assertEqual(s.timer.status, 'idle', 'BR-02: after memo, next session is Idle, NOT auto-started');
  assertEqual(s.timer.sessionType, 'shortBreak', 'next session type still correctly computed');
  assertEqual(s.timer.endTimestamp, null, 'idle session has no endTimestamp');
}

async function testEC03BreakExpiredWhileOffline() {
  console.log('* EC-03/BR-02 break session expired offline');
  resetStorage();
  let mod = freshMod();
  mod.boot();
  mod.skip();
  advance(3 * 60 * 60000);
  mod = freshMod();
  mod.boot();
  await flushMicrotasks();
  const s = mod.getState();
  assertEqual(s.timer.memoPending, false, 'break completion never involves memo');
  assertEqual(s.timer.status, 'idle', 'BR-02: break expired offline -> next Focus Idle, not auto-started');
  assertEqual(s.timer.sessionType, 'focus', 'next type is focus after shortBreak');
}

async function testEC03PausedRestoreIgnoresElapsedTime() {
  console.log('* EC-03/FR-08 paused session restore ignores elapsed time');
  resetStorage();
  let mod = freshMod();
  mod.boot();
  mod.startOrResume();
  advance(3 * 60000);
  mod.pause();
  let s = mod.getState();
  const snap = s.timer.remainingMs;

  advance(999 * 60 * 60000);
  mod = freshMod();
  mod.boot();
  s = mod.getState();
  assertEqual(s.timer.status, 'paused', 'paused session restores as paused regardless of elapsed time');
  assertEqual(s.timer.remainingMs, snap, 'FR-08: remaining snapshot identical, no expiry judgement applied to paused');
}

async function testEC04ClockJumpDetectedAndPauses() {
  console.log('* EC-04 system clock change detection');
  resetStorage();
  const mod = freshMod();
  mod.boot();
  mod.startOrResume();

  advance(60000);
  mod.tick();
  let s = mod.getState();
  assertEqual(s.timer.status, 'running', 'normal matched date/perf elapsed does not trigger');

  jumpClockOnly(10000); // 시계만 10초 점프 (perf는 그대로)
  mod.tick();
  s = mod.getState();
  assertEqual(s.timer.status, 'paused', 'EC-04: >=5s date/perf delta mismatch pauses session');
  assertEqual(s.clockChangeAlert, true, 'clockChangeAlert flag set');
  assert(s.timer.remainingMs > 0, 'remaining frozen at a positive value');

  const frozen = s.timer.remainingMs;
  advance(500);
  mod.resumeFromClockChange();
  s = mod.getState();
  assertEqual(s.clockChangeAlert, false, 'alert cleared on resume');
  assertEqual(s.timer.status, 'running', 'resumes to running');
  assertEqual(s.timer.endTimestamp - fakeNow, frozen, 'new endTimestamp = now + frozen remaining, no arbitrary change');
}

async function testEC04SmallDeltaDoesNotTrigger() {
  console.log('* EC-04 sub-threshold delta does not trigger');
  resetStorage();
  const mod = freshMod();
  mod.boot();
  mod.startOrResume();
  jumpClockOnly(4900);
  mod.tick();
  const s = mod.getState();
  assertEqual(s.timer.status, 'running', 'delta just under 5000ms threshold does not pause');
}

async function testEC04AnchorResetAvoidsFalsePositive() {
  console.log('* EC-04 anchor reset (visibility-return equivalent) avoids false positive on long consistent gap');
  resetStorage();
  const mod = freshMod();
  mod.boot();
  mod.startOrResume();
  mod.resetAnchors();
  advance(2 * 60 * 60000); // date/perf 동일하게 2시간 경과 (수면 후 복귀 시뮬레이션)
  mod.tick();
  const s = mod.getState();
  assert(s.clockChangeAlert === false, 'consistent large date/perf gap after anchor reset is not flagged as tampering');
  assert(s.timer.memoPending === true, 'instead recognized as normal session completion');
}

async function testEC05StorageWriteFailureAndRecovery() {
  console.log('* EC-05 localStorage write failure + auto-retry on next state change');
  resetStorage();
  const mod = freshMod();
  mod.boot();
  global.localStorage._setFailing(true);

  mod.startOrResume();
  let s = mod.getState();
  assertEqual(s.storageStatus, 'write-failed', 'failed write sets storageStatus write-failed');
  assertEqual(s.timer.status, 'running', 'in-memory state still updates despite storage failure');

  global.localStorage._setFailing(false);
  advance(1000);
  mod.pause();
  s = mod.getState();
  assertEqual(s.storageStatus, 'synced', 'next successful save clears write-failed status');
}

async function testEC01NotificationFallback() {
  console.log('* EC-01/FR-02 notification permission branches');
  resetStorage();
  let mod = freshMod();
  mod.boot();
  global.Notification.permission = 'denied';
  mod.notifySessionEnd('focus');
  await flushMicrotasks();
  let s = mod.getState();
  assertEqual(s.tabTitleFlashed, true, 'permission denied -> tab title fallback');

  resetStorage();
  const realNotification = global.Notification;
  delete global.Notification;
  mod = freshMod();
  mod.boot();
  mod.notifySessionEnd('focus');
  await flushMicrotasks();
  s = mod.getState();
  assertEqual(s.tabTitleFlashed, true, 'Notification API unsupported -> tab title fallback');
  global.Notification = realNotification;

  resetStorage();
  global.Notification.permission = 'granted';
  mod = freshMod();
  mod.boot();
  const before = notifCalls.length;
  mod.notifySessionEnd('focus');
  await flushMicrotasks();
  assert(notifCalls.length === before + 1, 'permission granted -> Notification constructor invoked (simultaneous w/ sound)');
}

async function testLogDateAttributionAcrossMidnight() {
  console.log('* FR-08 log date attribution uses endTimestamp, not submit time');
  resetStorage();
  const mod = freshMod();
  mod.boot();
  fakeNow = new Date(2026, 0, 15, 23, 59, 0).getTime();
  mod.startOrResume();
  advance(25 * 60000 + 50); // crosses midnight
  mod.tick();
  let s = mod.getState();
  const expectedKey = mod.toDateKey(s.timer.pendingMemo.timestamp);
  assertEqual(expectedKey, '2026-01-16', 'session ended after midnight attributes to new date');

  advance(10 * 60000); // 사용자가 메모를 늦게 제출
  mod.submitMemo('midnight test');
  s = mod.getState();
  assertEqual(s.logs['2026-01-16'].count, 1, 'log recorded under endTimestamp date, not submit-time date');
  assert(!s.logs['2026-01-15'], 'no log leaked into previous date');
}

async function testNFR01NoDriftOverLongDuration() {
  console.log('* NFR-01 no drift over long duration (180-min session)');
  resetStorage();
  const mod = freshMod();
  mod.boot();
  mod.handleSettingsSave({ focus: '180', shortBreak: '5', longBreak: '15' });
  mod.startOrResume();

  for (let i = 0; i < 3 * 60 * 60; i += 5) {
    advance(5000);
    if (mod.getState().timer.status !== 'running') break;
    mod.tick();
  }
  const s = mod.getState();
  assert(s.timer.memoPending === true, 'NFR-01: 180-min session completes exactly on time, no drift');
}

async function testCorruptedStorageResilience() {
  console.log('* defensive normalization of corrupted storage data');
  resetStorage();
  let mod = freshMod();
  global.localStorage.setItem(mod.STORAGE_KEYS.timer, JSON.stringify({ sessionType: 'focus', status: 'running', endTimestamp: null, slotsConsumed: 2 }));
  global.localStorage.setItem(mod.STORAGE_KEYS.settings, JSON.stringify({ focus: 999, shortBreak: -1, longBreak: 'x' }));
  global.localStorage.setItem(mod.STORAGE_KEYS.logs, JSON.stringify('not-an-object'));

  mod = freshMod();
  mod.boot();
  const s = mod.getState();
  assertEqual(s.timer.status, 'idle', 'corrupted running-without-endTimestamp falls back to idle safely');
  assertEqual(s.timer.slotsConsumed, 2, 'valid sub-fields preserved during normalization');
  assertEqual(s.settings, mod.DEFAULT_SETTINGS, 'corrupted settings values fall back to defaults per-field');
  assertEqual(s.logs, {}, 'corrupted logs (non-object) falls back to empty object');
}

/* ================= MAIN ================= */
async function main() {
  await testPureHelpers();
  await testStartPauseReset();
  await testFullCycleAndSlots();
  await testFR04ExactACOrder();
  await testSettingsValidationAndTiming();
  await testEC03RunningStillValid();
  await testEC03RunningExpiredSingleAndMultiSession();
  await testEC03BreakExpiredWhileOffline();
  await testEC03PausedRestoreIgnoresElapsedTime();
  await testEC04ClockJumpDetectedAndPauses();
  await testEC04SmallDeltaDoesNotTrigger();
  await testEC04AnchorResetAvoidsFalsePositive();
  await testEC05StorageWriteFailureAndRecovery();
  await testEC01NotificationFallback();
  await testLogDateAttributionAcrossMidnight();
  await testNFR01NoDriftOverLongDuration();
  await testCorruptedStorageResilience();

  console.log('');
  console.log('================================');
  console.log('PASS: ' + pass + '   FAIL: ' + fail);
  if (fail > 0) {
    console.log('Failures:');
    failures.forEach(function (f) { console.log(' - ' + f); });
  }
  console.log('================================');

  Date.now = realDateNow;
  performance.now = realPerfNow;
  try { fs.unlinkSync(TMP_JS); } catch (e) { /* best-effort cleanup */ }
  process.exit(fail > 0 ? 1 : 0);
}

main();
