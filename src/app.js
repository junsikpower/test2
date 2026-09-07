/*
 * app.js — DOM / Audio / Notification 배선 계층
 *
 * 순수 로직은 core.js, 지속성은 storage.js 가 담당한다. 이 파일은 그것들을
 * 실제 브라우저 환경(DOM, Web Audio, Notification, Page Visibility)에 연결한다.
 *
 * 12.2 승인된 기술 결정 반영:
 *  - endTimestamp 기반 절대시각 계산 (setInterval 카운트다운 아님)
 *  - visibilitychange 로 탭 복귀 시 즉시 상태 재계산 (EC-02)
 *  - Web Audio API 합성음, 외부 음원 파일 없음 (FR-02)
 *  - Notification 권한 허용 시 소리와 항상 동시 발송, 거부/미지원 시 소리+탭 제목 (EC-01)
 *  - 최초 사용자 상호작용에서 오디오 컨텍스트 활성화 (FR-02)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'), require('./storage.js'));
  } else {
    root.PomodoroApp = factory(root.PomodoroCore, root.PomodoroStorage);
  }
})(typeof self !== 'undefined' ? self : this, function (Core, Storage) {
  'use strict';

  function nowFn() { return Date.now(); }
  function perfNowFn() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function formatClock(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' + m : '' + m) + ':' + (s < 10 ? '0' + s : '' + s);
  }

  function sessionLabel(type) {
    if (type === Core.SESSION.FOCUS) return '집중';
    if (type === Core.SESSION.SHORT_BREAK) return '짧은 휴식';
    return '긴 휴식';
  }

  // ── 알림음 (Web Audio API 합성) ────────────────────────────────────────────
  function createBeeper(win) {
    var AudioCtx = win.AudioContext || win.webkitAudioContext;
    var ctx = null;

    function ensureContext() {
      if (!AudioCtx) return null;
      if (!ctx) {
        try { ctx = new AudioCtx(); } catch (e) { ctx = null; }
      }
      if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        try { ctx.resume(); } catch (e) { /* noop */ }
      }
      return ctx;
    }

    // 최초 사용자 상호작용 시점에 호출 → 자동재생 제한 회피 (FR-02).
    function unlock() { ensureContext(); }

    // 세션 종료음. 재생 실패는 play 계열 Promise 거부 또는 예외로 감지 가능.
    // 성공 여부를 Promise<boolean> 로 반환한다.
    function play() {
      return new Promise(function (resolve) {
        var c = ensureContext();
        if (!c) { resolve(false); return; }
        try {
          var osc = c.createOscillator();
          var gain = c.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(880, c.currentTime);
          osc.frequency.setValueAtTime(660, c.currentTime + 0.18);
          gain.gain.setValueAtTime(0.0001, c.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.25, c.currentTime + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.5);
          osc.connect(gain);
          gain.connect(c.destination);
          osc.start();
          osc.stop(c.currentTime + 0.52);
          osc.onended = function () { resolve(true); };
          // onended 가 오지 않는 환경 대비 안전장치.
          setTimeout(function () { resolve(true); }, 700);
        } catch (e) {
          resolve(false);
        }
      });
    }

    return { unlock: unlock, play: play };
  }

  // ── Notification ──────────────────────────────────────────────────────────
  function notificationSupported(win) {
    return typeof win.Notification !== 'undefined';
  }

  function notificationGranted(win) {
    return notificationSupported(win) && win.Notification.permission === 'granted';
  }

  function requestNotificationPermission(win) {
    if (!notificationSupported(win)) return Promise.resolve('unsupported');
    try {
      var r = win.Notification.requestPermission();
      if (r && typeof r.then === 'function') return r;
      return Promise.resolve(r);
    } catch (e) {
      return Promise.resolve('denied');
    }
  }

  // ── 앱 컨트롤러 ───────────────────────────────────────────────────────────
  function createApp(opts) {
    opts = opts || {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var win = opts.window || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win) throw new Error('createApp requires document and window');

    var now = opts.now || nowFn;
    var perfNow = opts.perfNow || perfNowFn;
    var store = opts.storage || Storage.createStore({ backend: opts.backend });
    var beeper = opts.beeper || createBeeper(win);

    var TICK_MS = opts.tickMs || 250;

    var settings = Core.defaultSettings();
    var logs = Core.emptyLogs();
    var timer = Core.createInitialTimer(settings, now(), perfNow());
    var logViewDate = Core.dateKey(now());
    var view = 'timer'; // 'timer' | 'settings' | 'log'
    var tickHandle = null;
    var originalTitle = doc.title || '뽀모도로 타이머';
    var titleFallbackActive = false;

    var els = {};
    function $(id) { return doc.getElementById(id); }

    function persistAll() {
      store.write('settings', settings);
      store.write('logs', logs);
      store.write('timer', timer);
    }
    function persistTimer() { store.write('timer', timer); }
    function persistLogs() { store.write('logs', logs); }

    // ── 알림 (FR-02 / EC-01) ────────────────────────────────────────────────
    function fireNotification(message) {
      var soundPromise = beeper.play();
      var usedDesktop = false;
      if (notificationGranted(win)) {
        try {
          new win.Notification('뽀모도로', { body: message });
          usedDesktop = true;
        } catch (e) { usedDesktop = false; }
      }
      soundPromise.then(function (ok) {
        if (!ok && !usedDesktop) {
          activateTitleFallback(message);
        } else if (!ok) {
          // 소리 실패는 감지되었으나 데스크톱 알림은 호출됨 → 그래도 탭 제목으로 보강.
          activateTitleFallback(message);
        }
      });
      if (!usedDesktop && !notificationGranted(win)) {
        // 권한 거부/미지원: 소리 + 탭 제목 (EC-01)
        activateTitleFallback(message);
      }
    }

    function activateTitleFallback(message) {
      titleFallbackActive = true;
      doc.title = '● ' + (message || '세션 종료') + ' — ' + originalTitle;
    }
    function clearTitleFallback() {
      if (titleFallbackActive) {
        doc.title = originalTitle;
        titleFallbackActive = false;
      }
    }

    // ── 렌더 ────────────────────────────────────────────────────────────────
    function render() {
      if (!els.root) return;
      renderBanner();
      renderNav();

      els.timerView.hidden = view !== 'timer';
      els.settingsView.hidden = view !== 'settings';
      els.logView.hidden = view !== 'log';

      if (view === 'timer') renderTimer();
      if (view === 'settings') renderSettings();
      if (view === 'log') renderLog();
    }

    function renderBanner() {
      var failed = store.getState() === store.STORE_STATE.WRITE_FAILED;
      els.banner.hidden = !failed;
      els.banner.textContent = failed
        ? '데이터가 저장되지 않고 있습니다 — 새로고침 시 최근 변경사항이 유실될 수 있습니다'
        : '';
    }

    function renderNav() {
      els.navTimer.setAttribute('aria-current', view === 'timer' ? 'page' : 'false');
      els.navSettings.setAttribute('aria-current', view === 'settings' ? 'page' : 'false');
      els.navLog.setAttribute('aria-current', view === 'log' ? 'page' : 'false');
    }

    function renderTimer() {
      var t = now();
      els.sessionType.textContent = sessionLabel(timer.sessionType);
      els.slotInfo.textContent = '사이클 ' + timer.focusSlotsConsumed + ' / ' + Core.FOCUS_SLOTS_PER_CYCLE;
      els.clock.textContent = formatClock(Core.remainingMs(timer, t, settings));

      var showControls = !timer.memoPending;
      els.controls.hidden = !showControls;
      els.memoBox.hidden = !timer.memoPending;

      if (showControls) {
        var running = timer.status === Core.STATUS.RUNNING;
        els.startPauseBtn.textContent = running ? '일시정지' : '시작';
        els.resetBtn.disabled = false;
        els.skipBtn.disabled = false;
      }
    }

    function renderSettings() {
      els.focusInput.value = settings.focusMin;
      els.shortInput.value = settings.shortBreakMin;
      els.longInput.value = settings.longBreakMin;
    }

    function renderLog() {
      var day = Core.getDailyLog(logs, logViewDate);
      els.logDate.value = logViewDate;
      els.logCount.textContent = String(day.count);
      els.logList.innerHTML = '';
      for (var i = 0; i < day.memos.length; i++) {
        var li = doc.createElement('li');
        var time = new Date(day.memos[i].completedAt);
        var hh = time.getHours(); var mm = time.getMinutes();
        var stamp = (hh < 10 ? '0' + hh : hh) + ':' + (mm < 10 ? '0' + mm : mm);
        li.textContent = stamp + '  ' + Core.displayMemoText(day.memos[i].text);
        els.logList.appendChild(li);
      }
    }

    // ── 타이머 동작 ─────────────────────────────────────────────────────────
    function onStartPause() {
      beeper.unlock();
      clearTitleFallback();
      if (timer.memoPending) return;
      if (timer.status === Core.STATUS.RUNNING) {
        timer = Core.pauseTimer(timer, now());
      } else if (timer.status === Core.STATUS.PAUSED) {
        timer = Core.resumeTimer(timer, now(), perfNow());
      } else {
        timer = Core.startTimer(timer, settings, now(), perfNow());
      }
      persistTimer();
      render();
    }

    function onReset() {
      if (timer.memoPending) return;
      timer = Core.resetTimer(timer, settings);
      persistTimer();
      render();
    }

    function onSkip() {
      beeper.unlock();
      if (timer.memoPending) return;
      var res = Core.skipSession(timer, settings, now(), perfNow());
      timer = res.timer;
      persistTimer();
      render();
    }

    function onMemoSubmit() {
      if (!timer.memoPending) return;
      submitMemo(els.memoInput.value);
    }
    function onMemoSkip() {
      if (!timer.memoPending) return;
      submitMemo('');
    }

    function submitMemo(text) {
      var pc = timer.pendingCompletion;
      if (pc) {
        logs = Core.setMemoText(logs, pc.dateKey, pc.completedAt, typeof text === 'string' ? text.trim() : '');
        persistLogs();
      }
      var res = Core.resolveMemoAndAdvance(timer, settings, now(), perfNow());
      timer = res.timer;
      els.memoInput.value = '';
      persistTimer();
      render();
    }

    function onSettingsSave() {
      var result = Core.validateSettings({
        focusMin: els.focusInput.value,
        shortBreakMin: els.shortInput.value,
        longBreakMin: els.longInput.value
      });
      if (!result.valid) {
        els.settingsError.hidden = false;
        els.settingsError.textContent = '각 값은 1~180 사이의 정수여야 합니다.';
        return;
      }
      els.settingsError.hidden = true;
      settings = Core.cloneSettings(result.value);
      // FR-07: Idle 세션이면 화면 표시가 즉시 갱신됨 (remainingMs 가 settings 를 참조).
      //        Running/Paused 세션은 endTimestamp/스냅샷을 건드리지 않으므로 다음 회차부터 반영.
      store.write('settings', settings);
      if (timer.status === Core.STATUS.IDLE && !timer.memoPending) {
        timer.remainingMsSnapshot = Core.sessionLengthMs(timer.sessionType, settings);
        persistTimer();
      }
      render();
    }

    // ── tick / 시계 이상 / 만료 ─────────────────────────────────────────────
    function evaluate() {
      if (timer.status === Core.STATUS.RUNNING) {
        // EC-04: 시계 변경 감지
        if (Core.detectClockChange({ dateAnchor: timer.dateAnchor, perfAnchor: timer.perfAnchor }, now(), perfNow())) {
          var lastValid = Math.max(Core.MIN_PAUSED_REMAINING_MS, timer.endTimestamp - now());
          timer = Core.forcePauseForClockChange(timer, lastValid);
          persistTimer();
          try { win.alert('시스템 시간 변경이 감지되어 타이머가 일시정지되었습니다'); } catch (e) { /* noop */ }
          render();
          return;
        }
        // 만료 → 1회 종료 처리
        if (Core.isExpired(timer, now())) {
          var res = Core.completeExpiredSession(timer, settings, now(), perfNow());
          if (res.completion) {
            logs = Core.addCompletion(logs, res.completion.dateKey, res.completion.completedAt, '');
            persistLogs();
          }
          timer = res.timer;
          persistTimer();
          fireNotification(res.memoPending ? '집중 세션 완료 — 메모를 입력하세요' : '휴식 종료 — 다음 집중을 시작합니다');
          render();
          return;
        }
      }
      render();
    }

    function tick() {
      evaluate();
    }

    function onVisibilityChange() {
      if (doc.visibilityState === 'visible') {
        // EC-02 / EC-04: 탭 복귀 시 앵커 재설정 후 즉시 재계산.
        if (timer.status === Core.STATUS.RUNNING && !Core.isExpired(timer, now()) &&
            !Core.detectClockChange({ dateAnchor: timer.dateAnchor, perfAnchor: timer.perfAnchor }, now(), perfNow())) {
          timer.dateAnchor = now();
          timer.perfAnchor = perfNow();
        }
        evaluate();
      }
    }

    // ── 부트스트랩 ─────────────────────────────────────────────────────────
    function loadPersisted() {
      var savedSettings = store.read('settings', null);
      if (savedSettings) {
        var v = Core.validateSettings(savedSettings);
        settings = v.valid ? Core.cloneSettings(v.value) : Core.defaultSettings();
      }
      var savedLogs = store.read('logs', null);
      if (savedLogs && typeof savedLogs === 'object') logs = savedLogs;

      var savedTimer = store.read('timer', null);
      var restored = Core.restoreTimer(savedTimer, settings, now(), perfNow());
      timer = restored.timer;
      if (restored.expired) {
        if (restored.completion) {
          logs = Core.addCompletion(logs, restored.completion.dateKey, restored.completion.completedAt, '');
          persistLogs();
        }
        fireNotification(restored.memoPending
          ? '집중 세션이 종료되었습니다 — 메모를 입력하세요'
          : '휴식이 종료되었습니다');
      }
      persistTimer();
    }

    function cacheEls() {
      els.root = $('app');
      els.banner = $('storage-banner');
      els.navTimer = $('nav-timer');
      els.navSettings = $('nav-settings');
      els.navLog = $('nav-log');
      els.timerView = $('view-timer');
      els.settingsView = $('view-settings');
      els.logView = $('view-log');
      els.sessionType = $('session-type');
      els.slotInfo = $('slot-info');
      els.clock = $('clock');
      els.controls = $('timer-controls');
      els.startPauseBtn = $('btn-start-pause');
      els.resetBtn = $('btn-reset');
      els.skipBtn = $('btn-skip');
      els.memoBox = $('memo-box');
      els.memoInput = $('memo-input');
      els.memoSubmit = $('btn-memo-submit');
      els.memoSkip = $('btn-memo-skip');
      els.focusInput = $('set-focus');
      els.shortInput = $('set-short');
      els.longInput = $('set-long');
      els.settingsSave = $('btn-settings-save');
      els.settingsError = $('settings-error');
      els.logDate = $('log-date');
      els.logCount = $('log-count');
      els.logList = $('log-list');
    }

    function wire() {
      els.startPauseBtn.addEventListener('click', onStartPause);
      els.resetBtn.addEventListener('click', onReset);
      els.skipBtn.addEventListener('click', onSkip);
      els.memoSubmit.addEventListener('click', onMemoSubmit);
      els.memoSkip.addEventListener('click', onMemoSkip);
      els.settingsSave.addEventListener('click', onSettingsSave);
      els.navTimer.addEventListener('click', function () { view = 'timer'; render(); });
      els.navSettings.addEventListener('click', function () { view = 'settings'; render(); });
      els.navLog.addEventListener('click', function () { view = 'log'; logViewDate = Core.dateKey(now()); render(); });
      els.logDate.addEventListener('change', function () { logViewDate = els.logDate.value; render(); });
      doc.addEventListener('visibilitychange', onVisibilityChange);
      win.addEventListener('focus', function () { beeper.unlock(); });
      store.subscribe(function () { renderBanner(); });
    }

    function start() {
      cacheEls();
      if (!els.root) throw new Error('App root (#app) not found');
      loadPersisted();
      wire();
      if (notificationSupported(win) && win.Notification.permission === 'default') {
        requestNotificationPermission(win);
      }
      render();
      tickHandle = win.setInterval(tick, TICK_MS);
      return controller;
    }

    function stop() {
      if (tickHandle !== null) {
        win.clearInterval(tickHandle);
        tickHandle = null;
      }
    }

    var controller = {
      start: start,
      stop: stop,
      render: render,
      evaluate: evaluate,
      // 테스트/디버그용 접근자
      getState: function () {
        return {
          settings: Core.cloneSettings(settings),
          logs: logs,
          timer: Core.copyTimer(timer),
          view: view,
          storeState: store.getState()
        };
      },
      _internals: {
        onStartPause: onStartPause,
        onReset: onReset,
        onSkip: onSkip,
        submitMemo: submitMemo,
        onSettingsSave: onSettingsSave,
        onVisibilityChange: onVisibilityChange,
        fireNotification: fireNotification
      }
    };

    return controller;
  }

  return {
    createApp: createApp,
    createBeeper: createBeeper,
    formatClock: formatClock,
    sessionLabel: sessionLabel,
    notificationSupported: notificationSupported,
    notificationGranted: notificationGranted,
    requestNotificationPermission: requestNotificationPermission
  };
});
