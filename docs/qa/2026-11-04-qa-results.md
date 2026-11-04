# 2026-11-04 QA 결과 — 출시 검증 4차 (영역별 확인·남은 위험·측정값)

> 계획 [2026-11-04-qa-plan.md](2026-11-04-qa-plan.md)의 영역 7개(장부·보안·화면·AI·회귀·외부 장애·성능)를 QA 스택과 테스트 DB에서 검증한 결과 가운데, 결함이 아닌 것 —
> 확인해서 문제없던 것, 못 한 것과 남은 위험, 측정값 — 을 모았습니다. 결함은 [2026-11-04-qa-defects.md](2026-11-04-qa-defects.md)(QA-250~284), 구조 제안은
> [IMPROVEMENTS.md](IMPROVEMENTS.md), 측정 원자료 요약은 [evidence/2026-11-04-qa/measurements/](evidence/2026-11-04-qa/measurements/)에 있습니다.

- 대상 코드: `49a7d62b`(운영본 `main@bc22e799`·서버 `b39a7e4b`와 제품 코드가 같고 QA-250 수정만 더함). 시각: 2026-11-04 20:25~23:50 KST.
- 환경: QA 스택 `my_macrodash_v2_qa`(13002/18082/18002/15434, 차단 프록시 18890 — 외부 호출 없음, 로컬 백업 사본 복원), 로컬 postgres 5434의 `macrodash_qa_*_test`,
  작업 PC(AMD Ryzen 9 7940HS 12스레드·23GiB WSL2, 로컬 JDK 25). 운영본(Vultr)은 보안 머리글·TLS·출처 검사용 GET 3경로만 읽었습니다.
- 여러 영역이 같은 QA 스택을 함께 썼고, 끝에 QA 스택을 시험 전 백업으로 되돌렸습니다(장부·설정·메모·관측치 지문이 시험 전과 같음, 로그인 모드·프록시 block).

## 1. 확인해서 문제없던 것

### 장부 무결성·정기 작업(위험 1 — 장부 영역, 외부 장애 영역 일부)

- **상태 전이·멱등**: 미국 초기화 동시 2회(두 번째부터 created·backfilled 없음), 허용되지 않는 순서의 상태 변경(시작 전 계좌 ACTIVE·PAUSED, 잘못된 status 값·본문, 없는 계좌)은 모두
  400, 일시정지 때 대기 주문은 PENDING→CANCELLED 하나만. PAUSED·ACTIVE 동시 4회씩도 주문 변화 없음. `/api/paper/**` 호출 103건, 호출 묶음마다 장부 불변식 17개(현금 ≥ 0,
  주문당 체결 1, FILLED↔체결, 현금·수량 재계산, 시작 전 계좌 무체결 등) 위반 0, 허용 밖 주문 전이 0.
- **겹쳐 부르기**: 리셋 동시 3회(체결 1건), 출발 결정 동시 3회(1건 200 + 2건 400 '이미 시작', 출발 체결이 리셋 전과 같음), 수동 리스크 점검 동시 2회(하나는 '이미 처리한 관측치'),
  Claude 수동 결정 동시 3회(결정 행 1·재시도 1, 키가 없어 호출 0), 프레임 편집 동시 2회(같은 기준 판 — 하나는 400 '다른 판이 먼저'), 설정 patch 동시 2회(다른 키 — 잃어버린 갱신 없음),
  주간 복기 동시 3회(429 두 번 + 400, 행 없음), 여러 쓰기를 섞은 동시 실행 — 모두 불변식 위반 0.
- **같은 JVM 안 동시성(테스트 DB)**: 같은 관측치를 세 스레드가 처리(체결 합 1), 리셋과 관측치 처리 겹침 5회·일시정지와 체결 겹침 6회 모두 위반 0. 장부 서비스가 두 벌(두 프로세스)일 때만
  깨짐 — QA-251.
- **재출발(restart-at-start-close) 음성 경로 9가지**(이미 체결, 시작 전, 확인 문구 없음·다름, 없는 계좌, 미국 계좌의 TOSS·숫자 출처, 깨진 JSON, 배열 본문) 모두 400, 장부 변화 0.
- **한국 쓰기 경로(출발일 없음)**: init·수동 결정·출발·복기 400 '출발일 비어 있음', 리스크는 문서대로 200 `ok:false` + dormantReason, 잘못된 market 값 400, 행 생성 0.
- **마이그레이션**: 빈 DB에 V1~V19 처음 적용·재적용 모두 성공(5.1초), 두 번의 `pg_dump -s`가 같음, 넣어 둔 행 보존, 수집기 실행기로 다시 적용하면 `[]`.
- **수동 리스크 점검 중 백엔드 재시작**(요청 0.02·0.06초 뒤 restart 2회): 요청은 정상 종료가 기다려 200으로 끝나고 다섯 계좌 `last_processed`가 같은 값, 불변식 위반 0, 끝나지 않은 작업 기록 0.
- **정기 작업 게이트**: 시험이 없던 5개 작업(`PaperNotifyJob`·`PaperKrCheckpointJob`·`PaperClaude1CheckpointJob`·`PaperKrExecutionAuditJob`·`PaperCheckpointJob`, 그리고
  `PaperExecutionAuditJob`)을 `enabled=false`로 세 시각에 불러 의존성 호출 0(임시 탐침). `@Scheduled` 클래스 10개 모두 빈 하나, fixedDelay라 같은 작업은 스스로 겹치지 않음.
