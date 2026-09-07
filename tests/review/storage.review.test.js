/*
 * 독립 테스트 — 지속성 계층 (src/storage.js createStore)
 *
 * 근거: PRD EC-05(localStorage 쓰기 실패), §7.2 / §12.2(키 3분리 저장, 자동 재시도).
 * 직전 커밋(git diff HEAD~1 HEAD -- src/storage.js): resolveBackend 에서 전역 localStorage
 * 접근 자체가 예외를 던지는 환경(file:// / 시크릿 모드)을 try/catch 로 흡수하도록 변경됨.
 *
 * 외부 서비스(localStorage)는 인메모리 테스트 더블로 대체한다(§CI 계약 4-가: 응답 계약 테스트).
 *
 * @jest-environment jsdom
 */
'use strict';

const { Storage, makeBackend } = require('./_helpers');

describe('EC-05 localStorage 쓰기 실패', () => {
  test('test_EC05_쓰기가_실패하면_저장소상태가_WriteFailed로_전환된다', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });
    backend.failWrites = true;
    const ok = store.write('settings', { focusMin: 25 });
    expect(ok).toBe(false);
    expect(store.getState()).toBe(store.STORE_STATE.WRITE_FAILED);
  });

  test('test_EC05_쓰기_실패시에도_예외를_던지지_않아_앱_사용이_중단되지_않는다', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });
    backend.failWrites = true;
    expect(() => {
      store.write('settings', { a: 1 });
      store.write('logs', { b: 2 });
      store.write('timer', { c: 3 });
    }).not.toThrow();
  });

  test('test_EC05_실패한_쓰기는_이후_상태변경_시점마다_자동_재시도되고_성공하면_Synced로_복귀하고_밀린값도_반영된다', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });

    backend.failWrites = true;
    store.write('settings', { focusMin: 25 });
    expect(store.getState()).toBe(store.STORE_STATE.WRITE_FAILED);

    backend.failWrites = false;               // 저장 공간 회복
    const ok = store.write('logs', { day: 1 }); // 다음 상태 변경 = 자동 재시도 트리거
    expect(ok).toBe(true);
    expect(store.getState()).toBe(store.STORE_STATE.SYNCED);
    expect(JSON.parse(backend.getItem(store.keys.settings))).toEqual({ focusMin: 25 });
    expect(JSON.parse(backend.getItem(store.keys.logs))).toEqual({ day: 1 });
  });

  test('test_EC05_저장소상태_변경은_구독자에게_통지된다_경고배너_표시_해제용', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });
    const seen = [];
    store.subscribe((s) => seen.push(s));

    backend.failWrites = true;
    store.write('timer', { x: 1 });
    backend.failWrites = false;
    store.write('timer', { x: 2 });

    expect(seen).toContain(store.STORE_STATE.WRITE_FAILED);
    expect(seen[seen.length - 1]).toBe(store.STORE_STATE.SYNCED);
  });

  test('test_EC05_수동_재시도_API없이_write호출만으로_재시도가_이뤄진다_재시도전까지는_경고가_유지된다', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });
    backend.failWrites = true;
    store.write('timer', { x: 1 });
    // 계속 실패하는 동안에는 Write-Failed 유지
    store.write('timer', { x: 2 });
    store.write('settings', { focusMin: 30 });
    expect(store.getState()).toBe(store.STORE_STATE.WRITE_FAILED);
    expect(store.hasPending()).toBe(true);
  });
});

