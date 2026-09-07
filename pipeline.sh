#!/usr/bin/env bash
#
# pipeline.sh — 개발환경 파이프라인 오케스트레이터
#
# 이 스크립트는 판단하지 않는다.
# AI를 순서대로 실행하고, make 종료 코드만 보고 다음 단계를 정하고, 횟수를 센다.
# 실패 원인을 해석하지 않으며, 실패하면 개발AI를 다시 부를 뿐이다.
#
# 사용법
#   ./pipeline.sh              새 기획 사이클. docs/prd.md 를 커밋하고 시작한다.
#   ./pipeline.sh --resume     기획서 변경 없이 개발부터 다시 시작한다.
#   ./pipeline.sh --help       도움말
#
# 실행 환경 : Git Bash (윈도우)
# 사전 준비 : GNU Make, git, gh(GitHub CLI), 각 AI CLI 가 설치되어 PATH에 있을 것

# set -e 는 쓰지 않는다.
# 이 스크립트는 "실패하면 continue" 가 정상 동작이므로,
# 실패했다고 스크립트가 죽으면 안 된다. 종료 코드는 매번 직접 확인한다.
set -uo pipefail


# ══════════════════════════════════════════════════════════════
# 설정 — 프로젝트에 맞게 이 부분만 고치면 된다
# ══════════════════════════════════════════════════════════════

MAX_LOOP=3                              # 사용자에게 보고하기 전 최대 반복 횟수

PRD_FILE="docs/prd.md"                  # 기획AI가 작성한 PRD를 저장할 경로
PROMPT_DEV="prompts/dev.md"             # 개발AI 프롬프트 파일
PROMPT_REVIEW="prompts/review.md"       # 테스트AI 프롬프트 파일

# AI CLI 실행 명령.
# {PROMPT} 자리에 프롬프트 전문이 들어간다.
# 쓰는 CLI에 맞게 이 두 줄만 바꾸면 된다.
DEV_AI_CMD=(codex -p)
TEST_AI_CMD=(codex -p)

LOG_DIR=".pipeline"                     # 실행 로그를 남길 디렉토리
ACTIONS_TIMEOUT=1800                    # GitHub Actions 대기 제한 (초)


# ══════════════════════════════════════════════════════════════
# 보조 함수
# ══════════════════════════════════════════════════════════════

# 화면과 로그 파일에 동시에 기록한다.
log() {
    echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# 단계 구분선. 로그를 나중에 읽을 때 어디가 어디인지 보이게 한다.
step() {
    echo "" | tee -a "$LOG_FILE"
    echo "───── $* ─────" | tee -a "$LOG_FILE"
}

# 복구 불가능한 상황에서 즉시 종료한다.
die() {
    echo "" >&2
    echo "[중단] $*" >&2
    exit 1
}

# AI CLI를 실행한다.
# 프롬프트 파일 전문과 작업 대상 파일 경로 안내를 하나의 인자로 넘긴다.
# AI가 무엇을 했는지는 판정 근거로 쓰지 않는다. 종료 코드만 본다.
run_ai() {
    local label="$1"; shift
    local prompt_file="$1"; shift
    local -a cmd=("$@")

    [ -f "$prompt_file" ] || die "$label 프롬프트 파일이 없습니다: $prompt_file"
    [ -f "$PRD_FILE" ] || die "$label PRD 파일이 없습니다: $PRD_FILE"

    local prompt
    prompt="$(cat "$prompt_file")"$'\n\n반드시 현재 작업 디렉터리의 '"$PRD_FILE"' 파일을 읽고 작업을 시작하세요.'

    log "$label 실행"
    "${cmd[@]}" "$prompt" 2>&1 | tee -a "$LOG_FILE"

    # 파이프를 거쳤으므로 tee가 아니라 앞 명령의 종료 코드를 봐야 한다.
    # set -o pipefail 이 켜져 있어 PIPESTATUS[0] 이 그대로 반영된다.
    local rc=${PIPESTATUS[0]}
    if [ "$rc" -ne 0 ]; then
        log "$label CLI가 비정상 종료했습니다 (코드 $rc)"
    fi
    return "$rc"
}

# make 타겟을 실행하고 종료 코드를 그대로 돌려준다.
# 이 종료 코드가 파이프라인의 유일한 판정 근거다.
run_make() {
    local target="$1"
    log "make $target"
    make "$target" 2>&1 | tee -a "$LOG_FILE"
    return "${PIPESTATUS[0]}"
}

# 변경사항이 있을 때만 커밋한다.
# 커밋할 것이 없는데 git commit 을 부르면 실패하므로 미리 걸러낸다.
commit_if_changed() {
    local message="$1"

    git add -A
    if git diff --cached --quiet; then
        log "커밋할 변경사항이 없습니다: $message"
        return 1
    fi

    git commit -q -m "$message"
    log "커밋: $message"
    return 0
}

# push 후 GitHub Actions가 끝날 때까지 기다리고, 최종 판정을 종료 코드로 돌려준다.
# 0 = verdict true, 그 외 = verdict false 또는 대기 실패
wait_actions() {
    local branch
    branch=$(git rev-parse --abbrev-ref HEAD)

    # push 직후에는 아직 워크플로가 등록되지 않았을 수 있으므로 잠시 기다린다.
    log "GitHub Actions 실행 등록 대기"
    local run_id="" waited=0
    while [ -z "$run_id" ] && [ "$waited" -lt 60 ]; do
        sleep 5
        waited=$((waited + 5))
        run_id=$(gh run list --branch "$branch" --limit 1 \
                     --json databaseId --jq '.[0].databaseId' 2>/dev/null)
    done

    if [ -z "$run_id" ]; then
        log "Actions 실행을 찾지 못했습니다"
        return 1
    fi

    log "Actions 실행 감시 시작 (run $run_id)"

    # --exit-status : 워크플로가 실패하면 gh 도 0이 아닌 코드로 끝난다.
    #                 즉 verify.yml 의 verdict 가 그대로 여기로 전달된다.
    timeout "$ACTIONS_TIMEOUT" \
        gh run watch "$run_id" --exit-status 2>&1 | tee -a "$LOG_FILE"
    local rc=${PIPESTATUS[0]}

    # 실행 결과를 로컬에 내려받는다.
    # reports/*.xml 은 다음 회차 개발AI의 입력이 된다.
    log "Actions 아티팩트 내려받기"
    gh run download "$run_id" --dir "$LOG_DIR/artifacts-$RUN_STAMP" 2>&1 \
        | tee -a "$LOG_FILE" || log "아티팩트 없음 또는 내려받기 실패"

    return "$rc"
}


# ══════════════════════════════════════════════════════════════
# 인자 처리
# ══════════════════════════════════════════════════════════════

RESUME=0

case "${1:-}" in
    --resume) RESUME=1 ;;
    --help|-h)
        sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    "") ;;
    *) die "알 수 없는 옵션입니다: $1  (--help 참고)" ;;
