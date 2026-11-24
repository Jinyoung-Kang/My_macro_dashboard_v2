# 프로젝트 사실 파일 — My_macro_dashboard_v2 6차 개선 (계획 2026-11-25)

실행 세션에게: 이 파일은 [규칙 파일](2026-11-25-exec-rules.md)의 일반적인 표현이 이 프로젝트에서 무엇인지 알려 줘. 규칙 파일을 먼저 읽고 이 파일을 읽어.
무엇을 왜 어떻게 고치는지는 [계획서](2026-11-25-plan.md)에 있어 — 여기서는 반복하지 않고 절과 항목 번호로 가리켜.
규칙 파일 사본은 원본(`/home/jykang/Projects/prompts/improve/exec-rules.txt`)을 `cp`로 복사했고 `cmp`로 같음을 확인했어.

## 1. 프로젝트

- 위치: `/home/jykang/Projects/My_macro_dashboard_v2`. 명령은 이 폴더 최상위에서 `make`로 쳐.
- 종류: 웹 서비스(개인용 — 운영자 1명, 공개 포트 0). 화면(Next.js 16.4.5·React 19.3.1·TypeScript 6.0.3, `frontend/`) → API(Spring Boot 4.1.2·Java 21 대상, `backend/`) → PostgreSQL 16 ← 수집기(FastAPI 0.143.5·Python 3.11, `collector/`). 브라우저 컨테이너(`collector/sidecar/` — 차단 통과 수집의 계층 2)가 운영 서버에만 더 있어.
- 기능: 매크로·13F 대시보드, 모의 알고리즘 매매(Claude가 결정 — 미국·한국), 토스 실제 계좌 조회와 실제 매매, ISA 수동 계좌, 정보 수집·정보 검색·번역·AI 요약, 보안 공지 대조.
- 구조 요약: `backend/src/main/java/com/macrodash/`(`feature/<기능>` 컨트롤러·서비스, `analytics` 순수 계산, `store` DB 접근, `collector` 수집기 호출, `read` 응답 캐시), `collector/app/`(`tasks` 정기 태스크, `services` 출처별 수집, `fetch` 차단 통과 계층, `store.py` DB), `frontend/src/`(`app/(dashboard)` 경로, `components/screens` 화면, `hooks`, `lib` 순수 변환), `db/migrations/V*__*.sql`(스키마 — 수집기가 기동 때 적용), `scripts/`(배포·백업·QA 도구).
- 운영본은 Vultr 서버 한 대(Tailscale로만 접속). 모의 매매 정기 작업·실제 매매·차단 통과 수집은 서버에서만 돌아. 이 폴더는 개발용이야.
- 실행 환경: WSL2 Linux(커널 6.18), bash, Docker 29.9.3·Compose v5.7.0, 네트워크 접근 가능(공식 패키지 저장소 조회에만 써).
- 계획 세션이 확인한 도구 버전: OpenJDK 25.0.5.1(이 PC의 JDK는 25 하나 — CI는 Temurin 21), Maven 3.9.12, Node v24.22.3·npm 11.19.1, `collector/.venv`의 Python 3.11.17, ruff 0.8.6, gh 2.103.0. `psql`·`pg_dump`는 없어.
- 셸 주의: 이 환경의 `grep`·`find`는 ugrep·bfs라 `.gitignore` 대상(`.venv`·`.next`·`node_modules`·`.git`)을 건너뛰어. 파일 시스템 전체를 훑을 때만 `/usr/bin/grep`.

## 2. 버전 관리