describe('§7.2 / §12.2 저장소 분리 및 지속성', () => {
  test('test_FR08_설정_로그_타이머는_서로_다른_키_3개로_분리_저장된다', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });
    store.write('settings', { focusMin: 25 });
    store.write('logs', { '2026-09-07': { count: 1, memos: [] } });
    store.write('timer', { status: 'Idle' });
    const usedKeys = Object.keys(backend.map);
    expect(new Set(usedKeys).size).toBe(3);
    expect(usedKeys).toEqual(expect.arrayContaining([
      store.keys.settings, store.keys.logs, store.keys.timer
    ]));
  });

  test('test_FR08_저장된_값은_새_스토어_인스턴스에서_동일하게_역직렬화되어_복원된다', () => {
    const backend = makeBackend();
    const s1 = Storage.createStore({ backend });
    const settings = { focusMin: 40, shortBreakMin: 8, longBreakMin: 25 };
    s1.write('settings', settings);
    const s2 = Storage.createStore({ backend });   // = 새로고침
    expect(s2.read('settings')).toEqual(settings);
  });
});

/* ── 커밋 코드 기반(INT): backend 해석/접근 예외 방어 ────────────────────────── */
describe('INT storage backend 해석 및 예외 흡수', () => {
  test('test_INT_전역_localStorage_접근이_예외를_던져도_createStore와_write가_예외없이_동작한다', () => {
    // git diff HEAD~1 HEAD -- src/storage.js: resolveBackend 의 try/catch 도입 검증.
    const g = global;
    const original = Object.getOwnPropertyDescriptor(g, 'localStorage') || null;
    let installed = false;
    try {
      Object.defineProperty(g, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('blocked', 'SecurityError'); }
      });
      installed = true;
    } catch (e) { /* 이 환경에선 전역 재정의 불가 — createStore 무예외만 확인 */ }

    try {
      let store;
      expect(() => { store = Storage.createStore({}); }).not.toThrow();
      if (installed) {
        // 백엔드가 없으므로 write 는 조용히 false, 예외 없음. read 는 fallback.
        expect(store.write('settings', { a: 1 })).toBe(false);
        expect(store.read('settings', { fallback: true })).toEqual({ fallback: true });
      }
    } finally {
      if (installed) {
        if (original) Object.defineProperty(g, 'localStorage', original);
        else { try { delete g.localStorage; } catch (e) { /* noop */ } }
      }
    }
  });

  test('test_INT_setItem이_없는_backend는_WriteFailed로_전이하고_throw하지_않는다', () => {
    const store = Storage.createStore({ backend: {} });
    expect(store.write('timer', { x: 1 })).toBe(false);
    expect(store.getState()).toBe(store.STORE_STATE.WRITE_FAILED);
  });

  test('test_INT_getItem이_예외를_던지는_backend에서_read는_fallback을_반환한다', () => {
    const backend = makeBackend();
    backend.throwOnRead = true;
    const store = Storage.createStore({ backend });
    expect(store.read('timer', null)).toBeNull();
    expect(store.read('timer', { safe: 1 })).toEqual({ safe: 1 });
  });

  test('test_INT_손상된_JSON이_저장돼_있으면_read는_fallback을_반환한다', () => {
    const backend = makeBackend();
    backend.map[Storage.DEFAULT_KEYS.timer] = '{ not valid json';
    const store = Storage.createStore({ backend });
    expect(store.read('timer', null)).toBeNull();
    expect(store.read('timer', { d: 1 })).toEqual({ d: 1 });
  });

  test('test_INT_직렬화_불가능한_순환참조_값을_write하면_예외없이_false를_반환한다', () => {
    const store = Storage.createStore({ backend: makeBackend() });
    const circular = {};
    circular.self = circular;
    expect(store.write('timer', circular)).toBe(false);
  });

  test('test_INT_구독_해제후에는_상태변경_통지를_받지_않으며_저장흐름은_계속된다', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });
    const seen = [];
    const off = store.subscribe((s) => seen.push(s));
    off();
    backend.failWrites = true;
    expect(() => store.write('timer', { x: 1 })).not.toThrow();
    expect(seen).toEqual([]);
  });

  test('test_INT_알수없는_논리키로_read_write하면_예외를_던진다', () => {
    const store = Storage.createStore({ backend: makeBackend() });
    expect(() => store.write('unknown', {})).toThrow();
    expect(() => store.read('unknown')).toThrow();
  });
});
