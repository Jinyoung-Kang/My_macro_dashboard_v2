# AWS 정리(단계 D) + 한국 관측치 늦음 기준을 24시간 서버에 맞춤 — 작업 지시문

- 작성: 2026-11-03, 다른 세션이 읽고 실행한다. 배경은 [Vultr 이전 명세 §7](2026-11-02-vultr-migration.md) · [ADR 0023](../adr/0023-vultr-deployment.md) 결과 절 · [ADR 0019](../adr/0019-aws-personal-deployment.md).
- 상태: 2026-11-03 02:30 KST 컷오버 끝. 운영본은 Vultr(24시간), AWS `my-macro-app`은 `PAPER_ENABLED=false`로 정지, EventBridge 일정 6개 DISABLED.
  사용자가 2026-11-03에 "이 작업을 다른 세션에서 진행"하라고 했다 — 한 주 대기(명세 §7의 D5)를 사용자가 앞당긴 것으로 본다. **되돌릴 수 없는 삭제(아래 1단계)는
  시작 직전에 한 번 더 사용자에게 확인을 받는다**(CLAUDE.md '큰 변경은 설명하고 동의를 받은 뒤').

## 0. 먼저 읽을 것·지킬 것

- CLAUDE.md 절대 규칙 전부. 특히: 공개 저장소라 계정 고유 값(인스턴스 ID·배포판 ID·버킷 이름·IP)은 문서·커밋에 적지 않는다 — 값은 로컬 `.env`와 메모리
  `aws-personal-deploy-status.md`·`aws-public-url.md`에 있다. 이모지 금지. 커밋은 `type(scope): 한국어 요약` + `Co-Authored-By`.
- 브랜치 `claude/aws-cleanup-2026-11`에서 하고, 끝나면 `main`에 fast-forward 병합 → push → CI 6개 job 확인 → 커밋 번호와 함께 보고. 옮기는 커밋과 고치는 커밋을 나눈다.
- AWS 작업은 AWS MCP(`aws___run_script`, 계정은 메모리의 서울 리전)로 한다. **건드리지 않는 것**: 포트폴리오 데모 자원 전부(`portfolio-*` 인스턴스·RDS·일정 4개·EIP·CloudFront 배포판 3개),
  백업 버킷(`my-macro-backups-*` — Vultr가 `db/vultr/`에 계속 씀), 예산 `my-macro-monthly-45usd`, IAM 사용자 `my-macro-vultr-backup`(Vultr 백업용), SSM 세션 설정 문서
  `SSM-SessionManagerRunShell`(계정·리전 전체에 적용 — 그대로 둔다).
- Vultr 서버·로컬 v1·v3 스택은 건드리지 않는다. 이 작업은 Vultr에 배포할 코드 변경(2단계)을 포함하므로 끝에 `bash scripts/vultr/deploy.sh`까지 한다.

## 1. AWS 자원 삭제 (저장소 밖, 되돌릴 수 없음 — 사용자 확인 뒤)

순서대로. 각 단계는 지우기 전에 Describe로 대상이 맞는지(이름·태그 `Project=my-macro`) 확인하고, 지운 뒤 다시 조회해 없어졌는지 확인한다.

1. **마지막 덤프 확인**: S3 `db/macrodash-20261102-172914.sql`(컷오버 직전 AWS 백업, 02:28 KST)이 버킷에 있는지 `HeadObject`로 확인한다. 이것이 AWS 운영본의 마지막 기록이다.
   인스턴스를 켜서 새로 덤프하지 않는다(정지 뒤 쓰기가 없고, 켜면 수집기가 외부 출처를 다시 부른다). 60일 만료 대상이므로 사용자에게 "남겨 둘지"를 물어, 남기면
   같은 버킷의 `db/aws-final/` 아래로 복사한다(ADR 0020의 `db/v1-final-20261031.sql` 선례 — 수명주기 규칙이 접두어 전체에 걸리면 복사해도 만료되니 규칙을 먼저 본다).