- 도구 git. 원격 `origin` = `https://github.com/Jinyoung-Kang/My_macro_dashboard_v2.git`.
- 공개 여부: **공개(PUBLIC)** — 계획 세션이 `gh repo view --json visibility`로 확인. 그래서 고쳐지지 않은 보안 항목의 상세는 커밋하지 않아(규칙 파일 2장 '보안 발견을 적는 곳', 아래 §3 '문서 위치').
- 대상 브랜치 `main`(기본 브랜치이기도 해). 계획 기준 커밋 `a1af4ebdbdf7c299a099f5e1f10ebd5a46a34a81`(`main`, `origin/main`과 같음, CI 6/6 성공).
- 상태 확인 명령: `git status --short`와 `git rev-parse HEAD`.
- 계획 세션이 끝났을 때 `git status --short`에 보여야 하는 것: 추적되지 않는 `.playwright-mcp/`·`b.txt`·`t.txt`(다른 세션이 남긴 사용자 파일 — 건드리지 마, 커밋하지 마), 새 파일 `docs/improve/2026-11-25-plan.md`·`2026-11-25-exec-rules.md`·`2026-11-25-exec-context.md`·`2026-11-25-exec-prompt.md`, 수정된 `docs/improve/PROGRESS.md`. 이 밖에 추적되는 파일의 변경이 있으면 규칙대로 멈추고 물어봐.
- 커밋할 때 `git add -A`·`git add .`을 쓰지 마. 파일을 이름으로 더해(위 사용자 파일이 딸려 들어가지 않게).
- `.claude/worktrees/` 아래에 다른 세션의 worktree 41개가 남아 있어(무시 대상이라 상태에는 안 보여). 건드리지 마. 그 안에서는 `git checkout main`이 실패해 — 작업은 본체 폴더나 네가 새로 만든 worktree에서 해.
- 코드 받기는 `git pull` 대신 `git fetch` 뒤 fast-forward(`make update`).

## 3. 대응표 — 규칙 파일의 표현 → 이 프로젝트의 값

### 검증 수단(전체)
`make test`(= `make test-collector` + `make test-backend` + `make test-frontend`, CI와 같은 명령). 기준선(`a1af4ebd`, 2026-11-25 계획 세션 실행):

| 묶음 | 명령 | 기준선 | 시간 |
|---|---|---|---|
| 화면 | `make test-frontend`(`npm run check` + vitest + eslint + `next build` + `node --test scripts/qa/ui-audit.test.js`) | vitest 515파일 5,086 통과 · lint·build 통과 · node:test 9 통과 | 138초 |
| 백엔드 | `make test-backend`(`mvn -B verify`, JDK 25) | 4,077 통과, 실패 0, 건너뜀 0 | 385초 |
| 수집기 | `make test-collector`(ruff + pytest) | ruff 통과 · 3,634 통과 · 36 건너뜀 · 경고 1 | 1,292초(같은 시간에 다른 작업이 돌던 값 — 조용하면 더 짧을 수 있어) |

- 전체 약 30분. 수집기 시간이 기준선과 달라도 통과 수가 같으면 정상으로 봐.
- 백엔드(CI 판): JDK 21 컨테이너 — 저장소 전체를 임시 폴더에 풀고(`git archive HEAD | tar -x -C <임시>`) `docker run --rm --network host -u 1000:1000 -e HOME=/tmp -e TEST_DATABASE_URL=jdbc:postgresql://localhost:5434/macrodash_test -v <임시>:/w -v $HOME/.m2:/m2 -w /w/backend maven:3.9-eclipse-temurin-21 mvn -B -Dmaven.repo.local=/m2/repository verify`. 계획 세션은 이것을 돌리지 않았어(같은 커밋의 GitHub CI가 Temurin 21로 통과). 백엔드 코드를 바꾼 묶음의 끝과 최종 보고 전에 돌려. 코드는 JDK 21·25 둘 다에서 컴파일되게 써.
- 시험은 이 프로젝트의 postgres 컨테이너(127.0.0.1:5434)가 떠 있어야 해. 떠 있지 않으면 `make infra`(postgres만 띄움). `make test-*`가 `macrodash_test`를 만들고 스키마를 적용해.
- CI: push 뒤 `gh run list --branch <브랜치>` — job 6개(수집기, 백엔드, 프런트엔드, 데이터셋 이름 대조, 도커 이미지 빌드, 비밀값 검사 gitleaks). "job was not acquired by Runner"로 취소되면 그 job만 다시 돌리고 코드 실패와 구분해 적어.
- 없는 것: 커버리지 도구, Java 정적 분석 도구, 저장소에 든 실제 브라우저 시험. 새 검증 도구를 들이지 마.

