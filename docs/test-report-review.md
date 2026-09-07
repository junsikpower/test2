# 독립 테스트 설계 산출물 — 리뷰/테스트 AI

> 이 문서는 **설계 산출물**이며 실행 결과가 아니다. 테스트의 실행·통과 판정은 오케스트레이터가 수행한다.
>
> - 대상 커밋: `e144e9b 개발AI 작업 (1회차)` (HEAD). 직전 커밋 대비 변경 분석은 `git diff HEAD~1 HEAD`.
> - 테스트 코드 위치: `tests/review/`  (도우미: `tests/review/_helpers.js` — `*.test.js` 아님 → 테스트 케이스 아님)
> - 실행 계약: `make test-review` → `JEST_JUNIT_OUTPUT_NAME=review.xml npx jest --config jest.config.js --ci tests/review` → `reports/review.xml`
> - 도구: Jest 29.7 (`jsdom`), jest-junit 16. Makefile `test-review` 타겟이 호출하는 도구·문법과 동일.
> - `tests/dev/` (개발 AI 자체 테스트)는 설계·작성 전 과정에서 참조하지 않았다. 근거는 PRD 명세와 `src/*.js`·`index.html` 공개 인터페이스뿐이다.
> - 개발 코드는 수정하지 않았다.

## 1. 직전 커밋(HEAD~1 → HEAD) 변경 요약과 회귀 분석 범위

`git diff HEAD~1 HEAD` 로 확인된 변경 파일:

| 파일 | 변경 내용 | 회귀 영향 범위 |
|---|---|---|
| `index.html` | `src/*.js` 를 재번들한 배포물. `restoredPending` 플래그 흐름, `lastValidRemainingMs` 고정값, storage `try/catch` 가 배포물에 반영됨 | 단일 파일 앱 전체 (부팅·타이머·복원·저장) |
| `src/app.js` | `lastValidRemainingMs` 도입: 매 정상 tick 마다 남은 시간을 기록하고, EC-04 시계 변경 감지 시 `endTimestamp - now()`(점프로 오염됨) 대신 **감지 직전 마지막 유효값**으로 Paused 스냅샷을 고정. 시작/리셋/스킵/메모해소/만료 시 `lastValidRemainingMs` 리셋 | `evaluate()`, `onVisibilityChange()`, `forcePauseForClockChange` 호출부. 공유 상태: `timer` 클로저, `store`(localStorage) |
| `src/storage.js` | `resolveBackend()` 에서 전역 `localStorage` 접근 자체가 예외를 던지는 환경(`file://`/시크릿 모드)을 `try/catch` 로 흡수 → 백엔드 없음으로 처리 | `createStore()` 부팅 경로. `write/read` 의 backend 부재 분기 |
| `tests/dev/*` (신규 4파일) | 개발 AI 자체 테스트 — **참조하지 않음** | — |

`src/core.js` 는 이번 커밋에서 변경되지 않았다(`git diff HEAD~1 HEAD -- src/core.js` 결과 없음). 다만 `restoredPending` 분기(`resolveMemoAndAdvance`, `completeExpiredSession`, `restoreTimer`)가 이번에 처음으로 **배포물 `index.html` 에 반영**되었으므로, 해당 분기와 그 인접 경로(사이클 슬롯 소모 시점, 복원 후 자동시작 억제)를 회귀 영향 범위에 포함하여 검토했다.

연관 모듈: `src/app.js` 는 `src/core.js`·`src/storage.js` 를 직접 import. 세 모듈은 `localStorage`(3개 분리 키)라는 전역 저장 데이터를 공유하므로 저장/복원 경로를 통합 시나리오로 함께 검증한다.

## 2. 설계한 테스트 케이스 목록

### 2.1 `tests/review/core-timer.review.test.js` — 타이머/사이클/정확도 (순수 로직)