- **시간대**: 백엔드 main에 `LocalDate.now()`·`ZoneId.systemDefault()` 등 사용 0, 서머타임 경계 시험 통과. 기존 정기 작업·장부 시험 17클래스 238개 통과(영역 테스트 DB).

### 인증·권한·출처(위험 2 — 보안 영역, 외부 장애 영역 일부)

- **접근 정책 전수 대조**: 경로 129 × 비로그인·회원(FREE)·유료(PRO)·운영자(요청 544건 + HEAD 32건) — `AccessPolicy` 표에서 기대값을 직접 만들어 대조, 정책 실패 0, 정책 표와
  `routes.json` 차이 0. HEAD로 운영자·유료 GET 32건 모두 403(QA-017 회귀 없음). 장부·계정 쓰기 22건은 건너뜀.
- **우회 시도**: 경로 변형(끝 '/', 대소문자, `.json`, `%6F`, `./`, `x/../`, `;jsessionid`, `%2e%2e`) 우회 0. 조작 쿠키·alg=none·기본 비밀 JWT 401, 기존 `auth-probe.sh` 1~8절 실패 0.
  다른 회원의 알림 규칙 끄기·지우기 404(IDOR 없음).
- **세션**: 쿠키 `HttpOnly; SameSite=Strict; Max-Age=43200`(QA는 `COOKIE_SECURE=false` 설정대로 Secure 없음), 토큰 32바이트 SecureRandom·DB에는 SHA-256만. 로그아웃·logout-all 뒤
  옛 쿠키 401, DB에서 만료·취소하면 즉시 401, 재시작 뒤에도 유지. 로그인 시도 제한(5회까지 401, 6회째부터 1초 뒤 429, 맞는 비밀번호는 그 상태에서도 200).
- **본문 상한**: 로그인 전 4KB·로그인 뒤 4MB 경계(Content-Length·chunked 모두), 인증 없는 10MB 쓰기는 본문을 읽지 않고 401(1.3~3.7ms, QA-069 회귀 없음). 깨진 JSON·깊은 중첩·
  큰 수·XML(XXE 표본)·form → 400·415.
- **출처 검사**: 로그인 모드 쿠키 쓰기에 이상한 Origin(null·https·`localhost:13002.evil.example`·다른 포트·`file://`) 403, 무로그인 모드(`QA_NO_LOGIN=1` 실제 스택)에서 Origin 없는 쓰기·
  cross-site·Host 리바인딩·X-Forwarded-For 모두 막힘. Tailscale 신원 갈래는 실제 SessionFilter 코드 단위 시험 12건 통과(QA 스택은 신원 기능 꺼짐 — 위조 헤더 401).
- **운영본 읽기(GET 3경로)**: nosniff·no-store·X-Frame-Options DENY·CSP `default-src 'none'; frame-ancestors 'none'`·Referrer-Policy, Server·X-Powered-By 없음, TLS 1.3·1.2만(1.0·1.1 거절),
  80번 연결 거부, evil Origin GET 403, 클라이언트가 다른 신원 헤더를 실어도 실제 신원이 이김. HSTS는 없음(Caddyfile에 적힌 설계 — 80번이 닫혀 있음).
- **퍼저**(fuzz-api.py 사본에 v2 파라미터 16개·오류 형식 검사 추가): 1,522건, 5xx 0, 10초 초과 0, 1MB 넘는 응답 0, SQL·템플릿·JNDI·경로 순회 문자열에 500 없음.
  다만 원시 NUL·깨진 UTF-8은 이 퍼저가 보내지 못해 따로 쓸었고 결함으로 나옴(QA-260·261).
- **비밀값**: gitleaks 전체 이력 1,796커밋 누출 0, `git log --all -p`(42MB)에서 .env 실제 값 0, 화면 빌드 산출물(.next)·QA 로그 26,800줄에서 이메일·토큰·비밀번호 0.
- **의존성**: `npm audit --omit=dev` 0건, pip-audit(collector/constraints.txt 60개) 0건, Maven 런타임 85개 중 공시 1(QA-264). EOL은 모두 지원 기간 안(Node 24 EOL 2028-04-30,
  Python 3.11 2027-10-31, Temurin 21 2029-12-31, Spring Boot 4.1 OSS 2027-07-31, PostgreSQL 16 2028-11-09).
- **화면의 외부 링크**: http(s)만 링크로, noopener noreferrer. `dangerouslySetInnerHTML`은 고정 테마 스크립트 1곳뿐, 열린 리디렉션 없음.

### 백업·복원·배포 되돌리기(위험 3 — 외부 장애·회귀 영역)