### 커밋마다 돌릴 검증
프롬프트의 **D-6** 답을 따라.
- 답이 없거나 (나)이면: 전체와 같아(`make test`) — 프로젝트 규칙 "모든 커밋이 `make test`를 통과한다" 그대로.
- (가)이면: 그 커밋이 바꾼 스택의 전체 묶음 — `backend/` → `make test-backend`, `collector/` → `make test-collector`(`collector/app/catalog.py`를 바꿨으면 백엔드의 `DatasetsParityTest`도), `frontend/` → `make test-frontend`, `db/migrations`·`scripts/`·`docs/`·최상위 파일 → 셋 다(문서만 바꾼 커밋은 `make test-frontend`와 `make test-backend` — 문서 대조 시험이 그 둘에 있어). 전체는 계획서 §5 표의 묶음 끝, 독립 검토 전, 최종 보고 전.

### 기준선에서 이미 실패하는 항목·불안정한 시험·실행하지 못한 것
- 이미 실패하는 항목: 없음.
- 불안정하다고 알려진 시험(기준선에서는 통과): `collector/tests/test_fetch_ladder.py::test_같은_호스트의_요청_사이에는_불규칙한_틈을_둔다`(무작위 간격 두 값이 같은 자리로 반올림되면 실패 — 실행당 대략 천 번에 한 번, `docs/qa/2026-11-12-defects.md` 끝 절). 화면의 소스 전체를 읽는 검사 시험(`fontFloor`·`themeTokens`)은 바쁜 기계에서 시간 한도를 넘긴 적이 있어(한도를 넓혀 둠). 이 둘만 실패하면 그 시험만 다시 돌려 확인하고 진행해.
- 건너뛰는 36개: 이 PC에 `psql`·`pg_dump`가 없어서(`collector/tests/test_db_scripts.py` 전부, `test_vultr_scripts.py`의 상태 질의 시험). CI에서는 돌아. 백업·복원·`deploy.sh`의 상태 질의를 고치는 항목은 push 뒤 CI 결과로 확인해.
- 실행하지 못한 검증 수단: JDK 21 컨테이너 판(위 — 돌리지 않았을 뿐 돌릴 수 있어).

### 실제 외부를 부르는 시험
없어. 수집기 시험은 `collector/tests/conftest.py`가 네트워크 자리와 운영 DB 기본값을 막고, 백엔드 DB 시험은 DB 이름이 `_test`로 끝나지 않으면 거부해. 제외할 것 없이 `make test` 그대로 돌려.

### 작업 브랜치·커밋
- 작업 브랜치 이름: `claude/improve-r6-2026-11`(프로젝트 규칙 `claude/<주제>-YYYY-MM`. `claude/improve-2026-11`·`claude/improve-r5*-2026-11`은 지난 회차가 썼어). `main`에서 만들어.
- 커밋 메시지: `type(scope): 요약`, 요약은 한국어, 끝에 `Co-Authored-By` 줄(네 세션의 지침이 주는 줄을 써). 이모지 금지.
- 버그 수정의 커밋 단위: **두 커밋** — 재현 시험 `test(QA-###): …`(수정 전 코드에서 실패를 확인한 뒤 `@Disabled`·strict xfail·`it.fails`로 표시해 그 커밋도 검증을 통과하게) → 근본 원인 수정 `fix(QA-###): …`(표시 해제). 수정 전 실패 출력은 수정 커밋 본문이나 결함 기록에 남겨. 옮기는 커밋과 고치는 커밋을 나눠.
- 첫 커밋: 계획 문서(계획서, 진행 기록, 규칙 파일 사본, 이 파일, 실행 프롬프트 파일) — `docs(improve): …`. 보안 상세 파일은 넣지 마(무시 대상이라 `git add`로도 안 들어가지만 이름으로 더하지도 마).