| 함수명 | 근거 |
|---|---|
| `test_FR01_시작시_종료목표시각은_현재시각더하기_설정된_세션길이다` | FR-01 Processing (endTimestamp = 현재시각 + 남은시간) |
| `test_FR01_시작후_임의시점의_남은시간이_실제경과시간과_일치한다` | FR-01 Acceptance Criteria 1 |
| `test_FR01_일시정지후_남은시간이_변하지_않는다` | FR-01 Acceptance Criteria 2 |
| `test_FR01_리셋시_설정된_세션길이의_Idle상태로_정확히_복귀한다` | FR-01 Acceptance Criteria 3 |
| `test_FR01_MemoInputPending상태에서_시작_일시정지_리셋_호출은_거부된다 (BR-04)` | FR-01 Processing / BR-04 |
| `test_BR03_3번째_Focus슬롯까지_소모된상태에서_4번째_Focus를_리셋해도_슬롯수는_3으로_유지된다` | BR-03 / FR-01 Acceptance Criteria 4 |
| `test_FR03_Focus_정상종료시_완료카운트귀속정보와_함께_MemoInputPending으로_전환된다` | FR-03 Processing (1)(2) |
| `test_FR03_그외_Focus종료시_메모해소_후_ShortBreak로_전환된다` | FR-03 Acceptance Criteria 2 / BR-01 |
| `test_FR03_4번째_Focus슬롯_소모직후에는_반드시_LongBreak로_전환된다` | FR-03 Acceptance Criteria 1 / BR-01 |
| `test_FR03_Break세션_종료후에는_메모입력없이_곧바로_다음_Focus가_자동시작된다` | FR-03 Acceptance Criteria 3 |
| `test_FR04_Focus_스킵시_완료카운트도_메모입력도_요구하지_않는다` | FR-04 Processing / Acceptance Criteria 1 |
| `test_FR04_Focus_스킵시에도_사이클_슬롯은_소모되어_LongBreak_도달순서에_반영된다` | FR-04 Processing / BR-01 |
| `test_FR04_MemoInputPending상태에서는_스킵할_수_없다 (BR-04)` | FR-04 Processing / BR-04 |
| `test_FR04_Focus를_2회_스킵한_뒤_정상완료를_2회_채우면_총4슬롯_소모로_LongBreak_전환되고_완료카운트는_2다` | FR-04 Acceptance Criteria 2 |
| `test_BR01_세션은_Focus_ShortBreak_반복하다_4번째_Focus후_LongBreak_그다음_Focus로_재시작한다` | BR-01 (세션 순서) |
| `test_BR01_LongBreak가_스킵된_경우에도_사이클이_초기화되어_Focus부터_슬롯0으로_재시작한다` | BR-01 (Long Break 스킵 시 사이클 초기화) |
| `test_BR01_하루_완료개수는_정상종료된_Focus에만_1증가하고_스킵된_Focus는_포함되지_않는다` | BR-01 (완료 카운트 규칙) |
| `test_NFR01_장시간_연속구동시_표시_남은시간과_실제경과시간간_누적오차가_없다` | NFR-01 (드리프트 0, 실측) / 12.2 |
| `test_INT_completeExpiredSession_반환timer의_focusSlotsConsumed는_메모해소_전까지_증가하지_않는다` | 코드: `index.html`/`src/core.js completeExpiredSession` Focus 만료 분기 (커밋에서 슬롯 미리 증가 제거) |
| `test_INT_Focus만료_후_메모해소까지_슬롯은_정확히_1회만_소모된다_slots0에서_1` | 코드: `completeExpiredSession` → `resolveMemoAndAdvance` → `advanceCycle` 슬롯 소모 경로 (이중 소모 회귀 방지) |

### 2.2 `tests/review/core-restore.review.test.js` — 재접속 복원