- **배포 직전 덤프로 되돌리기**(DEVELOPMENT §7 절차를 QA 스택에서 그대로): `db-backup.sh pre-deploy` → 장부 훼손 흉내(체결·보유 삭제, 현금 −1, 관측치 하루치 삭제) → 되돌리는 배포의
  덤프 → 'ls -t의 둘째'가 첫 덤프를 고름 → 복원 22초. API 12종이 시각 필드 빼고 같음, DB 지문 같음(세션 +1만), 불변식 위반 0.
- **시험 전 상태로 복원**: 21초, 지문 같음. 수집기 실행 중 재시작은 기동 때 '비정상 종료된 수집 기록 1건 정리'·interrupted 판정, 스냅숏 그대로.
- **백업·복원 스크립트 시험 12건**(이 PC에서는 psql·pg_dump가 없어 늘 건너뜀): postgres:16-alpine 컨테이너 대역으로 12/12 통과.
- **deploy.sh의 시험 없던 갈래 4개**(서버에서 추적 파일 수정 → 멈춤, main 갈라짐 → fast-forward 실패로 멈춤, .env 644 → 경고, `up --wait` 실패 → exit 1·덤프는 남음) 임시 시험 4/4 통과.
- **새 폴더 기준**: `docker compose config`(기본·QA·Vultr 덧붙임 — Vultr는 COOKIE_SECURE true·무로그인 false·포트 전부 루프백, `PUBLIC_ORIGIN`이 비면 해석 실패), 문서의 make 타깃이
  모두 Makefile에 있음, `ports.sh check`가 본 스택 포트를 정확히 짚음.

### 외부 장애·수집(위험 4 — 외부 장애 영역)

- **fast 태스크 시간 상한·합치기·좀비 중 새로 시작 안 함·잠금 해제**(QA-011·079·117): hang에서 120.0초에 '시간 초과', 동시 호출은 합류, 좀비 중 다시 부르면 0.02초 만에 '진행 중',
  좀비가 끝난 뒤에는 5.68초에 새로 실행. 단, 좀비 수명 자체가 상한의 4배 — QA-255.
- **실패 때 직전 저장본 유지**: hang·block 전후 `snapshots`의 md5·collected_at이 같고, `/api/macro/overview` 21개 중 18개가 `isStale:true`·'수집 실패'.
- **slow:5 모드**: radar_rankings 90.1초·scraper_markets 61.1초·`/api/live/prices` 32.0초·상세 quote 16.0초 — 모두 상한 안.
- **SSE 재연결**(QA-183·189 회귀 없음): 실제 백엔드 재시작 때 '다시 잇는 중' 표시 뒤 health 200 약 3초 후 새 연결과 값, 502 흉내에 5→10→20초 백오프, 탭 숨김 때 닫고 보일 때 0.2초에
  다시 엶, '끄기'는 숨김·보임에 GET 없음. 단, 스레드 풀·세션 갈래는 QA-254·281.
- **수집기 토큰**: 토큰 없는 `/collect/task/*`·`/live/*` 6경로 401, Host 위조 400. 공개 진단(`/status`·`/tasks`·`/task-history`)은 설계대로 200.

### AI 경로(위험 5 — AI 영역, 실제 Claude 호출 없음)

- **하루 호출 상한 동시 잡기**: 80개 동시 요청(정기 문턱 30·수동 문턱 23 섞음) 중 정확히 30 성공, 수동이 23을 넘은 것 0, 번호 중복 0(`INSERT … ON CONFLICT … WHERE calls < cap` 한 문장).
- **모든 구조화 호출이 부르기 전에 상한을 잡음**(`ClaudeDecisionPipeline.send`·`ReviewService.review`·`FrameworkService.propose`), SDK `maxRetries(0)`로 숨은 재시도 없음, 수동 경로는
  '상한 − 예약 문턱'(QA 스택 cap 20·예약 7·수동 13·계좌2 주기 2로 일관).
- **응답 형식 검증 18가지**(문자열 숫자, 범위 밖 비중, 소문자·전각 티커, 필수 키 없음·스키마 밖 키, 두 JSON 이어 붙임, 중복 티커, CASH 티커, 아주 작은 비중 등)와 잘림·stop_reason 6가지:
  장부 변화 0·재호출 0, 텍스트 블록 둘로 나뉜 JSON은 이어 붙여 OK. JSON 읽기는 뒤에 붙은 글·NaN을 거절. 예외는 비유한 숫자 하나 — QA-252.
- **부분 저장 없음**: 결정·주문·대신함 취소·장중 확인 계획이 한 트랜잭션(코드 확인, 기존 DB 시험에 기댐). 모델 응답이 설정·외부 호출로 곧바로 이어지는 경로 없음(제안은 PENDING,
  승인은 별도 경로), 텔레그램은 이스케이프·링크 미리보기 끔, 화면은 모델 글을 innerHTML 없이 그림.
- **모의 매매 외부 글 지우기**: 메모·사건·프레임 제안·복기 경로 모두 ASCII·전각 가짜 구분자를 지움. 다른 꺾쇠 모양과 상세 요약 경로는 QA-273·274.

### 화면·접근성(위험 6·8 — 화면 영역, 성능 영역 일부)