2. **EventBridge Scheduler 일정 6개 삭제**: `my-macro-start`·`my-macro-stop`·`my-macro-day-start`·`my-macro-day-stop`·`my-macro-sun-start`·`my-macro-sun-stop`(모두 DISABLED 상태).
   실행 역할 `my-macro-scheduler`도 삭제(인라인 정책 먼저). 데모 일정 `portfolio-*`는 그대로.
3. **CloudFront 배포판** "my-macro v2 public (ADR 0019 #16)" 삭제: Disable → Deployed 될 때까지 기다림(수 분) → Delete. OAC(안내 버킷용) 삭제.
   안내 버킷 `my-macro-offline-*`: 객체(`_offline/*`) 비우고 삭제. 포트폴리오 배포판 3개는 건드리지 않는다.
4. **EC2 `my-macro-app` 종료**(stopped 상태에서 TerminateInstances). 루트 EBS는 `DeleteOnTermination`이면 같이 사라진다 — 종료 뒤 남은 볼륨이 있으면 지운다.
   탄력적 IP(`my-macro-app-eip`) 연결 해제·해제(ReleaseAddress). 보안 그룹 `my-macro-ec2`(8301 ← CloudFront prefix list 규칙 하나)는 인스턴스 종료 뒤 삭제.
5. **IAM 역할·인스턴스 프로필 `my-macro-ec2`** 삭제(프로필에서 역할 떼기 → 인라인 정책 삭제 → 관리형 정책 분리 → 역할·프로필 삭제).
6. **GitHub 배포 키** `my-macro-app`(AWS 서버용, 읽기 전용, 메모리에 id 있음)을 `gh api -X DELETE repos/Jinyoung-Kang/My_macro_dashboard_v2/keys/<id>`로 삭제.
   Vultr용 `my-macro-app-vultr`는 남긴다.
7. **사용자에게 알릴 것(사용자가 하는 일)**: 토스 개발자 콘솔 허용 IP에서 AWS 탄력적 IP를 빼도 된다(Vultr IP는 이미 등록). 로컬 `.env`의 `AWS_INSTANCE_ID` 줄과
   v1 폴더의 `.env.public-access`(접근 코드 평문)는 사용자 파일이라 지우지 않고 "지워도 된다"고만 알린다.
8. 끝나면 비용 탐색기나 `ListInstances`·`ListSchedules`·`ListDistributions`로 `Project=my-macro` 자원이 백업 버킷·예산·Vultr 백업 IAM 사용자뿐인지 확인해 보고에 적는다.

## 2. 저장소 정리 (단계 D의 코드·문서)

### 2-1. AWS 전용 파일 삭제와 참조 정리

지울 것: `scripts/aws/`(6개), `deploy/aws/`(Caddyfile·gate·offline·trusted_proxies.caddy), `compose.aws.yml`, `.env.aws.example`.

같이 고칠 것(지우면 테스트·CI가 깨지는 곳 — `/usr/bin/grep -rn "scripts/aws\|compose.aws\|deploy/aws\|env.aws.example\|aws_scripts"`로 다시 확인):

- `.github/workflows/ci.yml`: 'AWS 덧붙임 해석' 단계(compose.aws.yml·Caddyfile 해석, 97~99행 gate 시험 포함) 삭제. Vultr 덧붙임 해석 단계는 남긴다.
- `Makefile`: `test-gate` 타깃 삭제(187행)과 `test:` 의존(146행)·`.PHONY`(37행)에서 제거.
- `collector/tests/test_aws_scripts.py` 삭제. 단 `test_vultr_scripts.py`가 이 파일의 가짜 실행 파일(`_FAKE_DOCKER` 등)·`_git`·`_run`·`_env`·`SECRET`을 import한다 —
  그 공용 부분을 `collector/tests/fake_server_tools.py`(이름은 자유) 같은 모듈로 옮기고 Vultr 시험이 그것을 쓰게 한다(옮기는 커밋 따로).
