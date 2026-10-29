# CLAUDE.md — 작업 규칙 요약

로컬 매크로·13F 대시보드와 🧪 모의 알고리즘 매매(운영자 전용, ADR 0018). 화면(Next.js, `frontend/`) → API(Spring Boot, `backend/`) →
PostgreSQL ← 수집기(FastAPI, `collector/`). Docker Compose 네 컨테이너로 돌며, 폴더 이름
`My_macro_dashboard_v2`가 compose 프로젝트·DB 볼륨 이름을 정한다(바꾸지 말 것).
**v2다**: 2026-10-26에 `My_macro_dashboard_v1`을 전체 이력으로 갈라낸 저장소다(갈라낸 절차는 [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) §0,
결정은 [ADR 0020](docs/adr/0020-v2-program.md)). 화면 전면 개편과 한국 증시 모의 매매를 여기서 한다.
**2026-10-29 23:17 KST부터 AWS 운영본은 이 저장소(v2)다**(서버 `~/My_macro_dashboard_v2`, 4단계 교체를 사용자 결정으로 앞당김 — 남은 작업은 끝날 때마다
서버에 `bash ~/My_macro_dashboard_v2/scripts/aws/deploy.sh`). 서버의 v1 폴더·볼륨은 되돌리기용, v1은 로컬 3001 스택으로 계속 돈다. v1·v3 폴더·볼륨·스택·원격 저장소를 건드리지 않는다
(v1의 긴급 수정은 v1 세션이 하고, 필요하면 여기로 손으로 옮긴다).

## 먼저 읽을 문서
- 전체 구조·데이터 흐름: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 개발·테스트·규약: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- 숫자·화면 원칙: [docs/PRINCIPLES.md](docs/PRINCIPLES.md)
- 설계 결정과 지키는 방법: [docs/adr/README.md](docs/adr/README.md)
- API 경로(`RouteInventoryTest`·`endpoints.test.ts`가 이 문서와 대조): [docs/API.md](docs/API.md)
- 수집 태스크 37개와 소스별 한계: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)
- 지난 리뷰·QA의 결함 목록과 남은 위험: [docs/reviews/](docs/reviews/) · [docs/qa/](docs/qa/) (결함 번호 `QA-###`)
- **v2 프로그램**(순서·사용자 결정 V1~V8·AWS 교체 절차): [docs/specs/2026-10-26-v2-program-plan.md](docs/specs/2026-10-26-v2-program-plan.md) ·
  [0단계 체크리스트](docs/specs/2026-10-26-v2-step0-fork.md) · [UI/UX 설계](docs/specs/2026-10-26-v2-ui-design.md)(1단계 — 토큰·셸 시안 승인 뒤 홈 → 모의매매(미국)) ·
  [한국 증시 책 명세 초안](docs/specs/2026-10-26-v2-kr-paper-spec.md)(2단계) · [외부 OSS 채택 목록](docs/specs/2026-10-26-v2-oss-adoption.md) · [ADR 0020](docs/adr/0020-v2-program.md)

## 명령 (전부 `make`, 저장소 최상위에서)
- 기동·진단: `make up` · `make doctor` · `make status` · `make logs S=backend`
- 테스트: `make test` (= `test-collector` + `test-backend` + `test-frontend`). CI와 같은 명령.
- 백업·복원: `make backup` · `make restore F=backups/….sql` (ADR 0003)
- 코드 받기는 `make update`. `git pull`은 쓰지 않는다(다른 브랜치의 작업을 조용히 놓침).
- AWS 개인용 서버(ADR 0019, [docs/DEVELOPMENT.md §7](docs/DEVELOPMENT.md)) — **교체(4단계, 계획서 §5) 전까지 서버는 v1을 돌린다. v2를 서버에 올리지 않는다.**
  아래는 교체 뒤 기준이다. 화면은 PC에서 `bash scripts/aws/tunnel.sh` → http://localhost:8201,
  셸은 SSM(`aws ssm start-session` 뒤 `sudo -iu ubuntu`). **서버에서는 `make up` 대신 `bash scripts/aws/deploy.sh`**(4 GiB — 이미지를 하나씩 빌드).
  서버는 매일 KST 21:55~08:00(토 ~10:00)만 켜진다(EventBridge Scheduler) — 창 밖에 보려면 `bash scripts/aws/instance.sh start`(다음 정지 일정에 꺼짐), 상태는 `instance.sh status`.
  계정 고유 값(인스턴스 ID·버킷 이름)은 공개 저장소에 적지 않고 로컬 `.env`·메모리에만 둔다.
  공개 주소는 CloudFront 하나(ADR 0019 결정 16): 보안 그룹 인바운드는 CloudFront 원본용 prefix list → :8301 한 줄뿐이고, caddy가 비밀 헤더를 확인한 뒤
  잠금화면(gate, `deploy/aws/gate`)을 거친 요청만 앱으로 보낸다. 그 밖의 인바운드 규칙·공인 IP 앱 포트·Tailscale은 두지 않는다. v3의 데모 스택(portfolio-*)은 건드리지 않는다.
