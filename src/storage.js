/*
 * storage.js — localStorage 지속성 계층 (EC-05 / 7.2 / 12.2)
 *
 * - 설정 / 일별 로그 / 진행 중 타이머 상태를 각각 별도 키로 분리 저장.
 * - 쓰기 실패 시:
 *     · 저장소 상태를 'Write-Failed' 로 전환 (6.2)
 *     · 타이머/세션 진행은 중단하지 않음 (호출측에서 계속 동작)
 *     · 실패한 쓰기를 큐에 보관하고, 이후 모든 write() 호출 시점마다 자동 재시도
 *     · 재시도 성공 시 저장소 상태를 'Synced' 로 되돌림
 * - 수동 재시도 UI 없음 (EC-05).
 *
 * backend 는 Web Storage 인터페이스(getItem/setItem/removeItem)를 따르는 객체면 된다.
 * 테스트에서 인메모리/실패 주입 더블로 교체 가능하도록 주입식으로 설계.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PomodoroStorage = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORE_STATE = { SYNCED: 'Synced', WRITE_FAILED: 'Write-Failed' };

  var DEFAULT_KEYS = {
    settings: 'pomodoro.v1.settings',
    logs: 'pomodoro.v1.logs',
    timer: 'pomodoro.v1.timer'
  };

  function resolveBackend(explicit) {
    if (explicit) return explicit;
    // 일부 브라우저는 file:// / 시크릿 모드에서 localStorage 접근 자체가 예외를 던진다.
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) { /* 접근 불가 → 백엔드 없음으로 처리 (EC-05) */ }
    return null;
  }

  function createStore(options) {
    options = options || {};
    var backend = resolveBackend(options.backend);
    var keys = options.keys || DEFAULT_KEYS;

    var state = STORE_STATE.SYNCED;
    // 실패한 쓰기: 논리 키 -> 직렬화된 문자열. 마지막 값만 유지.
    var pending = {};
    var listeners = [];

    function emit() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](state); } catch (e) { /* 리스너 예외는 저장 흐름을 막지 않는다 */ }
      }
    }

    function setState(next) {
      if (state !== next) {
        state = next;
        emit();
      }
    }

    function getState() {
      return state;
    }

    function hasPending() {
      for (var k in pending) {
        if (Object.prototype.hasOwnProperty.call(pending, k)) return true;
      }
      return false;
    }

    function rawSet(storageKey, serialized) {
      if (!backend || typeof backend.setItem !== 'function') {
        throw new Error('No storage backend available');
      }
      backend.setItem(storageKey, serialized);
    }

    // 큐에 쌓인 실패 쓰기를 재시도한다. 전부 성공하면 Synced 로 복귀.
    function retryPending() {
      var succeededAll = true;
      for (var logicalKey in pending) {
        if (!Object.prototype.hasOwnProperty.call(pending, logicalKey)) continue;
        var storageKey = keys[logicalKey];
        try {
          rawSet(storageKey, pending[logicalKey]);
          delete pending[logicalKey];
        } catch (e) {
          succeededAll = false;
        }
      }
      if (succeededAll && !hasPending()) {
        setState(STORE_STATE.SYNCED);
      }
      return succeededAll && !hasPending();
    }

    // 값을 저장한다. 반환값: 이번 쓰기가 즉시 성공했으면 true, 실패(큐 적재)면 false.
    // 어떤 경우에도 예외를 던지지 않는다 — 앱 사용을 막지 않기 위함 (EC-05).
    function write(logicalKey, value) {
      if (!Object.prototype.hasOwnProperty.call(keys, logicalKey)) {
        throw new Error('Unknown storage key: ' + logicalKey);
      }
      var serialized;
      try {
        serialized = JSON.stringify(value);
      } catch (e) {
        // 직렬화 불가 값은 저장 대상이 아니다.
        return false;
      }

      // 매 write 시점마다 먼저 밀린 쓰기를 재시도한다 (EC-05).
      if (hasPending()) {
        retryPending();
      }

      try {
        rawSet(keys[logicalKey], serialized);
        // 방금 성공. 같은 키의 밀린 항목이 있었다면 최신값으로 덮였으므로 제거.
        if (Object.prototype.hasOwnProperty.call(pending, logicalKey)) {
          delete pending[logicalKey];
        }
        if (!hasPending()) {
          setState(STORE_STATE.SYNCED);
        }
        return true;
      } catch (e) {
        pending[logicalKey] = serialized;
        setState(STORE_STATE.WRITE_FAILED);
        return false;
      }
    }

    // 값을 읽어 JSON 파싱한다. 없거나 파싱 실패면 fallback(기본 null).
    function read(logicalKey, fallback) {
      if (!Object.prototype.hasOwnProperty.call(keys, logicalKey)) {
        throw new Error('Unknown storage key: ' + logicalKey);
      }
      if (arguments.length < 2) fallback = null;
      if (!backend || typeof backend.getItem !== 'function') return fallback;
      var raw;
      try {
        raw = backend.getItem(keys[logicalKey]);
      } catch (e) {
        return fallback;
      }
      if (raw === null || raw === undefined) return fallback;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') return function () {};
      listeners.push(listener);
      return function () {
        var idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }

    return {
      STORE_STATE: STORE_STATE,
      keys: keys,
      getState: getState,
      hasPending: hasPending,
      write: write,
      read: read,
      retryPending: retryPending,
      subscribe: subscribe
    };
  }

  return {
    STORE_STATE: STORE_STATE,
    DEFAULT_KEYS: DEFAULT_KEYS,
    createStore: createStore
  };
});