- **첫 로드**: 36화면 × 1280·768·360·320px과 상세 29화면 × 360·1280에서 가로 넘침 0, 콘솔 오류·page error·4xx·5xx 0(추적하지 않는 CIK의 의도된 400 제외), 로딩 문구가 남은 화면 0.
- **조작**: 1280px 318건·360px 142건(쓰기는 모두 막음) 뒤 가로 넘침·page error 0. 표 정렬 5열 × 오름·내림 단조, `aria-sort` 맞음.
- **키보드**: 36화면 Tab 순회에서 포커스 표시 없는 정지 0, 검색(Ctrl+K → AAPL → Enter → 상세, Esc 뒤 초점 복귀)·메모 저장·설정 저장(결과로 초점 이동)·알림 규칙 생성이 키보드만으로 됨,
  검색·'계좌 초기화' 대화상자 초점 가두기와 Esc 복귀.
- **명도 대비**: axe color-contrast 위반 0, incomplete 노드(라이트 897·다크 1124)는 반투명 배경을 합성해 직접 계산 — 기준 미달 0. 360px 24px 미만 터치 대상 45개는 간격 예외로 실패 0.
  Lighthouse 접근성·모범 사례 10회 모두 100.
- **새로고침·주소 직접 입력·로그인·로그아웃**: /paper → /paper/us, 탭 직접 입력·새로고침 유지, 로그아웃 뒤 뒤로 가기에도 자료 안 보임, 비로그인은 /login으로.
- **화면 숫자와 API 대조**: 규칙 계좌 순자산·현금·수익률·비중이 화면과 `/api/paper/overview`에서 같음. 한국 책이 쉬는 상태는 사유와 '쉬는 동안 단추 없음'을 보임.

### 성능(위험 7 — 성능 영역)

- 핵심 GET 혼합 부하 1·5·20·50명에서 오류 0%·429 0(처리량은 약 250 req/s에서 멈춤), 2KB 넘는 JSON은 모두 gzip, API는 `Cache-Control: no-store`, 정적 자산은 1년 immutable.
- 목록 경로는 limit을 1~500으로 접거나 상한이 있고(radar/history 5000행 — QA-133), 파라미터 없는 목록은 지금 작음(radar/history 930행 등).
- 지금 데이터에서 요청 하나당 DB 문장 수가 기록 누적에 따라 늘어나는 반복은 없었음(개요 48·상태 23·매크로 12). 1년치 합성에서 늘어나는 것은 QA-253·282.
- `-XX:+ExitOnOutOfMemoryError` 뒤 자동 재기동(10-18 회차에 관측 못 한 것): 메모리 부족 4회 모두 약 2.7초에 다시 떠 healthy(OOMKilled=false — JVM 자체 종료).

### 회귀·시험 신뢰도(회귀 영역)

- 전체 시험 3회(수집기 ruff + pytest 1330 통과·12 건너뜀, 백엔드 `mvn -q verify` 2387, 화면 check·vitest 1786(133파일)·eslint) — 시험 하나씩 대조해 결과가 다른 시험 0.
- 화면 시험은 순서 섞기(seed 7·20261104)·가짜 시계(토 10:00, 자정 넘김, 6주 뒤, KST 07:00)·TZ(America/New_York·UTC) 모두 1786 통과. 백엔드는 TZ=America/New_York 2387,
  가짜 시계에서 HTTP 통합 두 클래스를 뺀 2341 통과, 순서 섞기 seed 7 통과. 수집기는 TZ=America/New_York 통과. 흔들린 것은 QA-275·276 두 건.
- QA-250(mktemp) 회귀 없음, 화면 `tsc --noEmit` 통과.

## 2. 못 한 것과 남은 위험