- QA·실험용 별도 스택: `bash scripts/qa/qa-stack.sh up|restore F=…|down` (compose 프로젝트 `my_macrodash_v2_qa`,
  포트 13002/18082/18002/15434·프록시 18890 — v3 QA(`macrodash_qa`, 13000…)·v1 QA(`my_macrodash_qa`, 13001…)와 겹치지 않음, 새 비밀값 `.env.qa`, 외부 호출은 차단 프록시). 성능 측정: `ENV_FILE=.env.qa bash scripts/bench-api.sh`(QA 스택), `scripts/qa/k6/`.

## 절대 규칙
- **운영 DB(`macrodash`)로 테스트하지 않는다.** 테스트는 `macrodash_test`만 쓴다
  (`make test-*`가 맞춰 줌). 백엔드 통합 테스트는 시작할 때 `snapshots`를 비운다.
  부하·장애·브라우저 시험도 로컬 스택(3002/8082/8002/5434)이 아니라 QA 스택에서 한다.
- **비밀값은 `.env`에만.** 이 저장소는 GitHub 공개 저장소다(2026-10-26 사용자 확인 — 모의매매 프롬프트·투자 OS 원문도 공개). 비밀값은 `.env`에만 —
  키·토큰·비밀번호를 코드·문서·로그·커밋에 넣지 않는다. 예시 이메일 같은 자리표시 값도 코드 기본값으로 두지 않는다.
- **없는 숫자를 만들지 않는다.** 표본 부족·수집 실패는 `null`→화면 `—`. 0으로 채우지 않는다.
  추정치는 `isEstimated`/`isProxy`를 함께 내려보낸다.
- **새 API 경로는 `AccessPolicy` 표에 넣는다**(공개·회원·유료·운영자, ADR 0010) — 빠지면 `AccessPolicyTest`가 막는다. 사용자 정보는 `support.CurrentUser`.
  로그인은 이메일+비밀번호(DB 세션). 운영자 계정은 처음 기동 때 `.env`의 `OWNER_EMAIL`·`APP_PASSWORD`로 만든다.
  로컬 compose는 로그인 없이 이 맥에서 첫 운영자로 연다(`LOCAL_NO_LOGIN`, ADR 0016). AWS·QA 덧붙임은 `"false"` 고정(AWS 개인용 서버는 ADR 0019).
- **🧪 모의 매매 상태는 AWS 서버(EC2 `my-macro-app`) 한 곳에만**(ADR 0019·0020) — 2026-10-29부터 서버의 v2. **이 폴더의 `.env`는 `PAPER_ENABLED=false` 고정**.
  두 곳에서 정기 작업(리스크 점검·결정·체결)이 동시에 돌면 안 된다 — 서버에서 v1의 `deploy.sh`·`make up`을 실행하지 않는다(되돌릴 때만, 계획서 §5-7).
  로컬 `.env`를 서버로 보낼 때는 그 줄과 포트 네 줄 등을 뺀다(`.env.aws.example`).
- 날짜는 `Kst.today()`(Java)·KST 기준. `LocalDate.now()`를 쓰지 않는다(서버 TZ는 UTC).
- **테이블마다 쓰는 프로세스는 하나**(ADR 0008). 수집기 테이블은 백엔드가 읽기만, 백엔드 테이블(`regime_log` 등)은 백엔드만 쓴다.
  스키마 파일은 `db/migrations/` 한 곳(수집기가 기동 시 적용). 백엔드 DB 접근은 `store`에서만. 정기 작업은 `StoreReader.quietly`로 읽는다(수집 유발 금지).
- 데이터셋 이름은 `collector/app/catalog.py`와 `backend/.../store/Datasets.java` 둘 다 고친다
  (`DatasetsParityTest`가 대조).
- 백엔드 패키지 의존 규칙(ADR 0001)과 화면 계층(ADR 0004)을 지킨다 — `ArchitectureRulesTest`가 막는다.
  컨트롤러는 자기 기능의 서비스 + `support`·`config` + 응답 캐시 `read.ComputedCache`만 쓴다.
- 수집 실패는 직전 저장본의 값을 버리지 않는다(전부 실패 → `EmptyResult`로 유지, 일부 실패 → 항목별 '이전 값'
  이어받기 + `isStale`). 태스크에는 속도군별 시간 상한이 있다(`TASK_DEADLINE_SECONDS`).
- 옮기는 커밋과 고치는 커밋을 나눈다. 큰 파일은 고치러 들어간 부분만 떼어 낸다. 결함은 재현 테스트
  (`test(QA-###)`, 수정 전엔 xfail/@Disabled) → 근본 원인 수정(`fix(QA-###)`) 두 커밋으로. 모든 커밋이 `make test`를 통과한다.