- `collector/tests/test_deploy_migrations.py`: `OVERLAYS`에서 `compose.aws.yml` 제거, README '### AWS 개인용 서버' 절을 보는 `_aws_readme_blocks`와 그 시험을 Vultr 절로 바꾸거나 삭제.
- `collector/tests/test_secret_files_ignored.py`: `.env.aws.example`은 목록에서 빼고, `.env.aws`가 무시되는지는 남겨도 된다(`.gitignore`의 `.env.*` 규칙 확인).
- `frontend/src/lib/__tests__/noEmoji.test.ts` 93~94행 `REPO_FILES`에서 `compose.aws.yml`·`.env.aws.example` 제거(`scripts/aws` 글롭이 있으면 그것도).
- `backend/src/test/.../RegimeLogServiceTest.java`·`CorsOriginsTest.java`: AWS를 언급하는 주석·DisplayName만 손본다(동작은 Vultr도 같음 — 기록 23시·터널 출처). 테스트 자체는 지우지 않는다.
- `.gitleaksignore`: CI의 가짜 `GATE_SECRET` 지문(커밋 49694b27 쪽) 줄은 지난 커밋에 대한 것이라 **그대로 둔다**(지우면 과거 커밋 스캔이 다시 잡힘).
- `.env.example`: `AWS_INSTANCE_ID` 블록 삭제.
- `scripts/vultr/*.sh` 머리말의 "scripts/aws에서 갈라냈다" 같은 문구는 사실 기록이라 두되, 없는 파일을 "참고"로 가리키는 줄만 고친다.

### 2-2. 문서

- `docs/adr/0019-aws-personal-deployment.md`: 상태를 `superseded by 0023 (2026-11-03 컷오버, 자원 삭제 YYYY-MM-DD)`로. 본문은 지우지 않는다(기록).
- `docs/adr/0023-vultr-deployment.md` 결과 절에 단계 D 완료 한 줄(날짜·지운 자원 종류·남긴 것).
- `docs/specs/2026-11-02-vultr-migration.md` §7에 "끝(날짜)" 표시.
- `CLAUDE.md`: 명령 절의 AWS 줄(가동 창·SSM·CloudFront 설명)과 '절대 규칙'의 "AWS를 다시 켜도…" 문장, '이 환경의 함정'의 AWS 예외 문구를 Vultr 한 곳 기준으로 줄인다.
  v1·v3·포트폴리오 데모를 건드리지 않는다는 문구는 남긴다.
- `docs/DEVELOPMENT.md` §7(AWS 개인용 서버) 삭제 — §8(Vultr)이 §7이 되면 CLAUDE.md·다른 문서의 "§8" 참조도 같이.
- `docs/ARCHITECTURE.md`·`README.md`: AWS 배포 절·"AWS 2 vCPU면 1" 같은 문구를 Vultr로.
- `docs/DATA_SOURCES.md` 592행 근처: 토스 허용 IP가 "서버는 탄력적 IP — ADR 0019 결정 15"로 되어 있다 → "서버는 Vultr 공인 IP(ADR 0023)".
- `docs/API.md`·한국 책 명세의 늦음 기준 문구는 2-3에서 같이 고친다.

### 2-3. 한국 관측치 늦음 기준을 24시간 서버에 맞춤 (코드 — 고치는 커밋)

문제: [KrPaperMarket.java:80](../../backend/src/main/java/com/macrodash/feature/paper/KrPaperMarket.java) `SERVER_BOOT_NEW_YORK`(뉴욕 09:20)·`SERVER_BOOT_ZONE`이 `quotesLateAt`(같은 파일 283행 근처)에서
다음 수집 예정 E = max(D′ 20:30 KST, D′ 뉴욕 09:20)로 쓰인다. AWS 밤 창 기동 시각(명세 §9 F4, 2026-10-29)을 넣은 것이라 Vultr(24시간)에서는 늦음 판정이 실제보다 약 3시간 느슨하다
(겨울 D′+1 01:25에야 늦음 — 24시간 서버는 20:30 뒤 첫 slow 수집에 받으므로 그보다 훨씬 전에 알아야 한다).