| 영역 | 못 한 것 | 이유 · 남은 위험 |
|---|---|---|
| 장부 | 한국 계좌 양성 경로(init KR·출발 단추·`kr-claude2-start`·TOSS/FSC 출처 재출발)와 그 동시 2회 | QA 백엔드에 `PAPER_KR_START_DATE`가 없고 장부 영역은 재시작 금지 — 기존 시험(KrStart*·StartCloseRestart) 통과까지만 |
| 장부 | 재출발 성공 경로와 동시 2회(QA-177 회귀), 미국 계좌2 출발·정기 결정·장중 확인·시각 지정 체결 | 전제를 만들려면 Claude 계좌 출발(실제 호출)이 필요 — 기존 시험으로 대신 |
| 장부·AI | Claude 호출 중(최대 240~300초) 배포·재시작 때 과금 응답 유실·이중 호출, 남는 결정·작업 기록 | QA 스택은 AI 키가 비어 '응답 없는 Claude'를 흉내 낼 수 없음. `spring.task.scheduling` 종료 대기 설정·backend 유예가 없음(QA-257과 같은 줄기) |
| 장부 | 장중 확인 작업 호출 중 그 계좌를 리셋·재출발, 한국 리스크·결정·출발 동시 2회, `UsTimedFills`와 일시정지·리셋 동시, 알림 커서의 늦은 커밋, 작업 기록 보존 정리 | 시험 경로 없음(목록만) |
| 장부 | 한국 단일 계좌 리셋 뒤 다시 출발할 수 없음(명세 §K28 설계)에 화면·API 경고 없음 | 시험 없음 — 설계 확인 필요 |
| 알림 | 텔레그램 알림 중복·누락 | QA 스택에 텔레그램 값 없음(외부 호출 금지) |
| 인증 | 운영 세션 쿠키의 Secure 속성, 세션 12시간 만료·5분 touch의 실제 경과 | 운영에 로그인하지 않음(신원 자동 로그인), 시간을 기다리지 않음 — 설정만 확인 |
| 인증 | Tailscale Serve가 신원 없는 기기(태그·공유 노드)의 위조 신원 헤더를 지우는지 | 그런 기기가 없음 — 운영자 기기에서 실제 신원이 이기는 것만 확인 |
| 보안 | 쓰기 경로(fuzz:false — 장부·계정·설정·메모·결정·복기·초기화 등)의 퍼징, 쓰기 본문의 NUL·깨진 UTF-8, POST 쿼리의 깨진 UTF-8, 설정 검증의 형식 오류 | 공유 QA DB·장부를 움직이지 않으려 보내지 않음 — QA-260과 같은 원인으로 500 추정 |
| 보안 | 운영 서버 이미지의 취약점, lxml 내장 libxml2 2.14.6의 CVE, trivy secret·misconfig 스캐너, pip-audit 개발 도구 | 서버 접속 금지, trivy가 휠 내장 라이브러리를 못 잡음, vuln만 돌림 |
| 보안·화면 | Caddy 경유(운영 형태)의 `%2F`·8KB 초과 응답 형식, 같은 사이트에서 Origin 없이 오는 GET의 실제 브라우저 재현 | QA에는 Caddy가 없음, 단위 시험으로만 |
| 화면 | 상태를 바꾸는 단추(초기화·출발·재출발·결정 실행·복기·재선정·프레임 제안·승인·회원 만들기·비밀번호 변경 등)의 화면 반응 | 시험이 GET 아닌 요청을 모두 막음 |
| 화면 | 실제 휴대폰(iOS Safari·안드로이드 Chrome), 768px 상호작용·다크 360px·가로·확대 200%, Safari·Firefox 키보드 | headless Chromium 모바일 에뮬레이션만 |
| 화면 | 외부 출처가 정상일 때의 화면(실시간 값·뉴스·AI 요약), 한국 모의 매매에 자료가 있을 때의 탭, 회원·유료 계정의 메뉴 잠금 | 차단 프록시, 한국 출발일 없음, 화면 영역은 회원 자격 없음 |
| 화면 | 운영자 혼자 SSE 전역 상한(20)에 닿는지, 한 화면이 SSE를 몇 개 여는지 | 상한을 채우면 같은 스택의 다른 영역을 막음 — 닫힌 연결이 25초 남고 주기 선택의 ↑↓마다 새 연결은 확인(IMPROVEMENTS 8번) |
| 외부 장애 | yfinance 좀비가 수집기 작업 스레드 8개를 채워 장부 태스크가 '워커 대기 초과'가 되는지 | slow 태스크 상한 600초라 시간 안에 못 잼(QA-255 남은 위험) |
| 외부 장애 | 앞단(Caddy·tailscale serve)이 하트비트가 69~90초 멈춘 SSE를 끊는지, Vultr 컨테이너 종료 유예 초 | QA에는 앞단이 없음, 운영 서버 금지 |
| 외부 장애 | 실제 외부 출처의 거부(403·429) 래치, postgres 재시작·연결 끊김, 정기 작업이 도는 순간의 재시작, 한국 수동 작업 중 재시작 | 차단 프록시는 502·무응답만, 범위 밖 |
| AI | 실제 모델이 비유한 숫자 리터럴을 내는지, 주입 글(`</자료>`·≪메모 끝≫)을 따르는지 | 실제 Claude 호출 금지 |
| AI | 결정 작업이 비유한 응답에 정확히 3회 뒤 GAVE_UP인지(작업 하네스), 계좌1 장중 확인·출발·미리보기의 호출 수, AI 리포트 `</data>` | 코드 읽기로만 |
| AI | 번역 단계·다른 엔진(Cloudflare·NVIDIA·Cerebras), 한국 패킷 조립 끝-끝 11b_events, 모델 글이 다음 패킷에 다시 들어가는 2차 주입 | 시험 없음(IMPROVEMENTS 10번) |
| 회귀 | CI와 같은 JDK 21에서의 세 번 실행, 화면 `next build`, HTTP 통합 시험 46건의 날짜·요일 의존, DB를 쓰는 수집기 시험의 날짜 의존 | 로컬 JDK 25만, 지시된 범위, libfaketime 아래 JDK HttpClient가 멈춤, DB 시계는 실제 시각 |
| 회귀 | 새 폴더에서 실제 `make up`·`make test` | 포트 충돌 때문에 config·`make -n` 수준만 |
| 회귀 | 백엔드·수집기 순서 섞기의 다른 seed, v3 스택이 켜졌을 때 수집기 시험이 v3 DB에 실제로 붙는지 | seed 1~2개만, v3를 켜지 않음(QA-277) |
| 성능 | Vultr(2 vCPU·4GB)에서 같은 수치, 실제 장중 확인 패킷 크기, 한국 계좌 개요·상태 부하, 외부 출처를 타는 경로의 실제 지연 | 운영본 부하 금지, QA DB에 실제 CHECKPOINT·한국 계좌 없음, 차단 프록시 |
| 성능 | `pg_stat_statements` 집계, 백엔드 힙 상세, SSE 동시 연결 부하, Lighthouse 반복 측정(편차), 2년 이상 데이터의 복기·패킷 생성 | postgres 재시작 필요, JRE에 jcmd 없음, 표본 1회 |