### 항목 번호
- 형식 `QA-###`(이 프로젝트는 개선 회차도 QA 번호를 이어 써 — 프로젝트 규칙). 계획이 QA-998~1033을 썼어. **새 번호는 QA-1034부터.** 쓰기 전에 `git log --oneline -200 | grep -o 'QA-[0-9]*' | sort -t- -k2 -n | tail -3`과 `docs/qa/`에서 다른 세션이 그 번호를 쓰지 않았는지 봐.
- 의존성 묶음은 DEP-1~3, 결정은 D-1~7, 사용자가 할 일은 U-1~7.
- 다음 스키마 파일 번호 V45(QA-1012가 씀), 다음 ADR 번호 0050(이번 범위는 기존 ADR에 덧붙이는 것으로 충분하다고 계획서가 봤어 — 계획서 §5 끝).

### 문서 위치
- 계획서 `docs/improve/2026-11-25-plan.md`, 진행 기록 `docs/improve/PROGRESS.md`(맨 위 '6차 리뷰' 절), 최종 보고서 `docs/improve/2026-11-25-report.md`(같은 이름이 있으면 `-2`), 결함 기록 `docs/qa/2026-11-25-defects.md`(형식은 `docs/qa/2026-11-12-defects.md`의 표 — 번호·심각도·내용·재현 커밋·수정 커밋), 설계 결정 `docs/adr/`.
- 개선 문서 폴더는 버전 관리 제외 대상이 **아니야**(`git check-ignore`로 확인 — 커밋해).
- 보안 상세 파일: `/home/jykang/Projects/My_macro_dashboard_v2/docs/improve/private/2026-11-25-security.md`. 버전 관리에서 뺀 방법: 로컬 전용 제외 설정 `.git/info/exclude`에 `/docs/improve/private/` 한 줄(계획 세션이 추가, `git status`에 나타나지 않음을 확인). 다른 worktree나 클론에서 일하면 이 파일은 거기에 없어 — 복사하지 말고 이 절대 경로에서 읽고 써.

### 원격 push와 대상 브랜치 병합
프로젝트 규칙(CLAUDE.md '전달 방식')에 절차가 있어: 작업 브랜치를 push해 CI를 확인 → 본체 폴더의 `main`에 **fast-forward** 병합 → `origin/main`에 push → CI 6개 job 확인 → 커밋 번호와 함께 보고. 강제 푸시·이력 재작성은 하지 마. 다른 세션이 그사이 `main`에 커밋을 올렸으면 받아서 합쳐(아직 push하지 않은 브랜치는 rebase, 이미 push한 브랜치는 병합 커밋 — 저장소 선례) 뒤 `make test`를 다시 돌려.
어디까지 할지는 프롬프트의 **D-1** 답을 따라(답이 없으면 `main` 병합·push·CI까지, 배포 안 함).

## 4. 따르는 프로젝트 규칙

원문: `/home/jykang/Projects/My_macro_dashboard_v2/CLAUDE.md`(먼저 읽어), `docs/DEVELOPMENT.md`, `docs/PRINCIPLES.md`, `docs/adr/README.md`. 실행 세션이 지켜야 할 것의 요약:

