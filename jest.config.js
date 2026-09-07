/**
 * Jest 설정 — 개발AI 자체 테스트(tests/dev)와 테스트AI 독립 테스트(tests/review)가
 * 동일한 실행 도구/설정으로 구동되도록 한다.
 *
 * 출력 파일명은 Makefile 의 각 타겟이 환경변수로 지정한다.
 *   test-dev   → JEST_JUNIT_OUTPUT_NAME=dev.xml
 *   test-review→ JEST_JUNIT_OUTPUT_NAME=review.xml
 * (jest-junit 은 환경변수를 설정 옵션보다 우선한다.)
 */
module.exports = {
  testEnvironment: 'jsdom',
  testEnvironmentOptions: {
    url: 'http://localhost/',
  },
  rootDir: __dirname,
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  clearMocks: true,
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: 'reports',
        outputName: 'dev.xml',
        classNameTemplate: '{filename} › {classname}',
        titleTemplate: '{title}',
        ancestorSeparator: ' › ',
        includeConsoleOutput: 'false',
        addFileAttribute: 'true',
      },
    ],
  ],
};