| 함수명 | 근거 |
|---|---|
| `test_FR08_Running으로_저장된_세션이_아직_남아있으면_남은시간을_그대로_이어서_표시한다` | FR-08 Processing (Running, 미만료) / EC-03 |
| `test_EC03_Running_만료시_경과세션수와_무관하게_중단시점_세션_1회만_종료처리한다` | EC-03 / FR-08 Acceptance Criteria 2 / 12.2 (다중 세션 만료 1회 처리) |
| `test_FR08_완료처리된_세션의_로그귀속_날짜는_원래_종료목표시각_기준이다_현재시각_아님` | FR-08 Processing / Acceptance Criteria 2 / EC-03 |
| `test_BR02_복원후_다음세션은_자동시작되지_않고_Idle로_대기하며_사용자_시작조작을_요한다` | BR-02 / FR-08 Acceptance Criteria 3 |
| `test_EC03_Running_만료세션이_Break였다면_메모없이_다음_Focus를_Idle로_대기시킨다` | EC-03 (Break 만료) / BR-02 |
| `test_FR08_재접속_복원_경로에서_Focus_슬롯은_메모해소시_정확히_1회_소모된다_3에서_4_LongBreak` | FR-08 / BR-01 (복원 경로 슬롯 소모 1회) |
| `test_FR08_Paused로_저장된_세션은_오프라인시간과_무관하게_남은시간_스냅샷_그대로_복원되고_종료처리되지_않는다` | FR-08 Processing (Paused) / Acceptance Criteria 4 / EC-03 / 13.1 |
| `test_FR08_Idle로_저장된_세션은_설정된_길이로_복원되고_만료판정을_하지_않는다` | FR-08 Processing |
| `test_FR08_MemoInputPending으로_저장된_상태는_완료를_다시_세지_않고_메모대기로_복원된다` | FR-08 Processing / 6.2 |
| `test_INT_restoredPending_true면_메모해소가_Idle을_반환하고_false면_Running을_반환한다` | 코드: `src/core.js resolveMemoAndAdvance` 의 `restoredPending` 분기 (커밋 신설). PRD 근거는 BR-02 / FR-03 |
| `test_INT_resolveMemoAndAdvance는_memoPending이_아니면_예외를_던진다` | 코드: `resolveMemoAndAdvance` 가드 절 (예외 전파) |
| `test_INT_restoreTimer_null_입력시_초기_Focus_Idle_타이머를_반환한다` | 코드: `restoreTimer` null 분기 |
| `test_INT_restoreTimer_Running인데_endTimestamp가_손상됐으면_안전하게_Idle로_정리한다` | 코드: `restoreTimer` 비정상 endTimestamp 방어 분기 |
| `test_INT_restoreTimer_Paused_스냅샷이_비정상값이면_세션길이로_보정하고_최소값_이상을_보장한다` | 코드: `restoreTimer` Paused 스냅샷 보정 분기 (NaN 경계값) |

### 2.3 `tests/review/core-log-settings.review.test.js` — 설정 검증 / 일별 로그 / 시계 감지 알고리즘