**시험이 없는 중요한 경로**(회귀 영역이 작업 환경에서만 잰 JaCoCo·coverage.py로 찾음 — [측정](evidence/2026-11-04-qa/measurements/regression-rounds-coverage.txt)):

- 위험 1: `PaperNotifyJob`·`PaperKrCheckpointJob`·`PaperClaude1CheckpointJob`의 `scheduledRun`(줄 0%), `PaperController.restartAtStartClose`·`PaperDecisionController`의 수동 출발 HTTP 층,
  `StartCloseRestart`의 잠근 뒤 다시 보는 검사, `PaperLedgerService.backfillLocked`의 SELL 다리·현금 부족 부분 매수·평균단가, 장부 동시성 시험(paper 시험 104개 중 0),
  `ReviewService.recordAfterResponse`, `AlertEvaluator`·`RegimeLogService`의 정기 진입점.
- 위험 2: `AuthService.logoutOthers`·`SessionStore.touch`, 4MB 상한의 reader 경로, 컨트롤러 밖 오류 본문 가림. 수집기 `POST /collect/task/{name}`·`/live/*`가 토큰 시험 목록에 없음.
- 위험 3: `deploy.sh` 갈래(이번 임시 시험만), `setup.sh`·`ports.sh`(시험 0), 백업·복원 시험이 이 PC에서 늘 건너뜀, 복원 대화형 확인과 pre-restore 정리.
- 위험 4: `task_radar_rankings`의 '이력 값은 누적하지 않음' 가드, `task_fed_liquidity`의 추정치 가드, 빈 결과면 저장본 유지(변동성·선물 추세·토스 랭킹), 실시간 출처 파서(네이버·다음·토스 0%).

## 3. 측정값

측정은 모두 QA 스택(외부 호출 차단)이나 작업 PC에서 했고, 같은 시간에 다른 영역이 같은 스택을 썼습니다. 운영본(Vultr 2 vCPU·4GB) 수치가 아닙니다.

### 3-1. 핵심 GET 혼합 부하(k6)

조건: 2026-11-04 22:49~23:25 KST, k6 2.3.0(`grafana/k6`), 닫힌 고리·생각 시간 0, 단계마다 60초, 11경로(홈 regime·status/issues·unread, macro/overview, paper overview·status 미국·한국,
sec13f/institutions, detail/quote AAPL, live/prices). 백엔드 JDK 21·1GiB 상한·힙 718MiB·SerialGC, postgres 16 512MiB, QA DB 570MB(timeseries 1,520,827·observations 799,055행).
자원은 docker stats 2초 간격 표본 31개. 원자료 [performance-k6-core-get.txt](evidence/2026-11-04-qa/measurements/performance-k6-core-get.txt).

| 동시 사용자 | 처리량 | p50 | p95 | p99 | 오류율·429 | 백엔드 메모리 최대 · CPU 평균 | postgres CPU 평균(최대) |
|---|---|---|---|---|---|---|---|
| 1 | 27.5 req/s | 6.0ms | 71.7ms | 1,009ms | 0% · 0 | 267MiB · 22% | 36%(119%) |
| 5 | 121.4 req/s | 7.5ms | 88.4ms | 1,004ms | 0% · 0 | 287MiB · 86% | 198%(565%) |
| 20 | 206.2 req/s | 23.4ms | 206.4ms | 1,828ms | 0% · 0 | 310MiB · 148% | 316%(689%) |
| 50 | 250.8 req/s | 100.6ms | 562ms | 1,971ms | 0% · 0 | 351MiB · 204% | 400%(693%) |

- p99를 끌어올린 것은 live/prices 한 경로(차단 프록시에서 3초 캐시가 만료될 때마다 1~4초). 경로별 p50(1명→20명): paper/status 미국 26.1→129.5ms, status/issues 70.6→131.3ms,
  macro/overview 17.3→71.0ms, paper/overview 미국 18.1→72.3ms, 나머지 1~10ms.
- 50ms 넘는 질의(log_min_duration_statement): 수집기 `/status`의 `COUNT(*) FROM timeseries`(중앙 62ms)·`observations`(55ms)가 `/api/status`·`/api/status/issues`마다 나감(IMPROVEMENTS 6번).

### 3-2. 1년치 합성 데이터(실행 감사·개요 — QA-253·282)

조건: QA DB에 결정 750(claude 정기 253, claude2 정기 250·확인 250)·주문 4,166·감사 4,166·장중 확인 250을 넣고 측정 뒤 지움(장부 지문 같음). 중앙값 10회.