## 전달 방식
- 작업은 `claude/<주제>-YYYY-MM` 브랜치에서 하고, 끝나면 **본체 폴더의 `main`에 fast-forward 병합해 이 저장소(GitHub
  `Jinyoung-Kang/My_macro_dashboard_v2`, 공개)의 `main`에 push**한 뒤 CI(6개 job)까지 확인하고 커밋 번호와 함께 보고한다. 사용자는 git 명령을 직접 치지 않는다. 큰 변경은 설명하고 동의를 받은 뒤 반영한다.
  `Local_macro_dashboard_v3`·`My_macro_dashboard_v1` 저장소에는 이 세션에서 아무것도 올리지 않는다(v3는 모의 매매를 넣지 않기로 한 별도 공개 저장소 — ADR 0018, v1은 교체 전 운영본 — 되돌리기용).
- 커밋 메시지는 `type(scope): 요약`, **요약은 한국어**(예: `fix(backend): …`, `docs: …`), 끝에 `Co-Authored-By` 줄.
  CI 가 GitHub 쪽 사정으로 취소되면("job was not acquired by Runner") 취소된 job 만 다시 돌린다 — 코드 실패와 구분해 보고한다.
- 돌고 있는 코드를 바꾸는 변경이면 보고에 "`make up` 하세요"를 넣는다(이미 `make up`까지
  했으면 그 사실을 적는다).
- GitHub 인증은 HTTPS + 키체인 토큰. 403이면 docs/DEVELOPMENT.md §5의 해결 순서.

## 이 환경의 함정
- 같은 맥에서 `Local_macro_dashboard_v3`(모의 매매 개발 전 main, 3000/8080/8000/5432, compose 프로젝트 `local_macro_dashboard_v3`)와
  `My_macro_dashboard_v1`(3001/8081/8001/5433, `my_macro_dashboard_v1`)이 따로 돈다. 이 저장소는 `.env`의 포트 3002/8082/8002/5434를 쓰고,
  명령은 이 폴더에서만 친다. v1·v3 폴더·볼륨·스택은 건드리지 않는다(데이터 이어받기는 v1 `make backup` → 여기 `make restore`, 볼륨 복사 금지).
  브라우저 쿠키는 포트를 가리지 않으므로 세션 쿠키 이름도 다르다(이 저장소 `my_macro_v2_session`, v1 `my_macro_session`, v3 `macro_session` —
  `AuthService.COOKIE_NAME`).
- Claude Code 셸의 `grep`·`find`는 ugrep·bfs로 바뀌어 있어 `.gitignore` 대상(`.venv`, `.next`,
  `node_modules`, `.git`)을 건너뛴다. 파일 시스템 전체를 훑을 때는 `/usr/bin/grep`을 쓴다.
- 테스트 DB·백업 스크립트는 `docker compose exec -T postgres`로 컨테이너 안의 psql을 쓴다.
  맥에 `psql`·`pg_dump`가 없어도 된다(없으면 `test_db_scripts.py` 12개가 건너뛰어진다).
- `.claude/worktrees/…` 안에서는 `git checkout main`이 실패한다. 작업은 본체 폴더에서 한다.
- 테스트 DB를 쓰는 테스트는 postgres 컨테이너가 떠 있어야 한다(`make infra` 또는 `make up`).
- 수집기 `/health`는 DB까지 확인한다(없으면 503). `/health`를 공개 경로 예시로 쓰는 테스트는 `store.ping`을
  스텁한다 — CI에는 운영 DB가 없어 로컬에서만 통과하는 테스트가 된다.
- 스키마 파일(`db/migrations`)은 수집기가 기동할 때만 적용된다. `make up`은 `make migrate`로 늘 적용하지만, `docker compose up`을
  직접 쓰면 백엔드만 바뀐 배포에서 새 테이블이 안 생긴다(QA-016) — `make migrate`를 부른다.
- `docker kill`로 멈춘 컨테이너는 `restart: unless-stopped`가 다시 띄우지 않는다(수동 정지로 간주). 크래시 시험에
  쓰면 안 된다.
- 외부 패키지를 올릴 때는 Maven Central·npm에서 **실제 GA 버전을 확인**한다(마일스톤은 운영에 올리지 않음).
- 이 맥의 `mvn`은 Homebrew JDK 27로 돈다(`java -version`은 21이어도). CI는 Temurin 21이라 JDK 27에서만 나는 컴파일 오류는 CI에서
  안 보인다(`80db4ae` — 익명 `LinkedHashMap` 안의 `Entry`가 `Map.Entry`로 풀린 이름 충돌). CI와 같은 판으로 재려면
  `JAVA_HOME=$(/usr/libexec/java_home -v 21) make test-backend`. 코드는 두 판 모두에서 컴파일되게 쓴다.
- 모든 포트(화면·API·postgres·collector·새 서비스)는 127.0.0.1에만 연다(예외는 서버 caddy의 공개 리스너 :8301 하나 — ADR 0019 결정 16) — 로컬 화면은 로그인 없이 운영자로 열린다(ADR 0016,
  휴대폰 접속 없음). 로그인 경로를 시험하려면 QA 스택(기본 로그인), 로그인 없는 모드는 `QA_NO_LOGIN=1 bash scripts/qa/qa-stack.sh up`.