- 이모지를 쓰지 마(화면·코드·주석·문서·스크립트 출력·커밋 메시지). `frontend/src/lib/__tests__/noEmoji.test.ts`가 막아.
- 없는 숫자를 만들지 마(표본 부족·수집 실패는 `null` → 화면 `—`). 날짜는 `Kst.today()`(Java)·KST 기준, `LocalDate.now()` 금지.
- 새 API 경로는 `AccessPolicy` 표에, 데이터셋 이름은 `collector/app/catalog.py`와 `backend/.../store/Datasets.java` 둘 다. 테이블마다 쓰는 프로세스는 하나(수집기 테이블은 백엔드가 읽기만 — QA-1012의 `search_watch_items`는 수집기가 쓰는 표야). 백엔드 DB 접근은 `store`에서만. 스키마 파일은 `db/migrations/` 한 곳.
- 실행 방법·환경변수·API·폴더 구조가 바뀌면 `README.md`와 `docs/API.md`를 같이 고쳐(`RouteInventoryTest`·`endpoints.test.ts`가 `docs/API.md`와 대조).
- **끈 판의 프롬프트·스키마·패킷 고정본**(`backend/src/test/resources/paper/golden/`, 71파일)은 바이트까지 그대로여야 해. 고정본 파일이 바뀌어야 통과하는 수정이 나오면 멈추고 물어봐. Claude 결정 프롬프트·패킷의 글자는 실험 조건이야(ADR 0018) — QA-1017(D-2)이 승인됐을 때 그 항목이 적은 범위만 바뀌어.
- **실제 계좌(토스·ISA) 자료를 문서·로그·시험 자료·커밋·텔레그램 글에 넣지 마.** 실제 매매 켜기류 API(enable·update·resume)를 부르지 마. 주문을 내는 새 경로를 만들지 마. 스위치류(자유 시점·이어받기·고정 일정·장중 스탑 체결)의 켜는 설정을 저장하지 마.
- 차단 통과 수집(정보 수집·정보 검색의 외부 출처)은 서버에서만 돌아. 이 PC에서 `POLITE_FETCH_ENABLED`를 켜거나 실제 출처에 요청을 보내지 마. 차단 우회 수단을 더하지 마.
- v1·v3 저장소(`My_macro_dashboard_v1`·`Local_macro_dashboard_v3`)와 그 폴더·볼륨·스택에는 아무것도 하지 마.
- 외부 패키지를 올릴 때는 Maven Central·npm·PyPI에서 실제 정식(GA) 판을 확인해(마일스톤·RC는 올리지 않음). `collector/constraints.txt`의 머리글은 "손으로 고치지 않습니다"(`make constraints`가 docker로 다시 만듦 — 그날의 간접 의존성이 전부 움직여)인데, 한 패키지만 올릴 때는 지난 회차들처럼 그 줄만 고친 선례가 있어. 계획서의 의존성 항목은 그 줄만 고치는 쪽을 전제로 썼어 — 그렇게 했으면 커밋 메시지에 적어.

### 규칙 파일과 충돌하는 지점
| 지점 | 따르는 쪽 | 근거 |
|---|---|---|
| 작업 브랜치 이름(규칙 파일 기본값 `improve/YYYYMMDD`) | 프로젝트 규칙 `claude/improve-r6-2026-11` | CLAUDE.md '전달 방식' |
| 버그 수정의 커밋 단위(규칙 파일 기본값 한 커밋) | 프로젝트 규칙 두 커밋(`test` → `fix`) | CLAUDE.md '절대 규칙' 마지막 항목 |
| 항목 번호(규칙 파일 기본값 `IMP-###`) | 프로젝트 규칙 `QA-###` | CLAUDE.md, `docs/qa/` |
| 원격 push·`main` 병합(규칙 파일: 절차가 있을 때만) | 프로젝트 절차대로, D-1의 범위까지 | CLAUDE.md '전달 방식' |
| **배포**(프로젝트 규칙: "작업이 끝날 때마다 서버에 `deploy.sh`") | **규칙 파일** — 배포하지 않아. 규칙 파일 2장 '안전 규칙'이 실제 외부 리소스의 변경·배포를 막아. D-1에서 사용자가 (나)로 명시적으로 승인한 경우에만 그 범위에서 해 | 규칙 파일 2장 '규칙의 우선순위' |
| 커밋마다 돌릴 검증 | D-6의 답(없으면 전체) | CLAUDE.md "모든 커밋이 `make test`를 통과한다", 계획서 §9 D-6 |