| 항목 | 0행·기준 | 125행·주문 4.2k | 250행 | 500행·주문 12.2k | 색인·수정안 |
|---|---|---|---|---|---|
| 실행 감사 claude2 limit=50 | 4.7ms | 153ms | 319ms | 478~510ms | 쓰는 칸만 묶어 읽기 1.5ms(250행) |
| 실행 감사 요청당 문장 수 | 4 | 129 | 254(같은 단건 250) | 504 | 일정 |
| 개요(`/api/paper/overview`) | 17.0ms | 68.1ms | — | 123.8ms | 임시 decision_id 색인 31.5ms |
| 결정 목록 limit=500 claude / claude2 | 47.8 / 100.3ms | — | — | 103.4 / 203.7ms | 색인 12.1 / 22.0ms |

- 동시 부하(k6): 실행 감사 250행 limit=1 10명 통과(p50 1.19s, 백엔드 828~874MiB/1GiB), 15명·20명 힙 고갈. 500행 5명 통과(p50 812ms)·8명 고갈. 대조 claude(장중 확인 없음) 20명 통과.
  개요 주문 12.2k 동시 5명 p50 134ms·postgres CPU 평균 435%.

### 3-3. Lighthouse 13.6.0(페이지마다 1회 표본 — 편차 미측정)

조건: QA 스택 로그인, 데스크톱 프리셋과 모바일(시뮬레이션 저속). 원자료 [performance-lighthouse-bundle.txt](evidence/2026-11-04-qa/measurements/performance-lighthouse-bundle.txt).

| 화면 | 성능(데스크톱/모바일) | LCP(ms) | TBT(ms) | CLS | JS 전송 |
|---|---|---|---|---|---|
| / | 83 / 55 | 807 / 4,102 | 11 / 684 | 0.337 / 0.279 | 514 / 511KB |
| /macro | 80 / 64 | 1,254 / 3,625 | 105 / 856 | 0.305 / 0.151 | 534 / 531KB |
| /paper/us | 99 / 72 | 938 / 4,079 | 4 / 566 | 0 / 0 | 508 / 505KB |
| /paper/kr | 99 / 81 | 860 / 4,307 | 0 / 242 | 0 / 0 | 508 / 505KB |
| /institutions | 99 / 81 | 833 / 3,373 | 2 / 356 | 0.004 / 0.092 | 527 / 523KB |

- 접근성·모범 사례는 10회 모두 100. 미사용 JS 추정 188~213KiB. 번들 `.next/static` 2,208KB(JS 51·CSS 1), 가장 큰 청크 434,924B(gzip 123,028B, recharts 포함).
- CLS는 Playwright로 24화면을 따로 잼(1350/412px): 0.25 넘는 화면과 원인은 QA-283.

### 3-4. 응답 크기(gzip 전 → 후, 상위)

radar/history(파라미터 없음, 930행) 354,826 → 29,538B, analytics/correlation(250·10년) 287,314 → 45,246B, paper/decisions/8 188,107 → 17,294B, paper/track-record 184,569 → 23,649B,
liquidity?years=10 126,645 → 24,331B, macro/overview 78,716 → 11,976B. 2KB 이상 JSON은 모두 gzip.

### 3-5. 화면(브라우저에서 잰 값)

조건: 20:27~21:50 KST, headless Chromium 156.0.8078.4(playwright-core 1.64.1), 같은 스택을 다른 영역과 함께 씀. 원자료 [ui-crawl-axe.txt](evidence/2026-11-04-qa/measurements/ui-crawl-axe.txt).

| 항목 | 표본 | 값 |
|---|---|---|
| 브라우저가 낸 API 요청 시간(요청~끝) | 1,498건 | p50 25ms · p95 1,011ms · p99 2,033ms · 최대 2,240ms(1.5초 넘는 것은 외부가 막힌 `/api/detail/news` 76건뿐, 중앙 2,019ms) |
| 화면 안정 시간(DOMContentLoaded → 네트워크 1.2초 조용) | 1280px 108회 | 중앙 1,515ms · 최대 3,421ms(1.2초 대기 포함) |
| axe(WCAG 2.1 A·AA) 위반 | 36화면 × 3폭 + 상세 29화면 | 2종 8노드(QA-269), 명도 대비 0 |
| 키보드 걸음 수 | 1280px | 메모 저장까지 Tab 35번, 설정 키 하나까지 Tab 53번 → 저장 단추까지 Shift+Tab 31번 |
| SSE | — | 연결 직후 첫 응답 머리글까지 약 2초, 주기 선택 상자 ↑ 3번에 연결 3개 |

### 3-6. 외부 장애·종료·복원(외부 장애 영역)

