/*
 * core.js — 뽀모도로 타이머 겸 작업 기록 웹앱의 순수 로직 계층
 *
 * PRD v4 기준. DOM / localStorage / Audio / Notification 등 브라우저 부수효과는
 * 이 파일에 두지 않는다. 시간 관련 값(now = Date.now(), perfNow = performance.now())은
 * 전역을 직접 호출하지 않고 항상 인자로 주입받아 테스트 가능하도록 한다.
 *
 * 12.2 승인된 기술 결정:
 *  - 타이머 계산은 endTimestamp(절대 종료 시각) 기준 (setInterval 카운트다운 아님)
 *  - 시계 변경 감지는 dateAnchor/perfAnchor 델타 비교, 임계값 5초 (대체 불가 — 12.3)
 *  - Focus 슬롯은 완료/스킵과 무관하게 소모(슬롯 소모형), 4슬롯 소모 시 Long Break
 *  - 리셋은 현재 세션 타이머만 초기화, 슬롯 카운트 유지 (BR-03)
 *  - 재접속 복원 시 다음 세션 자동 시작 안 함, Idle 대기 (BR-02)
 *  - 오프라인 중 다중 세션 만료 → 1회만 종료 처리
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PomodoroCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SESSION = { FOCUS: 'Focus', SHORT_BREAK: 'ShortBreak', LONG_BREAK: 'LongBreak' };
  var STATUS = { IDLE: 'Idle', RUNNING: 'Running', PAUSED: 'Paused' };

  var DEFAULT_SETTINGS = { focusMin: 25, shortBreakMin: 5, longBreakMin: 15 };
  var SETTINGS_MIN = 1;
  var SETTINGS_MAX = 180;

  // BR-01: 사이클당 Focus 슬롯 4개. 4번째 슬롯 소모 시 Long Break.
  var FOCUS_SLOTS_PER_CYCLE = 4;

  // EC-04 / NFR-01: 시스템 시계 변경 판정 임계값 (밀리초).
  var CLOCK_CHANGE_THRESHOLD_MS = 5000;

  var MS_PER_MIN = 60 * 1000;
  // 6.3 TimerState: Paused 남은 시간 스냅샷은 정의상 항상 1초 이상의 양수.
  var MIN_PAUSED_REMAINING_MS = 1000;

  function isBreak(type) {
    return type === SESSION.SHORT_BREAK || type === SESSION.LONG_BREAK;
  }

  function assertKnownSession(type) {
    if (type !== SESSION.FOCUS && type !== SESSION.SHORT_BREAK && type !== SESSION.LONG_BREAK) {
      throw new Error('Unknown session type: ' + String(type));
    }
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  function cloneSettings(s) {
    return { focusMin: s.focusMin, shortBreakMin: s.shortBreakMin, longBreakMin: s.longBreakMin };
  }

  function defaultSettings() {
    return cloneSettings(DEFAULT_SETTINGS);
  }

  // FR-07: 1~180분 정수만 허용. 범위 초과 / 소수 / 비숫자는 거부.
  function validateSettingsField(raw) {
    if (typeof raw === 'number') {
      if (!isFinite(raw)) return { valid: false };
      if (Math.floor(raw) !== raw) return { valid: false };
      if (raw < SETTINGS_MIN || raw > SETTINGS_MAX) return { valid: false };
      return { valid: true, value: raw };
    }
    if (typeof raw === 'string') {
      var trimmed = raw.trim();
      if (trimmed === '') return { valid: false };
      // 정수 문자열만 허용 (소수점, 지수, 부호 표기, 공백 포함 문자열 거부).
      if (!/^\d+$/.test(trimmed)) return { valid: false };
      var n = Number(trimmed);
      if (n < SETTINGS_MIN || n > SETTINGS_MAX) return { valid: false };
      return { valid: true, value: n };
    }
    return { valid: false };
  }

  // FR-07: 세 필드 전부 유효해야 저장 가능. 하나라도 실패하면 저장 차단 + 오류.
  function validateSettings(input) {
    input = input || {};
    var fields = ['focusMin', 'shortBreakMin', 'longBreakMin'];
    var errors = {};
    var value = {};
    var valid = true;
    for (var i = 0; i < fields.length; i++) {
      var key = fields[i];
      var res = validateSettingsField(input[key]);
      if (res.valid) {
        value[key] = res.value;
      } else {
        valid = false;
        errors[key] = true;
      }
    }
    return valid ? { valid: true, value: value } : { valid: false, errors: errors };
  }

  function sessionLengthMs(type, settings) {
    assertKnownSession(type);
    if (type === SESSION.FOCUS) return settings.focusMin * MS_PER_MIN;
    if (type === SESSION.SHORT_BREAK) return settings.shortBreakMin * MS_PER_MIN;
    return settings.longBreakMin * MS_PER_MIN;
  }

  // ── Anchors (EC-04) ─────────────────────────────────────────────────────────

  function sampleAnchor(now, perfNow) {
    return { dateAnchor: now, perfAnchor: perfNow };
  }

  // EC-04: |dateDelta - perfDelta| >= 5초 이면 시스템 시계 변경으로 판정.
  // 원시 값이 아니라 앵커 대비 델타끼리 비교한다.
  function detectClockChange(anchor, now, perfNow) {
    if (!anchor || typeof anchor.dateAnchor !== 'number' || typeof anchor.perfAnchor !== 'number') {
      return false;
    }
    var dateDelta = now - anchor.dateAnchor;
    var perfDelta = perfNow - anchor.perfAnchor;
    return Math.abs(dateDelta - perfDelta) >= CLOCK_CHANGE_THRESHOLD_MS;
  }

  // ── TimerState 생성/전이 ────────────────────────────────────────────────────

  function createInitialTimer(settings, now, perfNow) {
    return {
      sessionType: SESSION.FOCUS,
      status: STATUS.IDLE,
      endTimestamp: null,
      remainingMsSnapshot: sessionLengthMs(SESSION.FOCUS, settings),
      focusSlotsConsumed: 0,
      dateAnchor: now,
      perfAnchor: perfNow,
      // Memo-Input-Pending (6.2): 기저 status 는 Idle. UI 오버레이 플래그로만 표현.
      memoPending: false,
      pendingCompletion: null,
      // 이 memoPending 이 재접속 복원(EC-03)에서 비롯됐는지 여부.
      // true 면 메모 해소 후 다음 세션을 자동 시작하지 않고 Idle 로 대기한다(BR-02).
      restoredPending: false
    };
  }

  function copyTimer(t) {
    return {
      sessionType: t.sessionType,
      status: t.status,
      endTimestamp: t.endTimestamp,
      remainingMsSnapshot: t.remainingMsSnapshot,
      focusSlotsConsumed: t.focusSlotsConsumed,
      dateAnchor: t.dateAnchor,
      perfAnchor: t.perfAnchor,
      memoPending: !!t.memoPending,
      pendingCompletion: t.pendingCompletion || null,
      restoredPending: !!t.restoredPending
    };
  }

  // 현재 세션에서 "표시해야 하는" 남은 시간(ms).
  //  - Idle: 설정된 세션 길이 (FR-07: Idle 세션은 설정 변경이 즉시 반영됨)
  //  - Running: endTimestamp - now (0 밑으로 내려가지 않음)
  //  - Paused: 저장된 스냅샷 (오프라인 시간과 무관)
  function remainingMs(timer, now, settings) {
    if (timer.status === STATUS.RUNNING) {
      return Math.max(0, timer.endTimestamp - now);
    }
    if (timer.status === STATUS.PAUSED) {
      return timer.remainingMsSnapshot;
    }
    // Idle
    return sessionLengthMs(timer.sessionType, settings);
  }

  function isExpired(timer, now) {
    return timer.status === STATUS.RUNNING && now >= timer.endTimestamp;
  }

  // FR-01 시작: endTimestamp = now + 남은시간. Idle 이면 설정 길이, Paused 면 스냅샷 이어받기.
  function startTimer(timer, settings, now, perfNow) {
    if (timer.memoPending) {
      throw new Error('Cannot start timer while memo input is pending (BR-04)');
    }
    if (timer.status === STATUS.RUNNING) {
      return copyTimer(timer);
    }
    var base = timer.status === STATUS.PAUSED
      ? timer.remainingMsSnapshot
      : sessionLengthMs(timer.sessionType, settings);
    var next = copyTimer(timer);
    next.status = STATUS.RUNNING;
    next.endTimestamp = now + base;
    next.remainingMsSnapshot = base;
    next.dateAnchor = now;
    next.perfAnchor = perfNow;
    return next;
  }

  // FR-01 일시정지: 남은 시간을 고정 저장, endTimestamp 제거.
  function pauseTimer(timer, now) {
    if (timer.status !== STATUS.RUNNING) {
      return copyTimer(timer);
    }
    var remaining = Math.max(MIN_PAUSED_REMAINING_MS, timer.endTimestamp - now);
    var next = copyTimer(timer);
    next.status = STATUS.PAUSED;
    next.remainingMsSnapshot = remaining;
    next.endTimestamp = null;
    return next;
  }

  // EC-04 재개: 현재 시각 기준 새 endTimestamp 계산 + 앵커 재설정 후 Running.
  function resumeTimer(timer, now, perfNow) {
    if (timer.status !== STATUS.PAUSED) {
      return copyTimer(timer);
    }
    var next = copyTimer(timer);
    next.status = STATUS.RUNNING;
    next.endTimestamp = now + timer.remainingMsSnapshot;
    next.dateAnchor = now;
    next.perfAnchor = perfNow;
    return next;
  }

  // FR-01 / BR-03 리셋: 현재 세션 타이머만 설정 길이의 Idle 로. 슬롯 수는 불변.
  function resetTimer(timer, settings) {
    if (timer.memoPending) {
      throw new Error('Cannot reset timer while memo input is pending (BR-04)');
    }
    var next = copyTimer(timer);
    next.status = STATUS.IDLE;
    next.endTimestamp = null;
    next.remainingMsSnapshot = sessionLengthMs(timer.sessionType, settings);
    // focusSlotsConsumed 유지 (BR-03)
    return next;
  }

  // EC-04: 시계 변경 감지 시 즉시 Paused. 남은 시간은 마지막 유효 계산값으로 고정.
  function forcePauseForClockChange(timer, lastValidRemainingMs) {
    if (timer.status !== STATUS.RUNNING) {
      return copyTimer(timer);
    }
    var remaining = Math.max(MIN_PAUSED_REMAINING_MS, Math.round(lastValidRemainingMs));
    var next = copyTimer(timer);
    next.status = STATUS.PAUSED;
    next.remainingMsSnapshot = remaining;
    next.endTimestamp = null;
    return next;
  }

  // ── 사이클 전이 (BR-01) ─────────────────────────────────────────────────────

  // 방금 끝난(또는 스킵된) 세션 타입과 그 시점의 소모 슬롯 수를 받아
  // 다음 세션 타입 + 다음 소모 슬롯 수를 계산한다.
  //  - Focus 종료/스킵: 슬롯 1 소모. 소모 후 4 이면 Long Break, 아니면 Short Break.
  //  - Short/Long Break 종료/스킵: 다음은 Focus.
  //  - Long Break 이후(스킵 포함): 사이클 초기화 → 슬롯 0 으로.
  function advanceCycle(endedType, focusSlotsConsumed) {
    assertKnownSession(endedType);
    if (endedType === SESSION.FOCUS) {
      var consumed = Math.min(FOCUS_SLOTS_PER_CYCLE, focusSlotsConsumed + 1);
      if (consumed >= FOCUS_SLOTS_PER_CYCLE) {
        return { sessionType: SESSION.LONG_BREAK, focusSlotsConsumed: consumed };
      }
      return { sessionType: SESSION.SHORT_BREAK, focusSlotsConsumed: consumed };
    }
    if (endedType === SESSION.LONG_BREAK) {
      return { sessionType: SESSION.FOCUS, focusSlotsConsumed: 0 };
    }
    // Short Break
    return { sessionType: SESSION.FOCUS, focusSlotsConsumed: focusSlotsConsumed };
  }

  function makeIdleTimer(prevTimer, sessionType, focusSlotsConsumed, settings, now, perfNow) {
    return {
      sessionType: sessionType,
      status: STATUS.IDLE,
      endTimestamp: null,
      remainingMsSnapshot: sessionLengthMs(sessionType, settings),
      focusSlotsConsumed: focusSlotsConsumed,
      dateAnchor: now,
      perfAnchor: perfNow,
      memoPending: false,
      pendingCompletion: null,
      restoredPending: false
    };
  }

  function makeRunningTimer(sessionType, focusSlotsConsumed, settings, now, perfNow) {
    var len = sessionLengthMs(sessionType, settings);
    return {
      sessionType: sessionType,
      status: STATUS.RUNNING,
      endTimestamp: now + len,
      remainingMsSnapshot: len,
      focusSlotsConsumed: focusSlotsConsumed,
      dateAnchor: now,
      perfAnchor: perfNow,
      memoPending: false,
      pendingCompletion: null,
      restoredPending: false
    };
  }

  // 로컬 타임존 기준 날짜 키 (YYYY-MM-DD). FR-06 / FR-08: 모든 시각은 기기 로컬 타임존.
  function dateKey(timestamp) {
    var d = new Date(timestamp);
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  // ── 세션 종료 처리 (실시간 포그라운드) ─────────────────────────────────────

  // FR-02/FR-03/FR-05: 진행 중 세션이 정상 종료(시간 만료)됐을 때.
  //  - Focus: 완료 카운트 +1 → Memo-Input-Pending (다음 세션 미시작, BR-04)
  //  - Break: 메모 없이 곧바로 다음 Focus 자동 시작 (BR-02: 포그라운드 한정)
  // 반환:
  //  {
  //    timer,                // 다음 상태
  //    notify: true,         // 항상 (FR-02) — 알림/소리 트리거
  //    memoPending: bool,    // Focus 만료 시 true
  //    completion: null | { dateKey, completedAt }  // Focus 만료 시 (완료 카운트 귀속)
  //    autoStarted: bool     // Break 만료 시 true
  //  }
  function completeExpiredSession(timer, settings, now, perfNow) {
    if (timer.status !== STATUS.RUNNING) {
      throw new Error('completeExpiredSession requires a Running timer');
    }
    var endTs = timer.endTimestamp;

    if (timer.sessionType === SESSION.FOCUS) {
      // Focus 슬롯 소모는 유일하게 advanceCycle 에서만 일어난다(여기서 미리 증가시키지 않는다).
      // 메모 제출/건너뛰기(resolveMemoAndAdvance) 시점에 BR-01 순서에 따라 1회 소모된다.
      var pendingTimer = {
        sessionType: SESSION.FOCUS,
        status: STATUS.IDLE,
        endTimestamp: null,
        remainingMsSnapshot: 0,
        focusSlotsConsumed: timer.focusSlotsConsumed,
        dateAnchor: now,
        perfAnchor: perfNow,
        memoPending: true,
        pendingCompletion: { dateKey: dateKey(endTs), completedAt: endTs },
        restoredPending: false
      };
      return {
        timer: pendingTimer,
        notify: true,
        memoPending: true,
        completion: { dateKey: dateKey(endTs), completedAt: endTs },
        autoStarted: false
      };
    }

    // Break 종료 → 다음 Focus 자동 시작
    var adv = advanceCycle(timer.sessionType, timer.focusSlotsConsumed);
    return {
      timer: makeRunningTimer(adv.sessionType, adv.focusSlotsConsumed, settings, now, perfNow),
      notify: true,
      memoPending: false,
      completion: null,
      autoStarted: true
    };
  }

  // FR-05: Memo-Input-Pending 에서 메모 제출/건너뛰기 → BR-01 순서로 다음 세션 결정.
  // memoText 는 저장 측(app/storage)에서 처리. 여기서는 사이클 전이만.
  //  - 실시간 완료에서 온 경우: 다음 세션 자동 시작 (FR-03).
  //  - 재접속 복원(EC-03)에서 온 경우: 다음 세션 Idle 대기, 수동 시작 필요 (BR-02).
  function resolveMemoAndAdvance(timer, settings, now, perfNow) {
    if (!timer.memoPending) {
      throw new Error('resolveMemoAndAdvance requires memoPending state');
    }
    var adv = advanceCycle(SESSION.FOCUS, timer.focusSlotsConsumed);
    if (timer.restoredPending) {
      return {
        timer: makeIdleTimer(timer, adv.sessionType, adv.focusSlotsConsumed, settings, now, perfNow),
        autoStarted: false
      };
    }
    return {
      timer: makeRunningTimer(adv.sessionType, adv.focusSlotsConsumed, settings, now, perfNow),
      autoStarted: true
    };
  }

  // FR-04 스킵: 현재 세션을 미완료로 즉시 종료 → 다음 세션 자동 시작.
  //  - Focus 스킵: 완료 카운트 증가 X, 메모 X, 그러나 슬롯은 소모됨.
  //  - Break 스킵: 다음 Focus.
  //  - Memo-Input-Pending 에서는 호출 불가 (BR-04).
  function skipSession(timer, settings, now, perfNow) {
    if (timer.memoPending) {
      throw new Error('Cannot skip while memo input is pending (BR-04)');
    }
    var adv = advanceCycle(timer.sessionType, timer.focusSlotsConsumed);
    return {
      timer: makeRunningTimer(adv.sessionType, adv.focusSlotsConsumed, settings, now, perfNow),
      autoStarted: true
    };
  }

  // ── 재접속 복원 (FR-08 / EC-03 / BR-02) ────────────────────────────────────

  // persistedTimer: localStorage 에서 읽은 TimerState (또는 null).
  // 반환:
  //  {
  //    timer,               // 복원된 상태
  //    expired: bool,       // Running 이었고 만료됨
  //    running: bool,       // Running 이었고 아직 유효
  //    completion: null | { dateKey, completedAt },  // 만료 세션이 Focus 였을 때
  //    memoPending: bool,   // 만료 세션이 Focus → 메모 입력 대기
  //    notify: bool,        // 만료 시 true
  //    autoStart: false     // BR-02: 복원 시 다음 세션 자동 시작 없음
  //  }
  function restoreTimer(persistedTimer, settings, now, perfNow) {
    if (!persistedTimer) {
      return {
        timer: createInitialTimer(settings, now, perfNow),
        expired: false,
        running: false,
        completion: null,
        memoPending: false,
        notify: false,
        autoStart: false
      };
    }

    var t = copyTimer(persistedTimer);
    assertKnownSession(t.sessionType);

    // Paused: endTimestamp 없음 → 만료 판단 안 함. 스냅샷 그대로 복원.
    if (t.status === STATUS.PAUSED) {
      t.endTimestamp = null;
      if (typeof t.remainingMsSnapshot !== 'number' || !isFinite(t.remainingMsSnapshot)) {
        t.remainingMsSnapshot = sessionLengthMs(t.sessionType, settings);
      }
      t.remainingMsSnapshot = Math.max(MIN_PAUSED_REMAINING_MS, t.remainingMsSnapshot);
      t.memoPending = false;
      t.pendingCompletion = null;
      return {
        timer: t, expired: false, running: false,
        completion: null, memoPending: false, notify: false, autoStart: false
      };
    }

    // 저장 시점에 Memo-Input-Pending 이었던 경우: 기저 status 는 Idle.
    // 완료 카운트는 이미 종료 시점에 귀속되었으므로 재복원 시 다시 세지 않는다.
    if (t.status === STATUS.IDLE && t.memoPending) {
      return {
        timer: t, expired: false, running: false,
        completion: null, memoPending: true, notify: false, autoStart: false
      };
    }

    // Idle: 그대로 복원.
    if (t.status === STATUS.IDLE) {
      t.remainingMsSnapshot = sessionLengthMs(t.sessionType, settings);
      t.endTimestamp = null;
      t.dateAnchor = now;
      t.perfAnchor = perfNow;
      return {
        timer: t, expired: false, running: false,
        completion: null, memoPending: false, notify: false, autoStart: false
      };
    }

    // Running: endTimestamp 와 now 비교.
    var endTs = t.endTimestamp;
    if (typeof endTs !== 'number' || !isFinite(endTs)) {
      // 손상된 상태 — 안전하게 Idle 로 정리.
      return {
        timer: makeIdleTimer(t, t.sessionType, t.focusSlotsConsumed, settings, now, perfNow),
        expired: false, running: false,
        completion: null, memoPending: false, notify: false, autoStart: false
      };
    }

    if (now < endTs) {
      // 아직 진행 중 → 남은 시간 이어서. 앵커만 재설정.
      t.dateAnchor = now;
      t.perfAnchor = perfNow;
      t.remainingMsSnapshot = Math.max(0, endTs - now);
      t.memoPending = false;
      t.pendingCompletion = null;
      return {
        timer: t, expired: false, running: true,
        completion: null, memoPending: false, notify: false, autoStart: false
      };
    }

    // 만료됨 → 경과 세션 수와 무관하게 '중단 시점 세션 1회만' 종료 처리.
    if (t.sessionType === SESSION.FOCUS) {
      // 슬롯 소모는 메모 해소(resolveMemoAndAdvance) 시 advanceCycle 에서 1회만.
      var pendingTimer = {
        sessionType: SESSION.FOCUS,
        status: STATUS.IDLE,
        endTimestamp: null,
        remainingMsSnapshot: 0,
        focusSlotsConsumed: t.focusSlotsConsumed,
        dateAnchor: now,
        perfAnchor: perfNow,
        memoPending: true,
        pendingCompletion: { dateKey: dateKey(endTs), completedAt: endTs },
        restoredPending: true
      };
      return {
        timer: pendingTimer,
        expired: true,
        running: false,
        completion: { dateKey: dateKey(endTs), completedAt: endTs },
        memoPending: true,
        notify: true,
        autoStart: false
      };
    }

    // 만료 세션이 Break → 메모 없이 다음 Focus 를 Idle 로 대기 (BR-02: 자동 시작 안 함).
    var adv = advanceCycle(t.sessionType, t.focusSlotsConsumed);
    return {
      timer: makeIdleTimer(t, adv.sessionType, adv.focusSlotsConsumed, settings, now, perfNow),
      expired: true,
      running: false,
      completion: null,
      memoPending: false,
      notify: true,
      autoStart: false
    };
  }

  // ── DailyLog (FR-05 / FR-06) ────────────────────────────────────────────────

  function emptyLogs() {
    return {};
  }

  function normalizeDayEntry(entry) {
    if (!entry) return { count: 0, memos: [] };
    return {
      count: typeof entry.count === 'number' ? entry.count : 0,
      memos: Array.isArray(entry.memos) ? entry.memos.slice() : []
    };
  }

  // Focus 완료(정상 종료) 시 호출: 완료 카운트 +1, 메모 항목 1개 추가(빈 텍스트 허용).
  // memos 는 completedAt 오름차순으로 유지 (FR-06).
  function addCompletion(logs, key, completedAt, memoText) {
    var next = {};
    for (var k in logs) {
      if (Object.prototype.hasOwnProperty.call(logs, k)) next[k] = logs[k];
    }
    var day = normalizeDayEntry(next[key]);
    var memos = day.memos.slice();
    memos.push({ completedAt: completedAt, text: typeof memoText === 'string' ? memoText : '' });
    memos.sort(function (a, b) { return a.completedAt - b.completedAt; });
    next[key] = { count: day.count + 1, memos: memos };
    return next;
  }

  // 특정 완료 항목(completedAt 매칭)의 메모 텍스트를 갱신한다.
  function setMemoText(logs, key, completedAt, memoText) {
    var next = {};
    for (var k in logs) {
      if (Object.prototype.hasOwnProperty.call(logs, k)) next[k] = logs[k];
    }
    var day = normalizeDayEntry(next[key]);
    var memos = day.memos.map(function (m) {
      if (m.completedAt === completedAt) {
        return { completedAt: m.completedAt, text: typeof memoText === 'string' ? memoText : '' };
      }
      return m;
    });
    next[key] = { count: day.count, memos: memos };
    return next;
  }

  // FR-06: 선택 날짜의 완료 개수 + 메모 목록(오름차순).
  function getDailyLog(logs, key) {
    var day = normalizeDayEntry(logs ? logs[key] : null);
    var memos = day.memos.slice().sort(function (a, b) { return a.completedAt - b.completedAt; });
    return { count: day.count, memos: memos };
  }

  // FR-05 Output: 빈 값 메모는 '메모 없음' 으로 표시.
  function displayMemoText(text) {
    if (typeof text !== 'string' || text.trim() === '') return '메모 없음';
    return text;
  }

  return {
    SESSION: SESSION,
    STATUS: STATUS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    SETTINGS_MIN: SETTINGS_MIN,
    SETTINGS_MAX: SETTINGS_MAX,
    FOCUS_SLOTS_PER_CYCLE: FOCUS_SLOTS_PER_CYCLE,
    CLOCK_CHANGE_THRESHOLD_MS: CLOCK_CHANGE_THRESHOLD_MS,
    MS_PER_MIN: MS_PER_MIN,
    MIN_PAUSED_REMAINING_MS: MIN_PAUSED_REMAINING_MS,

    isBreak: isBreak,
    defaultSettings: defaultSettings,
    cloneSettings: cloneSettings,
    validateSettingsField: validateSettingsField,
    validateSettings: validateSettings,
    sessionLengthMs: sessionLengthMs,

    sampleAnchor: sampleAnchor,
    detectClockChange: detectClockChange,

    createInitialTimer: createInitialTimer,
    copyTimer: copyTimer,
    remainingMs: remainingMs,
    isExpired: isExpired,
    startTimer: startTimer,
    pauseTimer: pauseTimer,
    resumeTimer: resumeTimer,
    resetTimer: resetTimer,
    forcePauseForClockChange: forcePauseForClockChange,

    advanceCycle: advanceCycle,
    makeIdleTimer: makeIdleTimer,
    makeRunningTimer: makeRunningTimer,
    completeExpiredSession: completeExpiredSession,
    resolveMemoAndAdvance: resolveMemoAndAdvance,
    skipSession: skipSession,
    restoreTimer: restoreTimer,

    dateKey: dateKey,
    emptyLogs: emptyLogs,
    addCompletion: addCompletion,
    setMemoText: setMemoText,
    getDailyLog: getDailyLog,
    displayMemoText: displayMemoText
  };
});