| 함수명 | 근거 |
|---|---|
| `test_FR07_기본값은_집중25_짧은휴식5_긴휴식15분이다` | FR-07 Processing (기본값) / 3.1 |
| `test_FR07_1분과_180분_경계값은_허용된다` | FR-07 Processing (1~180 정수) — 경계값 |
| `test_FR07_0이하_181이상_소수_비숫자는_저장되지_않는다` | FR-07 Acceptance Criteria 2 (Negative) |
| `test_FR07_세_필드중_하나라도_유효하지_않으면_전체_저장이_차단된다` | FR-07 Processing (유효성 검증) |
| `test_FR07_Idle_세션은_설정길이_변경이_남은시간_표시에_즉시_반영된다` | FR-07 Processing (적용 시점, Idle) / Acceptance Criteria 3 |
| `test_FR07_Running_세션은_설정변경이_현세션에_반영되지_않는다_남은시간은_endTimestamp_기준` | FR-07 Acceptance Criteria 4 |
| `test_FR07_Paused_세션은_설정변경이_현세션에_반영되지_않는다_스냅샷_유지` | FR-07 Processing (Running/Paused) / 13.1 |
| `test_FR05_빈값_메모_제출과_건너뛰기_모두_완료카운트는_정상반영되고_메모텍스트만_빈값으로_저장된다` | FR-05 Processing / Acceptance Criteria 2 |
| `test_FR05_빈값_메모는_메모없음으로_표시된다` | FR-05 Output |
| `test_FR05_저장된_메모는_완료시각과_함께_해당_날짜_로그에_추가된다` | FR-05 Processing / Expected State |
| `test_FR06_표시되는_완료개수가_해당_날짜에_정상종료된_Focus_세션_수와_정확히_일치한다` | FR-06 Acceptance Criteria 1 |
| `test_FR06_메모가_오래된순_시간순으로_정렬되어_표시된다` | FR-06 Acceptance Criteria 2 |
| `test_FR06_모든_시각은_기기의_로컬_타임존_기준으로_날짜키가_계산된다` | FR-06 Processing (로컬 타임존) |
| `test_EC04_앵커대비_델타차이가_정확히_5초면_시계변경으로_판정한다` | EC-04 / NFR-01 / 12.2 (임계값 5초, 경계값) |
| `test_EC04_델타차이가_5초미만이면_시계변경으로_판정하지_않는다_절전_백그라운드_동결_오탐지_방지` | EC-04 (오탐지 방지) |
| `test_EC04_원시값이_아니라_앵커대비_델타끼리_비교한다_기준점_다른_두_클록의_정상경과는_오탐지되지_않는다` | EC-04 / 12.2 / 12.3 (원시값 직접 비교 금지 — 대체 불가 결정) |
| `test_EC04_시계변경_감지시_forcePauseForClockChange는_남은시간을_임의로_연장_단축하지_않는다` | EC-04 데이터 처리 / 13.3 |
| `test_EC04_사용자가_재개하면_현재시각_기준_새_endTimestamp를_계산하고_앵커를_재설정한다` | EC-04 재시도/복구 정책 |
| `test_INT_addCompletion은_입력_logs_객체를_변형하지_않는다` | 코드: `src/core.js addCompletion` 불변성 (공유 로그 상태 회귀) |
| `test_INT_forcePauseForClockChange_lastValid가_0이하면_최소_스냅샷값으로_클램프된다` | 코드: `forcePauseForClockChange` 경계값 (`MIN_PAUSED_REMAINING_MS`) |
| `test_INT_advanceCycle은_알수없는_세션타입에_예외를_던진다` | 코드: `advanceCycle` 타입 가드 (예외 전파) |
| `test_INT_detectClockChange는_앵커가_불완전하면_false를_반환한다` | 코드: `detectClockChange` 입력 방어 분기 |

### 2.4 `tests/review/storage.review.test.js` — 지속성 계층 (EC-05 / 7.2 / 12.2)

| 함수명 | 근거 |
|---|---|
| `test_EC05_쓰기가_실패하면_저장소상태가_WriteFailed로_전환된다` | EC-05 시스템 상태 / 6.2 |
| `test_EC05_쓰기_실패시에도_예외를_던지지_않아_앱_사용이_중단되지_않는다` | EC-05 시스템 상태 / 재시도 정책 |
| `test_EC05_실패한_쓰기는_이후_상태변경_시점마다_자동_재시도되고_성공하면_Synced로_복귀하고_밀린값도_반영된다` | EC-05 데이터 처리 (자동 재시도 → Synced 복귀) |
| `test_EC05_저장소상태_변경은_구독자에게_통지된다_경고배너_표시_해제용` | EC-05 사용자에게 표시되는 결과 (경고 표시/해제) |
| `test_EC05_수동_재시도_API없이_write호출만으로_재시도가_이뤄진다_재시도전까지는_경고가_유지된다` | EC-05 재시도/복구/롤백 정책 (수동 재시도 UI 없음) |
| `test_FR08_설정_로그_타이머는_서로_다른_키_3개로_분리_저장된다` | FR-08 / 7.2 / 12.2 (키 3분리) |
| `test_FR08_저장된_값은_새_스토어_인스턴스에서_동일하게_역직렬화되어_복원된다` | FR-08 Acceptance Criteria 1 |
| `test_INT_전역_localStorage_접근이_예외를_던져도_createStore와_write가_예외없이_동작한다` | 코드: `src/storage.js resolveBackend` 의 `try/catch` (커밋 변경) |
| `test_INT_setItem이_없는_backend는_WriteFailed로_전이하고_throw하지_않는다` | 코드: `write` 의 backend 부재 분기 (예외 전파 억제) |
| `test_INT_getItem이_예외를_던지는_backend에서_read는_fallback을_반환한다` | 코드: `read` 의 `try/catch` (backend 접근 예외) |
| `test_INT_손상된_JSON이_저장돼_있으면_read는_fallback을_반환한다` | 코드: `read` 의 `JSON.parse` 실패 분기 |
| `test_INT_직렬화_불가능한_순환참조_값을_write하면_예외없이_false를_반환한다` | 코드: `write` 의 `JSON.stringify` 실패 분기 |
| `test_INT_구독_해제후에는_상태변경_통지를_받지_않으며_저장흐름은_계속된다` | 코드: `subscribe` 해제 클로저 (리스너 리소스 해제) |
| `test_INT_알수없는_논리키로_read_write하면_예외를_던진다` | 코드: `read`/`write` 키 화이트리스트 가드 |

