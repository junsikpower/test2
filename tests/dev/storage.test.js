/*
 * 자체 테스트 — localStorage 쓰기 실패 (EC-05), 저장소 분리 및 지속성 (7.2 / 12.2)
 * 대상: src/storage.js createStore()
 */
'use strict';

const Storage = require('../../src/storage.js');

/** Web Storage 인터페이스를 흉내내는 인메모리 더블. failNext 로 쓰기 실패를 주입한다. */
function makeBackend() {
  const map = {};
  return {
    map,
    failWrites: false,
    setItem(k, v) {
      if (this.failWrites) throw new DOMException('quota exceeded', 'QuotaExceededError');
      map[k] = String(v);
    },
    getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    removeItem(k) { delete map[k]; }
  };
}

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

  test('test_EC05_실패한_쓰기는_이후_상태변경_시점마다_자동_재시도되고_성공하면_Synced로_복귀한다', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });

    backend.failWrites = true;
    store.write('settings', { focusMin: 25 });
    expect(store.getState()).toBe(store.STORE_STATE.WRITE_FAILED);

    // 저장 공간이 회복됨. 다음 상태 변경(=다음 write) 시점에 자동 재시도.
    backend.failWrites = false;
    const ok = store.write('logs', { day: 1 });
    expect(ok).toBe(true);
    expect(store.getState()).toBe(store.STORE_STATE.SYNCED);
    // 밀렸던 settings 쓰기도 반영되었는지
    expect(JSON.parse(backend.getItem(store.keys.settings))).toEqual({ focusMin: 25 });
  });

  test('test_EC05_저장소상태_변경은_구독자에게_통지된다 (경고배너 표시/해제용)', () => {
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

  test('test_INT_구독_해제_후에는_통지를_받지_않는다', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });
    const seen = [];
    const off = store.subscribe((s) => seen.push(s));
    off();
    backend.failWrites = true;
    store.write('timer', { x: 1 });
    expect(seen).toEqual([]);
  });
});

describe('7.2 / 12.2 저장소 분리 및 지속성', () => {
  test('test_INT_설정_로그_타이머는_서로_다른_키로_분리_저장된다', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });
    store.write('settings', { focusMin: 25 });
    store.write('logs', { '2026-09-07': { count: 1, memos: [] } });
    store.write('timer', { status: 'Idle' });
    const usedKeys = Object.keys(backend.map);
    expect(new Set(usedKeys).size).toBe(3);
    expect(usedKeys).toContain(store.keys.settings);
    expect(usedKeys).toContain(store.keys.logs);
    expect(usedKeys).toContain(store.keys.timer);
  });

  test('test_FR08_저장된_값은_read로_동일하게_역직렬화되어_복원된다', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });
    const settings = { focusMin: 40, shortBreakMin: 8, longBreakMin: 25 };
    store.write('settings', settings);
    // 새 스토어 인스턴스(=새로고침) 로도 동일하게 읽힘
    const store2 = Storage.createStore({ backend });
    expect(store2.read('settings')).toEqual(settings);
  });

  test('test_INT_손상된_JSON이_저장돼_있으면_read는_fallback을_반환한다', () => {
    const backend = makeBackend();
    backend.map['pomodoro.v1.timer'] = '{ this is not json';
    const store = Storage.createStore({ backend });
    expect(store.read('timer', null)).toBeNull();
    expect(store.read('timer', { safe: true })).toEqual({ safe: true });
  });

  test('test_INT_직렬화_불가능한_값을_write하면_예외없이_false를_반환한다', () => {
    const backend = makeBackend();
    const store = Storage.createStore({ backend });
    const circular = {};
    circular.self = circular;
    expect(store.write('timer', circular)).toBe(false);
  });
});