| 항목 | 조건 | 값 |
|---|---|---|
| 수집 태스크 | 프록시 block | scraper_markets 5.4s · macro_collected 8.0s · radar_rankings 6.1s(저장본 추정치로 대체) |
| 수집 태스크 | 프록시 hang | fast 태스크 120.0s에 시간 초과, 좀비 scraper_markets 480.2s · macro_collected 483.9s, 30초 가드 안 yfinance 한 번 130.0s |
| 실시간·상세 | 프록시 hang | `/api/live/prices`(4종목) 90.1s → available:false(백엔드 수집기 읽기 상한 90초), 상세 quote kr 31.0s · us 60.0s, news·symbols 90.1s |
| 실시간·상세 | slow:5 | radar 90.1s · scraper 61.1s · live 32.0s · detail kr 16.0s |
| SSE 굶주림(QA-254) | hang, 미국 구독 4개 | 69.1s 동안 머리·하트비트 없음, KR 첫 값 10.1s(대조 GET 2.0s) |
| 백엔드 종료(QA-257) | SSE 없음 / SSE 1개 / 유예 45s | 0.7s·exit 143 / SIGTERM 약 3s 뒤 SIGKILL·exit 137 / Spring이 30.0s 기다린 뒤 143 |
| 백엔드 재기동 | — | 약 2.7~3.0s(Started … in 2.7s) |
| 수동 리스크 점검 | 할 일 없음 / 5계좌 처리 | 24ms / 97ms |
| 로그인 제한 | 실패 반복 | 5회까지 0.02~0.11s, 그 뒤 약 1.03s에 429, 맞는 비밀번호 1.07s |
| 백업 · 복원 | QA DB(백업 464MB) | 백업 5.8s, 복원 21~22s(서비스 멈춤 포함) |
| 로그아웃 뒤 SSE(QA-281) | 5초 주기 | 4m59s 뒤 이벤트 수신, 6m06s에 닫힘 |

### 3-7. 회귀·커버리지(회귀 영역, 세 회차 — `49a7d62b`, 로컬 JDK 25·Python 3.11.17·Node 24.22.1, 다른 영역과 같은 PC 부하)

| 묶음 | 결과 | 실행 시간(1/2/3회차) |
|---|---|---|
| 수집기 pytest | 1330 통과 · 12 건너뜀(세 번 같음) | 345.6s / 404.5s / 366.2s(기준선 193s — 동시 부하), 가장 느린 시험은 QA-277의 두 개(각 5.01~5.04s) |
| 백엔드 surefire | 2387 통과(세 번 같음) | 시험 시간 합 85.4s / 108.5s / 79.5s(3배 넘게 흔들린 것 3건, 결과는 같음) |
| 화면 vitest | 1786 통과(133파일) | Duration 23.18s(1회차), 시험 시간 합 87.7 / 133.6 / 113.7s |

- 커버리지(작업 환경에서만 — 프로젝트 의존성 변경 없음): 백엔드 JaCoCo 0.8.16 줄 91.0%·분기 78.3%(feature.paper 줄 93.4%·분기 79.3%, auth 88.9%·80.9%, web 89.9%·85.2%,
  store 95.8%·81.9%, positioning 53.7%, macro 61.0%), 수집기 coverage.py 7.17.1 문장 87%(9,452 중 1,252 미실행; runner 94%, store 93%, series 79%, markets 78%, ls 34%).
- 흔들림 재현율: v18RerunIsSafe 수집기 시험과 동시 8회 중 2회(독립 재현 38회 중 7회), 단독 0회. pykrx 순서는 지정 순서에서 결정적.

### 3-8. 보안·장부·AI(보조 수치)

- 보안(20:25~20:50 KST): 접근 대조 요청 544건(신원 4) + HEAD 32건, 정책 실패 0, 최장 2,348ms. 퍼저 1,522건 97초 — 200 767·400 750·404 5, p50 2ms·p95 46ms·최장 4,046ms
  (`/api/radar/consensus`), 최대 응답 289,994B. NUL·깨진 UTF-8 쓸기 GET 35경로 406건 × 2회 → 이 시험으로 백엔드 ERROR 332줄(InvalidParameterException 305, DataIntegrityViolation 21,
  NPE 6). 본문 상한 4MB 통과 57ms·4MB+1 413 2ms. gitleaks 1,796커밋 24.19MB 3.45초. trivy 다섯 이미지 HIGH·CRITICAL은 QA-263. QA DB에 회원·유료 시험 계정 2개를 만들어 둠.
  원자료 [security-summary.txt](evidence/2026-11-04-qa/measurements/security-summary.txt).
- 장부 API(curl time_total, 단일 사용자, 103건 중 대표값): init US 0.018~0.054s, 상태 변경 0.006~0.028s, 리셋 0.015~0.064s, 수동 리스크 0.024~0.036s, 규칙 계좌 출발 결정 약 0.50s,
  규칙 수동 결정 0.30~0.40s, Claude 수동 결정(키 없음 실패) 0.87~1.83s, 설정 patch 0.008~0.026s. 상태 코드 200 44 · 400 54 · 404 1 · 405 2 · 429 2.
  원자료 [paper-ai-summary.txt](evidence/2026-11-04-qa/measurements/paper-ai-summary.txt).
- AI(가짜 AI·시험 시계 — 비용·지연은 재지 않음): 하루 상한 동시 잡기 80요청 중 30 성공·문턱 초과 0, 형식 오류 18가지·잘림 6가지에서 장부 변화 0·재호출 0, 비유한 응답에서
  장중 확인 창 19회 호출(QA-252).
- 외부 장애 원자료 [resilience-summary.txt](evidence/2026-11-04-qa/measurements/resilience-summary.txt).
