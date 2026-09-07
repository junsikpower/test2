/*
 * 자체 테스트 — 작업 메모 기록 (FR-05), 일별 로그 화면 (FR-06)
 * 대상: src/core.js 의 DailyLog 헬퍼
 */
'use strict';

const Core = require('../../src/core.js');

describe('FR-05 작업 메모 기록', () => {
  test('test_FR05_빈값_제출도_건너뛰기도_완료카운트는_정상_증가한다', () => {
    let logs = Core.emptyLogs();
    logs = Core.addCompletion(logs, '2026-09-07', 100, '');        // 빈 값 제출
    logs = Core.addCompletion(logs, '2026-09-07', 200, undefined); // 건너뛰기(텍스트 없음)
    expect(Core.getDailyLog(logs, '2026-09-07').count).toBe(2);
  });

  test('test_FR05_빈_메모는_메모없음으로_표시된다', () => {
    expect(Core.displayMemoText('')).toBe('메모 없음');
    expect(Core.displayMemoText('   ')).toBe('메모 없음');
    expect(Core.displayMemoText('코드 리뷰')).toBe('코드 리뷰');
  });

  test('test_FR05_제출한_메모_텍스트가_완료항목에_저장된다', () => {
    let logs = Core.emptyLogs();
    logs = Core.addCompletion(logs, '2026-09-07', 100, '');
    logs = Core.setMemoText(logs, '2026-09-07', 100, 'PRD 8장 정리');
    const day = Core.getDailyLog(logs, '2026-09-07');
    expect(day.memos[0].text).toBe('PRD 8장 정리');
    expect(day.count).toBe(1); // 카운트는 변하지 않음
  });

  test('test_INT_addCompletion은_입력받은_logs를_변경하지_않는다', () => {
    const original = Core.emptyLogs();
    const next = Core.addCompletion(original, '2026-09-07', 100, 'x');
    expect(original).toEqual({});
    expect(next).not.toBe(original);
  });
});

describe('FR-06 일별 로그 화면', () => {
  test('test_FR06_표시되는_완료개수가_해당날짜_정상종료_Focus수와_정확히_일치한다', () => {
    let logs = Core.emptyLogs();
    logs = Core.addCompletion(logs, '2026-09-07', 1000, 'a');
    logs = Core.addCompletion(logs, '2026-09-07', 2000, 'b');
    logs = Core.addCompletion(logs, '2026-09-07', 3000, 'c');
    logs = Core.addCompletion(logs, '2026-09-08', 4000, 'other-day');
    expect(Core.getDailyLog(logs, '2026-09-07').count).toBe(3);
    expect(Core.getDailyLog(logs, '2026-09-08').count).toBe(1);
  });

  test('test_FR06_메모가_오래된순_오름차순으로_정렬되어_표시된다', () => {
    let logs = Core.emptyLogs();
    // 일부러 시간 역순으로 추가
    logs = Core.addCompletion(logs, '2026-09-07', 3000, 'third');
    logs = Core.addCompletion(logs, '2026-09-07', 1000, 'first');
    logs = Core.addCompletion(logs, '2026-09-07', 2000, 'second');
    const memos = Core.getDailyLog(logs, '2026-09-07').memos;
    expect(memos.map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  test('test_FR06_완료기록이_없는_날짜는_개수0_빈_메모목록을_반환한다', () => {
    const day = Core.getDailyLog(Core.emptyLogs(), '2000-01-01');
    expect(day).toEqual({ count: 0, memos: [] });
  });

  test('test_FR06_날짜키는_사용자_기기의_로컬_타임존_기준이다', () => {
    // 로컬 자정 직후 시각 → 그 날짜로 귀속되어야 한다
    const localMidnight = new Date(2026, 5, 15, 0, 0, 30).getTime();
    expect(Core.dateKey(localMidnight)).toBe('2026-06-15');
    const localBeforeMidnight = new Date(2026, 5, 15, 23, 59, 30).getTime();
    expect(Core.dateKey(localBeforeMidnight)).toBe('2026-06-15');
  });
});