고칠 것:
1. E = D′ 20:30 KST 하나로(`COLLECT_AFTER`). `SERVER_BOOT_NEW_YORK`·`SERVER_BOOT_ZONE` 상수와 주석 삭제. `QUOTES_LATE_MARGIN`(2시간 5분 = 기동 직후 slow와 그 다음 slow)은
   24시간 서버에서 "20:30 뒤 첫 slow + 그 다음 slow"로 뜻이 같으니 값은 두되, slow 주기를 `collector/app/main.py`·settings에서 확인해 주석의 근거를 다시 적는다.
   결과: 늦음 = D′ 22:35 KST(겨울·여름 같음). 서머타임 분기 없음.
2. 테스트: `KrPaperMarketTest` 227~251행(늦음 경계 — 23:20/22:20 기동·01:25/00:25·2027-03 서머타임 주)과 `KrCollectionStatusTest` 43·124~164행(01:25 경계)을 새 경계(22:35)로.
   재현 커밋이 필요한 결함은 아니고(QA 번호 없음 — 설계 변경), ADR 0023 결과 절에 결정으로 적는다. `TestKrMarket`·`KrStartTest`의 `quotesLateAt` 사용처도 본다.
3. 문서: 한국 책 명세 §4-9 시각표(848~877행 — "서버 창" 문구와 F4 줄)·§9 F4·1846행 표에 "2026-11-XX 24시간 서버로 E = D′ 20:30 하나(F4 되돌림)" 추가. `docs/API.md` 관측치 요약의
   `stale` 설명(280행 근처)에 뉴욕 09:20이 있으면 고친다. 1257행 "저장은 S 21:55(서버 기동)~22:30 사이" 같은 AWS 창 전제 문장도 "22:30 한국 결정 전"으로.
4. 화면·API 응답 스키마는 바뀌지 않는다(값만 당겨짐). 운영 영향: 배포 직후 한국 저장본이 그날 22:35를 지났는데 새 저장본이 없으면 바로 '늦음' 배지가 뜬다 — 배포 뒤 서버에서
   `GET /api/paper/status?market=KR`의 `quotes.stale`을 보고 보고에 적는다(밤 20:30 뒤 수집이 정상이면 false).

### 2-4. 확인·배포

- `make test` 전부 통과. 이 PC(WSL)의 `java -version`은 25라 CI(Temurin 21)와 다르다 — 두 판 모두에서 컴파일되게 쓰고 CI 6개 job으로 최종 확인.
- Vultr 배포: `ssh ubuntu@<tailnet IP>`(메모리 `vultr-server-2026-11.md`, `getent hosts my-macro-app`) → `bash ~/My_macro_dashboard_v2/scripts/vultr/deploy.sh`. 배포 뒤 컨테이너 healthy·백엔드 ERROR 0·
  `paper/status` KR `quotes.stale` 값·디스크 사용률을 보고에 적는다. 배포는 준비되면 바로(메모리 `deploy-when-ready.md`).
- 메모리 갱신: `aws-personal-deploy-status.md`·`aws-public-url.md`를 "YYYY-MM-DD 삭제 끝(남은 것: 백업 버킷·예산·Vultr 백업 IAM 사용자)" 한 줄로 줄이고 `MEMORY.md` 색인도 고친다.
  `v2-program-status.md`의 main 커밋 번호 갱신.

## 3. 보고 형식

1단계(지운 자원 목록과 남긴 자원), 2단계(커밋 번호·CI 결과·배포 결과·`quotes.stale`), 사용자가 할 일(토스 허용 IP·로컬 `.env` 줄·`.env.public-access`) 세 묶음으로.
