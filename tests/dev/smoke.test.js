'use strict';

const { boot, $, isHidden, run } = require('./helpers/harness');

describe('harness smoke', () => {
  test('boot exposes Pomodoro API and renders initial Focus-Idle', () => {
    const { P } = boot();
    const s = P.getState();
    expect(s.sessionType).toBe('Focus');
    expect(s.sessionStatus).toBe('Idle');
    expect(s.remainingMs).toBe(25 * 60000);
    expect($('time-display').textContent).toBe('25:00');
    expect(isHidden('timer-controls')).toBe(false);
    expect(isHidden('memo-panel')).toBe(true);
  });

  test('start then advance 5 minutes shows 20:00', () => {
    const { P, clock } = boot();
    P.start();
    run(P, clock, 5 * 60000, 1000);
    expect(P.getState().remainingMs).toBe(20 * 60000);
  });
});