### 2.5 `tests/review/app-dom.review.test.js` — DOM/알림/가시성 배선 (src/app.js)

| 함수명 | 근거 |
|---|---|
| `test_FR01_시작_일시정지_리셋_버튼_조작이_화면_남은시간과_상태에_정확히_반영된다` | FR-01 Output / Expected State |
| `test_FR02_권한이_허용된_경우_소리재생과_브라우저알림_호출이_함께_발생한다` | FR-02 Acceptance Criteria 2 / 12.2 |
| `test_FR02_앱_실행중_세션종료_시점에_알림이_지체없이_발생한다` | FR-02 Acceptance Criteria 1 |
| `test_FR02_오디오_재생이_실패로_감지되면_탭_제목_변경으로_대체된다` | FR-02 Acceptance Criteria 3 |
| `test_FR02_오디오_재생_Promise가_거부돼도_실패로_보고_탭_제목_변경으로_대체된다` | FR-02 Processing ("오디오 재생 실패는 play() 호출의 Promise **거부**로 감지 → 실패 시 탭 제목 변경으로 즉시 대체") |
| `test_EC01_권한이_거부된_경우_소리와_탭제목_변경으로_알리고_데스크톱_알림은_호출하지_않는다` | EC-01 / FR-02 Processing |
| `test_EC01_Notification_API_자체가_미지원인_경우에도_소리와_탭제목으로_알린다` | EC-01 (미지원) |
| `test_EC01_알림_폴백은_완료_카운트_등_데이터에_영향을_주지_않는다` | EC-01 데이터 처리 (영향 없음) |
| `test_EC02_탭_복귀시_visibilitychange에서_종료목표시각과_현재시각을_비교해_즉시_종료처리한다` | EC-02 사용자에게 표시되는 결과 / 12.2 |
| `test_EC02_백그라운드_경과는_절대시각_계산으로_반영되어_로그귀속시각이_원래_종료목표시각이다` | EC-02 데이터 처리 / FR-08 |
| `test_EC04_시계변경_감지시_세션이_즉시_Paused로_전환되고_확인_알림을_표시한다` | EC-04 시스템 상태 / 사용자에게 표시되는 결과 |
| `test_EC04_시계변경시_남은시간은_감지_직전_마지막_유효_계산값으로_고정되고_임의_연장_단축이_없다` | EC-04 데이터 처리 (주된 조항). 코드 근거: 커밋의 `src/app.js lastValidRemainingMs` |
| `test_BR04_MemoInputPending에서는_타이머_제어버튼_영역이_숨겨지고_메모UI만_노출된다` | BR-04 / FR-01 Acceptance Criteria 5 / 13.1 |
| `test_BR04_MemoInputPending은_시작_리셋_스킵으로_벗어날_수_없고_메모_제출_또는_건너뛰기로만_벗어난다` | BR-04 |
| `test_FR03_Focus완료_메모제출후_ShortBreak가_자동시작되고_Break종료후_다음_Focus가_자동시작된다` | FR-03 Output / Expected State |
| `test_FR05_Focus_정상종료마다_메모입력창이_표시된다` | FR-05 Acceptance Criteria 1 |
| `test_FR05_건너뛰기시_완료카운트는_정상증가하고_빈_메모는_로그에_메모없음으로_표시된다` | FR-05 Acceptance Criteria 2 / Output |
| `test_FR06_로그화면_기본_선택날짜는_오늘이고_메모는_오래된순으로_표시된다` | FR-06 Processing (기본값 오늘) / Acceptance Criteria 2 |
| `test_FR07_Idle상태_Focus의_설정변경은_화면_남은시간_표시에_즉시_반영된다` | FR-07 Acceptance Criteria 3 |
| `test_FR07_Running상태_Focus의_설정변경은_현세션에_적용되지_않고_다음_Focus세션부터_적용된다` | FR-07 Acceptance Criteria 4 |
| `test_FR07_범위를_벗어난_값은_저장되지_않고_오류가_표시되며_기존_설정이_유지된다` | FR-07 Acceptance Criteria 2 |
| `test_FR07_설정을_변경하고_저장하면_새로고침_후에도_변경된_값이_유지된다` | FR-07 Acceptance Criteria 1 |
| `test_EC05_쓰기_실패동안_경고배너가_표시되고_타이머는_계속_동작하며_복구되면_배너가_해제된다` | EC-05 사용자에게 표시되는 결과 / 최종 상태 |
| `test_INT_stop_호출후에는_추가_tick이_돌지_않아_상태가_더_변하지_않는다` | 코드: `src/app.js stop()` — `setInterval` 리소스 해제 |
| `test_INT_정상_tick_없이_시계가_종료시각_너머로_점프해도_Paused_스냅샷은_양수로_보정된다` | 코드: 커밋의 `src/app.js lastValidRemainingFallback()` 분기 (`lastValidRemainingMs` 미기록 시 폴백 경로) |
| `test_INT_evaluate를_Idle상태에서_호출해도_예외없이_렌더만_수행한다` | 코드: `src/app.js evaluate()` 비-Running 분기 |