esac


# ══════════════════════════════════════════════════════════════
# 준비
# ══════════════════════════════════════════════════════════════

# 프로젝트 루트에서 실행되었는지 확인한다.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "git 저장소가 아닙니다. 프로젝트 루트에서 실행하세요."

command -v make >/dev/null 2>&1 || die "make 가 없습니다. GNU Make를 설치하세요."
command -v gh   >/dev/null 2>&1 || die "gh(GitHub CLI)가 없습니다."

mkdir -p "$LOG_DIR"
RUN_STAMP=$(date '+%Y%m%d-%H%M%S')
LOG_FILE="$LOG_DIR/run-$RUN_STAMP.log"
: > "$LOG_FILE"

log "파이프라인 시작 (모드: $([ "$RESUME" -eq 1 ] && echo 재개 || echo 신규))"


# ══════════════════════════════════════════════════════════════
# ① PRD 확인 · ② PRD 커밋
# ══════════════════════════════════════════════════════════════

if [ "$RESUME" -eq 0 ]; then
    step "① PRD 확인"

    [ -f "$PRD_FILE" ] || die "$PRD_FILE 이 없습니다. 기획AI가 작성한 PRD를 저장하세요."

    step "② PRD 커밋"

    if ! commit_if_changed "PRD 반영"; then
        # PRD가 직전과 동일하다는 뜻이다.
        # 새 기획을 저장하는 것을 잊었을 가능성이 높으므로 여기서 멈춘다.
        die "$PRD_FILE 에 변경이 없습니다.
     새 PRD를 저장했는지 확인하세요.
     기획서 변경 없이 개발부터 다시 하려면:  ./pipeline.sh --resume"
    fi

    # 신규 사이클이므로 직전 사이클의 테스트 결과를 지운다.
    # 개발AI는 reports/*.xml 의 존재 여부로 신규 개발인지 수정인지를 판단하므로,
    # 남아 있으면 새 PRD인데도 '실패 수정' 모드로 들어간다.
    if [ -d reports ]; then
        log "직전 사이클의 reports/ 를 정리합니다"
        rm -f reports/*.xml
    fi
else
    step "① ② 건너뜀 (--resume)"
    log "기존 PRD와 reports/ 를 그대로 사용합니다"
fi


# ══════════════════════════════════════════════════════════════
# ③ ~ ⑫ 개발 · 검증 루프 (최대 3회)
# ══════════════════════════════════════════════════════════════

SUCCESS=0

for ((i = 1; i <= MAX_LOOP; i++)); do

    echo "" | tee -a "$LOG_FILE"
    echo "══════════ ${i}회차 / ${MAX_LOOP} ══════════" | tee -a "$LOG_FILE"

    # ── ③ 개발AI ───────────────────────────────────────────────
    # 입력은 PRD와, 존재한다면 reports/*.xml 이다.
    # 리포트 유무로 신규 개발인지 실패 수정인지가 갈리며,
    # 그 판단은 개발AI 프롬프트의 '호출 시 입력 확인' 조항이 담당한다.
    # 오케스트레이터는 모드를 알려주지 않는다.
    step "③ 개발AI"
    run_ai "개발AI" "$PROMPT_DEV" "${DEV_AI_CMD[@]}"
    if [ $? -ne 0 ]; then
        log "개발AI CLI 실패 → 다음 회차로"
        continue
    fi

    # ── ④ 기본 검증 ───────────────────────────────────────────
    # verify.yml 의 ci_fixed 가 하는 일과 같은 3개 타겟을 로컬에서 먼저 돌린다.
    # 여기서 걸리면 push 왕복 없이 바로 개발AI에게 돌아간다.
    step "④ make setup / build / lint"
    if ! run_make setup || ! run_make build || ! run_make lint; then
        log "기본 검증 실패 → 다음 회차로"
        continue
    fi

    # ── ⑤ 자체 테스트 실행 ─────────────────────────────────────
    # 개발AI가 작성만 하고 실행하지 않은 tests/dev/ 를 여기서 돌린다.
    # 판정 주체를 작성 주체와 분리하기 위한 것이다.
    step "⑤ make test-dev"
    if ! run_make test-dev; then
        log "자체 테스트 실패 → 다음 회차로"
        continue
    fi

    # ── ⑥ 개발AI 작업 커밋 ─────────────────────────────────────
    # 이 커밋이 ⑦ 테스트AI의 git diff HEAD~1 HEAD 기준점이 된다.
    # 커밋 직후에 테스트AI를 부르므로, 그 diff 가 곧 이번 회차 개발AI의 작업분이다.
    step "⑥ 개발AI 작업 커밋"
    commit_if_changed "개발AI 작업 (${i}회차)"

    # ── ⑦ 테스트AI ────────────────────────────────────────────
    step "⑦ 테스트AI"
    run_ai "테스트AI" "$PROMPT_REVIEW" "${TEST_AI_CMD[@]}"
    if [ $? -ne 0 ]; then
        log "테스트AI CLI 실패 → 다음 회차로"
        continue
    fi

    # ── ⑧ 독립 테스트 실행 ─────────────────────────────────────
    step "⑧ make test-review"
    if ! run_make test-review; then
        log "독립 테스트 실패 → 다음 회차로"
        continue
    fi

    # ── ⑨ 테스트AI 작업 커밋 ───────────────────────────────────
    # 커밋하지 않으면 tests/review/ 가 push되지 않아 Actions에서 누락된다.
    step "⑨ 테스트AI 작업 커밋"
    commit_if_changed "테스트AI 작업 (${i}회차)"

    # ── ⑩ push ────────────────────────────────────────────────
    step "⑩ git push"
    if ! git push 2>&1 | tee -a "$LOG_FILE"; then
        log "push 실패 → 다음 회차로"
        continue
    fi

    # ── ⑪ GitHub Actions 대기 ─────────────────────────────────
    # 클린 환경 재현성, 준비물 검사, 부정행위 감시(XML·건수·skip),
    # 시크릿 유출 검사는 여기서만 수행된다.
    step "⑪ GitHub Actions 대기"
    if ! wait_actions; then
        log "verdict = false → 다음 회차로"
        continue
    fi

    # ── ⑫ 성공 ────────────────────────────────────────────────
    SUCCESS=1
    break
done


# ══════════════════════════════════════════════════════════════
# 종료 안내
# ══════════════════════════════════════════════════════════════

echo "" | tee -a "$LOG_FILE"
echo "════════════════════════════════════════" | tee -a "$LOG_FILE"

if [ "$SUCCESS" -eq 1 ]; then
    log "완료 — GitHub Actions 통과 (${i}회차)"
    echo ""
    echo "다음 단계:"
    echo "  1. 아래 자료를 챗의 기획AI에 입력하고 [유형 E] 판독을 받으세요."
    echo "       · GitHub Actions 실행 로그"
    echo "       · reports/dev.xml, reports/review.xml"
    echo "       · docs/test-report-review.md"
    echo "       · 최신 커밋 코드"
    echo "  2. 판독 보고서의 '직접 확인 권장 항목'을 보고 직접 앱을 사용해 보세요."
    echo "  3. 사용 소감을 챗에 입력하면 다음 사이클의 PRD 작성으로 이어집니다."
    echo ""
    echo "  실행 로그: $LOG_FILE"
    exit 0
else
    log "${MAX_LOOP}회 모두 실패했습니다."
    echo ""
    echo "확인할 것:"
    echo "  · reports/dev.xml, reports/review.xml 의 실패 케이스"
    echo "  · 실행 로그: $LOG_FILE"
    echo "  · 회차별 이력: git log --oneline"
    echo ""
    echo "같은 PRD로 다시 시도하려면:  ./pipeline.sh --resume"
    exit 1
fi