## 5. 이 프로젝트에서 규칙에 덧붙는 사실

### 안전 규칙
- 운영 DB 이름은 `macrodash`, 테스트 DB는 `macrodash_test`만(병렬로 나누면 `macrodash_<이름>_test`). 로컬 postgres 컨테이너(5434) 안에 로컬 스택의 `macrodash`와 테스트 DB가 함께 있어 — `macrodash`에 쓰는 명령을 치지 마.
- 이 PC의 스택과 포트(전부 127.0.0.1): 이 저장소의 로컬 스택 3002/8082/8002/5434(compose 프로젝트 `my_macro_dashboard_v2` — 계획 세션 때 네 컨테이너가 떠 있었어), 이 저장소의 QA 스택 13002/18082/18002/15434·프록시 18890(`my_macrodash_v2_qa` — 떠 있었어), `Local_macro_dashboard_v3` 3000/8080/8000/5432, `My_macro_dashboard_v1` 3001/8081/8001/5433(둘은 꺼져 있었어). 이 저장소의 것만 다뤄. 떠 있는 로컬·QA 스택을 내리거나 다시 만들지 마(사용자가 쓰는 중일 수 있어).
- 로컬 스택 전체를 `make up`으로 새로 띄우지 마(수집기가 실제 외부 출처를 불러). 화면이나 API를 실제로 띄워 봐야 하면 QA 스택(`bash scripts/qa/qa-stack.sh …`, 외부 호출 차단 프록시)을 쓰되, 이미 떠 있는 QA 스택의 데이터를 바꾸는 일은 하지 마.
- 실제 외부 리소스는 조회만: Vultr 서버 접속·`scripts/vultr/deploy.sh`는 D-1이 (나)일 때만. AWS 자원은 건드리지 마. GitHub은 작업 브랜치·`main` push와 CI 조회만(이슈·설정 변경 없음).
- 부르면 안 되는 외부 서비스: 토스, Yahoo, 텔레그램, KRX, 네이버, 보호나라, 배포판 추적기, SEC EDGAR, 블로그·뉴스 피드, Claude·Gemini API. 시험은 기존의 목·고정본·합성 표본과 루프백 임시 서버만 써. 공식 패키지 저장소(npm·PyPI·Maven Central)의 조회는 돼.
- `.env`·`.env.qa`의 값을 출력하지 마. 이 폴더의 `.env`는 `PAPER_ENABLED=false` 고정이야 — 바꾸지 마.
- 임시 파일과 별도 worktree는 프로젝트 밖(세션 임시 폴더)에 둬. `/tmp`는 12 GB 메모리 파일 시스템이라 worktree를 여러 개 두면 가득 차(지난 회차에 실제로 찼어). 다 쓴 것은 지워.
- 병렬로 나눌 때의 선례(3~5차): 영역별 worktree + 브랜치 `r6/<영역>`(로컬 전용) + 테스트 DB `macrodash_<영역>_test`(`TEST_DATABASE_URL`로 넘김). `frontend/node_modules`를 심볼릭 링크로 두면 `next build`가 거부해 복사본이 필요해(약 2.7 GB). 끝나면 worktree·임시 브랜치·임시 DB를 지워.

