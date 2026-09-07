/*
 * jest.config.js — 개발AI 자체 테스트(tests/dev)와 테스트AI 독립 테스트(tests/review)
 * 양쪽 모두 이 설정으로 실행된다. 실행 대상 디렉토리는 Makefile 에서 인자로 지정한다.
 *
 * JUnit XML 산출:
 *   test-dev    → reports/dev.xml   (JEST_JUNIT_OUTPUT_NAME=dev.xml)
 *   test-review → reports/review.xml(JEST_JUNIT_OUTPUT_NAME=review.xml)
 */
'use strict';

module.exports = {
  testEnvironment: 'jsdom',
  rootDir: __dirname,
  testMatch: ['**/tests/**/*.test.js'],
  clearMocks: true,
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: 'reports',
        outputName: process.env.JEST_JUNIT_OUTPUT_NAME || 'dev.xml',
        addFileAttribute: 'true',
        ancestorSeparator: ' › ',
        classNameTemplate: '{classname}',
        titleTemplate: '{title}'
      }
    ]
  ]
};