### 2.6 `tests/review/acceptance.review.test.js` — §13 Acceptance Criteria

| 함수명 | 근거 |
|---|---|
| `test_AC13_1_Paused상태에서_새로고침해도_남은시간_스냅샷이_오프라인시간과_무관하게_그대로_복원된다 (FR-08, EC-03)` | 13.1 Functional (Paused 복원) |
| `test_AC13_1_MemoInputPending에서_타이머_제어버튼은_노출되지_않고_메모_제출_건너뛰기_UI만_노출된다 (BR-04)` | 13.1 Functional (BR-04) |
| `test_AC13_1_Idle세션_설정변경은_화면에_즉시_반영되고_Running세션_설정변경은_다음_세션부터_반영된다 (FR-07)` | 13.1 Functional (FR-07) |
| `test_AC13_1_localStorage_쓰기가_실패해도_타이머_사용이_중단되지_않고_저장실패_경고가_표시된다 (EC-05)` | 13.1 Functional (EC-05) |
| `test_AC13_2_정상실행중_시작_종료_기록_자동전환_다음세션_흐름이_끊김없이_동작한다` | 13.2 System (정상 실행 중 시나리오) — 타이머+사이클+메모+로그+자동시작 연동 |
| `test_AC13_2_재접속복원_Running_만료_1회_종료처리_후_다음세션_Idle_수동시작_대기 (BR-02)` | 13.2 System (재접속 복원 시나리오 — Running) |
| `test_AC13_2_재접속복원_Paused_오프라인시간과_무관하게_스냅샷_유지_종료처리_없음 (EC-03)` | 13.2 System (재접속 복원 시나리오 — Paused) |
| `test_AC13_2_스킵과_정상완료가_섞인_사이클에서_4번째_Focus슬롯_소모시_LongBreak로_전환된다 (BR-01, FR-04)` | 13.2 System — 스킵+메모+사이클+로그 통합 |
| `test_AC13_3_하루동안_실제사용시_로그화면의_완료개수와_각_메모가_실제_작업내역과_일치한다` | 13.3 User 항목 1 (조작 사이 시간 경과: 5분 휴식, 90초 자리 비움, 2시간 점심) |
| `test_AC13_3_사용자가_임의_시점에_새로고침해도_진행중이던_세션_설정값_로그가_그대로_유지된다` | 13.3 User 항목 2 (설정 변경 → 세션 완료 → 8분 진행 → 새로고침) |
| `test_AC13_3_시스템시계가_정상_유지되는_동안_수_시간_타이머를_켜둬도_표시된_남은시간이_실제_경과시간과_일치한다` | 13.3 User 항목 3 (180분 세션, 5분 간격 35회 확인 = 175분 경과) |
| `test_AC13_3_시스템시계가_임의로_변경되면_타이머가_늘거나_줄지_않고_일시정지되며_확인을_요청받는다` | 13.3 User 항목 4 (정상 3분 경과 후 시계만 +1h 점프) |
| `test_AC13_3_저장공간_문제로_데이터가_저장되지_않는_상황에서도_사용자는_경고를_통해_이를_인지한다 (EC-05)` | 13.3 User 항목 5 (쓰기 실패 → 경고 → 공간 회복 → 자동 재시도) |