### 계획서가 미리 적어 둔 동작 변화와 기존 시험 기대값 변경
- 밖에서 보이는 동작 변화: 계획서 §1 표의 '동작 변화' 칸이 '있음'인 항목 — 각 항목의 '밖에서 보이는 동작 변화' 줄이 범위야. 보안 항목(QA-998~1007)은 보안 상세 파일의 같은 줄.
- 응답·요청 계약이 바뀌는 것: QA-1011(`POST /api/search/watch/{id}/seen`의 선택 본문 `asOf`, 검색 결과 응답의 선택 칸 `watchAsOf` — 둘 다 더하기), QA-1014(`POST /api/sec13f/favorites`의 일부 성공이 409로), QA-1025(400 문구), 그리고 보안 상세 파일의 각 항목에 적힌 것.
- 스키마가 바뀌는 것: QA-1012의 V45(칸 하나 더하기 — 기존 칸의 값은 바꾸지 않음). 이 밖의 스키마 변경이 필요해지면 멈추고 물어봐.
- 데이터를 지우는 것: QA-1023(지난 날의 예산 계수기 행 — 계획서에 적힌 범위만).
- 기존 시험의 기대값·준비 자료 변경이 승인된 항목: QA-1008(공유 열쇠 글자), QA-1011(모은 글 출처의 캐시 단언), QA-1012(준비 자료에 `added_at` 넣기 — 기대는 그대로), QA-1014(수집기의 선행 CIK 까닭 값), QA-1015(가드 호출 수 2 → 3과 git 호출 차례), QA-1018(D-3 (가)일 때 첫 주기 기대), QA-1024(거부 뒤 범위), 그리고 보안 상세 파일의 각 항목 '기대값이 바뀌는 기존 시험' 줄에 적힌 것. 이 밖의 기존 시험 기대값을 바꿔야 통과하면 승인 대기로 넘겨.
- 계획서가 '먼저 재현하고, 재현되지 않으면 고치지 않는다'고 적은 항목: QA-1016, QA-1033.

### 그 밖에 알아야 하는 이 환경의 함정
- `docker kill`로 멈춘 컨테이너는 다시 뜨지 않아(수동 정지로 간주). Docker 재시작 뒤 postgres가 Exited(127)면 `docker compose up -d --force-recreate postgres`(볼륨 그대로).
- `collector/.venv`는 `requirements-dev.txt` + `constraints.txt`대로여야 해. 의존성 항목(QA-1005, DEP-3, D-4)을 고친 뒤에는 `collector/.venv/bin/pip install -r collector/requirements-dev.txt -c collector/constraints.txt`로 가상환경을 맞춘 다음 시험을 돌려(작업 환경만 바뀌는 일 — 진행 기록에 적어).
- 화면 의존성(DEP-1)을 올린 뒤에는 `cd frontend && npm ci`.
- 수집기 `/health`는 DB까지 확인해(없으면 503). `/health`를 공개 경로 예시로 쓰는 시험은 `store.ping`을 스텁해.
- `test_vultr_scripts.py`는 가짜 git·docker로 `deploy.sh`를 돌려. 실제 서버·실제 docker를 건드리지 않아.
- gitleaks(CI의 비밀값 검사)가 새 고정 자료의 긴 문자열을 비밀값으로 잘못 볼 수 있어(지난 회차에 한 번). 거짓 발견이면 `.gitleaksignore`에 지문을 더하고 그렇게 했다고 적어.
- 배포 시각(D-1이 (나)일 때만): 한국 거래 창(평일 08:45~15:35 KST), Claude 결정 시각, 장중 스탑 감시의 마감 직후 창(한국 15:21~15:35 KST, 미국 15:56~16:05 ET) 밖에서. 서버 접속은 Tailscale SSH(`ssh ubuntu@my-macro-app`) — 추가 인증에서 멈추면 우회하지 말고 사용자에게 알려. 실제 매매 상태는 읽기만 해.

## 6. 해당하지 않아 건너뛰는 규칙

없어. (화면·API·정기 작업·외부 AI 호출·배포 구성이 모두 있는 프로젝트라 규칙 파일의 항목이 전부 해당해.)

## 7. 사용자가 준 값

- 앞으로 예정된 변경: 없음.
- 동결 영역: 없음(프롬프트에 값이 오면 그 값이 우선).
- 실행 세션 환경: 이 세션과 같은 머신. 실행 모델: 계획 세션과 같은 수준(실행 재량 '표준').
- 보안 상세의 커밋: 값이 비어 기본값 — 저장소가 공개라 커밋하지 않음.
- 그 밖에 알린 것: 없음.
