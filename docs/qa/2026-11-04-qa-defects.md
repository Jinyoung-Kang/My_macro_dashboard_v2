# 2026-11-04 결함 기록 — 출시 검증 4차 (QA-250~299)

> - 계획 [2026-11-04-qa-plan.md](2026-11-04-qa-plan.md) · 진행 [PROGRESS.md](PROGRESS.md) · 증거 `evidence/2026-11-04-qa/`.
> - 기준: `main@bc22e799`(운영본과 같은 코드), 브랜치 `claude/qa-2026-11`. 환경은 QA 스택(`my_macrodash_v2_qa`, 13002/18082/18002/15434, 외부 호출 차단)과
>   테스트 DB(`macrodash_qa_*_test`)뿐 — 운영 DB·운영 서버·실제 외부 API는 쓰지 않았습니다.
> - 결함마다 재현 시험(`test(QA-###)`, 수정 전 xfail·@Disabled·it.fails) → 수정(`fix(QA-###)`) 두 커밋. 번호는 다른 세션들과 나눴습니다
>   ('프레임 v' QA-207~214, 'v2 작업 1' QA-215~249).

## 요약

| 번호 | 심각도 | 영역 | 제목 | 상태 |
|---|---|---|---|---|
| QA-250 | S3 | 운영 도구 | 스크립트의 `mktemp -t 이름`이 Linux(GNU)에서 실패 — QA 도우미·Lighthouse·의존성 공시·API 측정이 시작하자마자 멈춤 | 수정됨 |

## QA-250 스크립트의 `mktemp -t 이름`이 Linux(GNU mktemp)에서 실패

- **심각도: S3** — 문서(CLAUDE.md·QA 계획)대로 QA·성능 점검 도구를 실행할 수 없음(우회는 손으로 curl). 제품 동작에는 영향 없음.
- **영역**: 운영·QA 도구(`scripts/`)
- **환경**: `bc22e799`, 작업 PC WSL2 Linux(GNU coreutils mktemp). CI(ubuntu)·Vultr 서버(Ubuntu)도 같은 mktemp.
- **재현 절차**: `bash scripts/qa/qa-stack.sh api /api/auth/session`
- **기대 결과**: QA 운영자로 로그인해 세션 JSON을 돌려줌. **실제 결과**: `mktemp: too few X's in template 'qacookie'`로 끝남(출력 없음).
- **증거**: 재현 시험 `collector/tests/test_script_portability.py` — 수정 전 실패:
  `Left contains 4 more items, first extra item: "scripts/bench-api.sh: mktemp -t bench-cookie — mktemp: too few X's in template 'bench-cookie'"`.
  수정 뒤 같은 명령이 `authenticated: true, role: OWNER`.
- **원인 위치**: `scripts/qa/qa-stack.sh:116`(api), `scripts/qa/lighthouse.sh:9`, `scripts/qa/dep-advisories.sh:8`, `scripts/bench-api.sh:31` — `mktemp -t 이름`은 BSD(맥) 문법이고
  GNU는 템플릿에 X가 셋 이상 있어야 함. 스크립트가 맥에서 만들어진 뒤 작업 PC가 WSL2로 바뀜.
- **영향 범위**: 저장소의 `$(mktemp …)` 전부를 찾음 — 위 네 곳만 해당(`setup.sh`·`vultr/api-common.sh`의 인자 없는 `mktemp`, `bootstrap.sh`의 `mktemp -d`는 정상).
- **상태: 수정됨** — 재현 `57dde571`, 수정 `49a7d62b`(경로 + `XXXXXX` 템플릿 `mktemp "${TMPDIR:-/tmp}/이름.XXXXXX"` — GNU·BSD 모두 같은 뜻).
- **재발 방지**: `test_script_portability.py`가 scripts·Makefile의 모든 `$(mktemp …)`를 그 OS(CI는 Linux)에서 실제로 실행해 봄.