### 2.7 `tests/review/constraints.review.test.js` — 기술 제약 / 범위 (배포물 `index.html` 검사)

| 함수명 | 근거 |
|---|---|
| `test_NFR02_외부_script_src를_포함하지_않는다` | NFR-02 / 12.1 |
| `test_NFR02_외부_link_href_또는_CSS_import를_포함하지_않는다` | NFR-02 / 12.1 |
| `test_NFR02_w3org_네임스페이스_URI를_제외하면_외부_http_https_URL_참조가_전혀_없다` | NFR-02 / 12.1 (외부 API·CDN 미사용) |
| `test_NFR02_외부_음원_파일을_참조하지_않고_Web_Audio로_합성한다 (§12.2)` | NFR-02 / 12.1 / 12.2 (외부 음원 파일 금지) |
| `test_NFR02_data_URL로_외부폰트_이미지_음원을_우회_삽입하지_않는다` | NFR-02 / 12.1 |
| `test_121_React_Vue_Angular_Svelte_등_프레임워크_번들을_포함하지_않는다` | 12.1 (프레임워크 미사용) |
| `test_121_아이콘_등_그래픽요소는_인라인_SVG로_구현하고_외부_이미지를_쓰지_않는다` | 12.1 (인라인 SVG) |
| `test_122_타이머는_setInterval_카운트다운이_아니라_endTimestamp_절대시각_방식을_사용한다` | 12.2 |
| `test_122_시계변경_감지는_performance_now_앵커_델타_비교_방식이며_임계값_5초를_사용한다` | 12.2 / EC-04 / 12.3 (대체 불가 결정) |
| `test_122_localStorage를_설정_로그_타이머_별도_키로_분리_저장한다` | 12.2 / 7.2 |
| `test_NFR03_앱_로직이_단일_HTML_파일_내_인라인_script에_포함되어_있다` | NFR-03 |
| `test_NFR03_외부_모듈_로더나_import구문에_의존하지_않는다` | NFR-03 / 12.1 |
| `test_32_앱_내부에_데이터_삭제_전체초기화_기능이_없다 (§7.5)` | 3.2 Out of Scope / 7.5 (삭제 기능 미승인) |

## 3. 외부 서비스 연동 — 응답 계약 테스트 / 실호출 대체(미검증) 항목

PRD 기준 "외부 서비스"에 해당하는 것은 브라우저 제공 API(`localStorage`, `Notification`, Web Audio, Page Visibility)뿐이며(백엔드 서버 없음 — §1.3, §7.3), 전부 CI 클린 환경에서 거짓 실패를 유발하므로 **테스트 더블로 대체(실호출 테스트 설계 제외)** 하고 응답 계약만 검증한다.

| 대상 | 응답 계약 테스트 (작성함) | 실호출 대체 = 미검증 항목 |
|---|---|---|
| `localStorage` | 인메모리 backend 더블에 성공/`QuotaExceededError`/접근 예외/손상 JSON/직렬화 실패를 주입해 EC-05·FR-08 상태 전이·자동 재시도·경고 표시를 검증 (`storage.review.test.js`, `app-dom` EC-05, `acceptance` 13.1/13.3) | 실제 브라우저 `file://`·시크릿 모드에서의 localStorage 쿼터/정책 동작은 **미검증** (jsdom·인메모리 더블로 대체) |
| `Notification` API | `window.Notification` 을 `jest.fn`(permission `granted`/`denied`/미설정)으로 대체하여 FR-02·EC-01 의 동시 발송/폴백을 검증 | 실제 OS 데스크톱 알림 표시 여부는 **미검증** (JS 감지 불가 영역 — 3.2·FR-02 에서 명시적으로 제외) |
| Web Audio (`createBeeper`) | `beeper` 를 `play: () => Promise<boolean>` 더블로 대체(성공/`resolve(false)`/`reject`)하여 FR-02 소리 재생·실패 시 탭 제목 폴백을 검증 | 실제 `AudioContext` 합성음 재생·자동재생 잠금 해제는 **미검증** (jsdom 에 Web Audio 없음 → 테스트 더블로 대체) |
| Page Visibility | `document.visibilityState` 를 재정의하고 `visibilitychange` 이벤트를 디스패치하여 EC-02 탭 복귀 재계산을 검증 | 실제 브라우저 백그라운드 스로틀링 타이밍은 **미검증** (이벤트 디스패치로 대체) |

## 4. 미작성(Not Written) 항목과 사유

skip / xfail / todo 는 사용하지 않았다. 아래는 설계했으나 이번 회차에 **작성하지 않은** 항목이다.

| 설계 항목 | 사유 |
|---|---|
| 지원 브라우저(Chrome/Edge/Firefox 최신)에서의 `file://` 실제 실행 및 크로스 브라우저 이식성 (NFR-03, 3.2 "Safari 등 미지원") | 실제 브라우저 구동은 CI 클린 환경 밖의 수동 검증 영역이며, 실호출/실브라우저 테스트는 설계에서 제외(§CI 계약 4-나). 대체로 배포물 정적 검사(`constraints.review.test.js`)와 jsdom 부팅으로 이식성 근거를 확인한다. |
| §10 NFR 중 검증 기준이 정량 수치로 기재되지 않은 항목의 추가 부하/장시간 실측 | NFR-01(드리프트 0)은 `test_NFR01_*` 및 `test_AC13_3_수_시간_*` 에서 실측으로 커버함. NFR-02/NFR-03 은 정적 검사로 커버. 그 외 별도 정량 기준이 PRD 에 없어 추가 측정 테스트를 작성하지 않음. |
| §8 / §10 에 "없음"으로 기재된 요구사항 | 설계 지시 7번에 따라 테스트를 설계하지 않으며 결함으로도 보고하지 않음. (해당 문서에는 "없음" 표기 항목이 없어 실제 제외된 케이스는 없음.) |
| §9 (문서에 조항 없음), §11 (문서에 조항 없음) | PRD v4 에 해당 번호 절이 존재하지 않아 도출 대상 없음. |

## 5. 산출물 자체 검증 결과 (통과 판정 아님)

- 명령: `make test-review` 1회 실행함.
- `reports/review.xml` 생성 확인함 (JUnit XML).
- XML 내 인식된 테스트 케이스: **122건** (7개 스위트 파일). 케이스 이름에 `test_<근거ID>_...` 함수명이 그대로 기록됨을 확인함.
- 케이스 0건 여부: 아님. Makefile `test-review` 타겟의 도구(jest) 문법과 테스트 코드가 일치함.
- 통과·실패 판정은 수행하지 않음. (참고: 실행 시 `reports/review.xml` 에 실패 케이스가 포함될 수 있으며, 그 해석·판정은 오케스트레이터의 몫이다.)
