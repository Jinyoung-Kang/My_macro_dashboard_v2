# 0019. AWS 개인용 배포 — EC2 한 대(t4g.medium) + Postgres 컨테이너, 밤 시간 창(KST 21:55~08:00)만 가동, 접속은 SSM 포트 포워딩(인바운드 0), 앞단 Caddy는 루프백 8201 하나

- 상태: 채택 (2026-10-26). 같은 날 가동 시간을 24시간에서 밤 시간 창으로 바꿈(결정 14, 사용자 결정). 2026-10-27 공인 IPv4를 자동 할당에서 탄력적 IP로 바꿈(결정 15, 사용자 승인 — 토스 허용 IP). [ADR 0018](0018-paper-trading-guardrails.md)의 "AWS 개인용 배포는 별도 ADR로"가 이 문서입니다.
  v3에서 옮겨 온 공개 데모 배포([ADR 0012](0012-aws-demo-deployment.md)·[0013](0013-demo-viewer-mode.md)·[0014](0014-aws-demo-ai-report.md))는
  이 저장소에서 쓰지 않습니다 — `compose.aws.yml`을 개인용으로 다시 썼습니다. 같은 출처(`NEXT_PUBLIC_API_BASE=/`)와 프록시 IP 신뢰는 0012의 정의를 그대로 씁니다.
  2026-10-26: v2(`My_macro_dashboard_v2`)로의 교체는 [ADR 0020](0020-v2-program.md)·계획서 §5 — 교체 전까지 서버는 v1이고, 서버 폴더·볼륨 이름은
  교체 뒤 `~/My_macro_dashboard_v2`·`my_macro_dashboard_v2_postgres-data`. v2의 세션 쿠키는 `my_macro_v2_session`.
- 지키는 방법:
  - CI `images` 잡의 'AWS 덧붙임 해석' 단계: 서버 `.env`에 로컬 값이 섞인 경우를 흉내 낸 가짜 값으로 `compose.aws.yml`을 합쳐 해석 —
    공개 포트는 모두 `127.0.0.1`, caddy는 `8201` 하나, postgres 서비스 유지, backend `COOKIE_SECURE=true`(기본값)·`DASHBOARD_LOCAL_NO_LOGIN="false"`·
    `MAIL_HOST` 빈 값·허용 출처와 메일 링크는 터널 주소·데모 열람 토큰 없음, 화면 빌드 인자 `NEXT_PUBLIC_API_BASE=/`, Caddyfile 문법(`caddy validate`)
  - `collector/tests/test_aws_scripts.py`(스크립트 시험): 네 스크립트의 문법·`set -eu`, `deploy.sh`(폴더 이름·Caddyfile·서버 `.env`에 적지 않는 이름·
    서버에서 고친 파일이면 멈춤, 빌드는 backend → frontend → collector 하나씩, 빌드 실패면 기동하지 않음, 스키마 10번 실패면 0이 아닌 값,
    기동 뒤 caddy 다시 만들기, 물려받은 umask와 상관없이 0644), `backup-s3.sh`(이번에 만든 파일 하나만 `db/`에 — 이름이 더 늦은 옛 파일이 있어도,
    실패는 syslog err와 0이 아닌 값, `.env` 해석 오류의 값은 syslog에 없음), `tunnel.sh`(`AWS_INSTANCE_ID`·로그인 확인, 포트 포워딩 인자,
    잠깐 AWS에 닿지 않아도 돌아오면 다시 이음, 로그인 만료·연달아 곧바로 끊기면 멈춤, 8201을 쓰고 있으면 열지 않음, 서버가 꺼져 있으면
    켜는 방법을 알림), `instance.sh`(상태 한 줄, 켜고 running까지 기다림, 정기 가동 시간에는 `--force` 없이 끄지 않음 — 토요일은 10:00까지).
    모두 가짜 `docker`·`aws`·`make`·`date`로 돌아 AWS·DB가 필요 없습니다.
  - `collector/tests/test_deploy_migrations.py`: README의 서버 절차는 `deploy.sh`, `compose.aws.yml` 머리말의 손 배포도 `up -d` 뒤 스키마 적용(QA-016·107·118)
  - `CorsOriginsTest`(터널 화면의 POST만 같은 출처), `RegimeLogServiceTest`(기록 시각 23시면 가동 창 안에서 하룻밤에 한 번 — 기본 18시면 켜자마자 기록),
    `frontend/src/lib/__tests__/api.test.ts`(`NEXT_PUBLIC_API_BASE=/`). CI 덧붙임 해석은 postgres `stop_grace_period` 30초·기록 시각 23시도 봅니다.
  - 켜기·끄기 일정(EventBridge Scheduler)은 AWS 쪽 자원이라 저장소 시험이 없습니다 — 만든 뒤 첫 사이클(21:55 기동 → 08:00 정지)을 확인해 아래 결과에 적습니다.

## 배경

🧪 모의 매매(ADR 0018)는 5분마다 리스크를 보고, 07:30 KST에 정기 결정을 내리고, 미국 장중 봉을 받습니다. 맥이 잠들거나 꺼진 동안에도
돌아야 해서 미국 장·결정 시각에 켜져 있는 서버가 필요합니다. 쓰는 사람은 운영자 한 명입니다. 처음에는 24시간으로 셈했고, 사용자가 밤 시간 창
(KST 21:55~08:00)만 켜기로 정했습니다(결정 14) — 모의 매매에 필요한 일이 모두 그 안에 있습니다.

비용을 비교했습니다(②-b, 서울 리전 기준 월 추정).

| 안 | 월 비용 | 버린 이유 |
|---|---|---|
| v3 데모 사양 그대로 켜기(EC2 m7i-flex.large + RDS + CloudFront) | 약 $114 | 사용자 1명에 공개 데모 구성 — 비싸고, 모의 매매가 공개 데모에 섞임 |
| GCP 비슷한 사양 | 약 $39 | 비용은 비슷하고 계정·예산·운영 경험이 AWS에 있음 |
| 이 안을 24시간 | 약 $37 | 모의 매매에 필요한 일은 밤 10시간 안에 끝남 |
| **이 안: EC2 t4g.medium + Postgres 컨테이너, 밤 10시간(결정 14)** | **약 $17** | — |

v3 데모 덧붙임(`compose.aws.yml`)은 공개 데모용이었습니다 — RDS·CloudFront·접근 코드 잠금화면·데모 열람(0013)·Haiku 고정과 방문자 공용 한도(0014)·
`store_only`. 개인용에는 하나도 필요 없고, 데모 열람이 켜지면 모의 매매 화면까지 로그인 없이 읽힐 자리가 생깁니다.

## 결정

1. **서버**: EC2 `my-macro-app` 한 대 — t4g.medium(ARM, 2 vCPU · 4 GiB), Ubuntu 24.04 LTS arm64(만들 때 SSM 공개 파라미터
   `/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id`의 최신), ap-northeast-2a 기본 VPC, 루트 gp3 30 GB 암호화,
   IMDSv2 필수(응답 hop limit 1 — 컨테이너는 IMDSv2 토큰을 받지 못해 인스턴스 역할의 자격 증명을 꺼내지 못함), 키페어 없음, 공인 IPv4(나가는 통신용 — 처음엔 자동 할당, 2026-10-27부터 탄력적 IP, 결정 15), 태그 `Project=my-macro`. 첫 기동 준비는 user-data `scripts/aws/bootstrap.sh`
   (Docker 공식 저장소의 docker-ce·compose 플러그인, AWS CLI v2, git·make, 2 GiB 스왑, journald 상한, ubuntu 사용자를 docker 그룹에).
2. **DB**: RDS가 아니라 **postgres 컨테이너**(기반 `docker-compose.yml` 그대로, PostgreSQL 16). 볼륨 이름은 폴더 이름을 따른
   `my_macro_dashboard_v1_postgres-data`라 서버의 저장소 폴더도 `~/My_macro_dashboard_v1`입니다.
3. **들어오는 길은 SSM Session Manager 하나**: 보안 그룹 `my-macro-ec2`는 인바운드 규칙 0개 · 아웃바운드 전체. 화면은 PC의 `scripts/aws/tunnel.sh`가
   여는 포트 포워딩(`AWS-StartPortForwardingSession`, 서버 8201 → PC 8201)으로 `http://localhost:8201`에서 열고, 관리 셸은 `aws ssm start-session`
   (붙은 뒤 `sudo -iu ubuntu`). v3 데모의 관리자 터널(0012, QA-136)과 같은 방식입니다. 유휴 제한은 세션 설정(`SSM-SessionManagerRunShell`)에서 60분으로 올리고,
   끊기면 `tunnel.sh`가 다시 잇습니다.
4. **IAM**: 역할·인스턴스 프로필 `my-macro-ec2` = `AmazonSSMManagedInstanceCore` + 인라인 정책(백업 버킷 하나에만 `PutObject`·`GetObject`·`ListBucket`·`DeleteObject`).
   `DeleteObject`는 `bootstrap/` 아래에만 줍니다 — 서버가 지울 것은 `.env` 전달 객체뿐이고, 서버가 뚫려도 `db/` 백업을 지우지는 못합니다(같은 키로 덮어써 없애는 것은 막지 못함 — 아래 남은 위험).
   GitHub에서 코드를 받는 것은 이 저장소 하나만 읽는 **배포 키**(ed25519, 쓰기 권한 없음, 제목 `my-macro-app`)입니다. PC의 GitHub 토큰은 서버에 두지 않습니다.
5. **S3** `my-macro-backups-<임의 8자>`: 퍼블릭 차단, SSE-S3, 수명주기 60일 만료. 쓰임은 둘 — DB 백업(`backup-s3.sh`, cron 매일 21:10 UTC = 06:10 KST,
   `make backup`이 만든 파일 하나만 `db/`에, 실패는 syslog)과 서버 `.env`의 1회 전달(서버가 받아 `chmod 600` 한 뒤 객체를 바로 지움).
6. **앞단 Caddy**: compose 서비스 `caddy`(`caddy:2-alpine`, `deploy/aws/Caddyfile`). 공개 포트는 `127.0.0.1:8201:8201` 하나, `auto_https off`, TLS 없음 —
   평문은 서버의 루프백과 SSM 터널(암호화) 안에서만 흐릅니다. `/api/*`는 backend:8080, 나머지는 frontend:3000. `X-Forwarded-For`는 Caddy 기본
   (`trusted_proxies`를 두지 않아 들어온 값을 믿지 않고 접속 주소로 채움).
7. **덧붙임 `compose.aws.yml`(개인용)**: postgres 유지, caddy 추가, `DASHBOARD_LOCAL_NO_LOGIN: "false"` 고정, `COOKIE_SECURE` 기본 true,
   `FRONTEND_ORIGIN=http://localhost:8201,http://127.0.0.1:8201`, `PUBLIC_URL=http://localhost:8201`, `SERVER_FORWARDHEADERSSTRATEGY=native`,
   `MAIL_HOST` 빈 값, 화면 빌드 인자 `NEXT_PUBLIC_API_BASE=/`. 백엔드의 `FRONTEND_PORT`도 `8201`로 고정합니다 — 백엔드는 허용 출처에
   `http://*:화면 포트`를 더하는데(ADR 0006), 기본 3000이면 PC에서 3000번으로 뜬 다른 개발 서버(같은 사이트 `localhost`라 `SameSite=Strict`
   쿠키도 실림)의 쓰기까지 받습니다. 데모용(RDS·CloudFront·데모 열람 토큰·`AI_ENGINES` 고정·`AI_DEMO_DAILY_LIMIT`·`store_only`·
   Hikari 4·AI 대기 110초·무료 엔진 키 비우기·국면 판정 17시)은 모두 뺐습니다 — 모의 매매 결정은 Sonnet 5.5, AI 허용 목록·읽기 모드는 `.env`대로입니다.
   가동 창에 맞춰 국면 판정 기록은 23시, postgres는 꺼질 때 30초까지 기다립니다(결정 14).
8. **서버 포트는 기본값**(127.0.0.1의 3000/8080/8000/5432). 서버 `.env`는 로컬 `.env`에서 포트 네 줄·`COOKIE_SECURE`·`LOCAL_NO_LOGIN`·`FRONTEND_ORIGIN`·
   `PUBLIC_URL`·`AWS_INSTANCE_ID`를 빼고 `COMPOSE_FILE=docker-compose.yml:compose.aws.yml`·`AWS_BACKUP_BUCKET`을 더한 것입니다(`.env.aws.example`).
   `deploy.sh`는 빠져야 할 이름이 있으면 배포하지 않습니다(`COOKIE_SECURE`·`PAPER_ENABLED`는 막지 않고 알리기만 — 결정 10·12의 되돌림 자리). 전환 뒤 로컬 `.env`의
   `PAPER_ENABLED=false`도 서버로 옮기지 않습니다(서버는 비우면 켜짐 — 전달 명령이 거름, 결정 12).
9. **배포는 `scripts/aws/deploy.sh`**(서버에서 `make up` 대신): git main fast-forward → 버전 → 이미지를 **하나씩** 빌드(backend → frontend → collector,
   4 GiB라 동시 빌드 금지) → `up -d --wait` → 스키마 적용(QA-016) → caddy 다시 만들기(Caddyfile은 파일 하나를 bind mount해 git이 바꾼 새 파일을
   돌던 컨테이너가 보지 못함) → 오래된 이미지 정리. 실패하면 0이 아닌 값.
10. **세션 쿠키 `Secure`는 기본 true**: Chrome·Firefox(75+)는 `http://localhost`·`http://127.0.0.1`을 안전한 출처로 봐 Secure 쿠키를 받습니다.
    Safari(WebKit)는 2026-10 현재 받지 않습니다(WebKit 버그 232088·218980이 열려 있음) — 로그인이 오류 없이 되풀이됩니다. 쓰는 브라우저가 터널 화면에서
    로그인 쿠키를 받지 못하면 서버 `.env`에 `COOKIE_SECURE=false`를 적고 이 절에 기록합니다(평문은 양쪽 루프백에만, 그 사이는 SSM이 암호화).
11. **로그인 제한은 그대로**: 터널로 들어온 요청은 모두 같은 주소(도커 브리지 게이트웨이)로 보여 (접속 주소, 이메일) 기준 지연이 사실상 이메일별이 됩니다.
    사용자 1명이고 들어오는 길이 IAM으로 인증된 터널뿐이라 그대로 둡니다.
12. **모의 매매 상태는 EC2 한 곳에만**: 데이터 전환(로컬 `make backup` → S3 → 서버 `make restore`) 뒤 로컬 v1은 `.env`에 `PAPER_ENABLED=false`로 띄웁니다.
    두 곳이 동시에 결정·체결하는 일은 없어야 합니다(같은 계좌를 두 장부가 따로 움직임). 전환은 07:30 KST 정기 결정이 끝난 뒤 그날 22:30 KST 전에 합니다(미국 장 밖 —
    장중은 서머타임 22:30~05:00, 11월~3월 23:30~06:00 KST).
    순서는 **로컬 정기 작업을 먼저 끄고**(`PAPER_ENABLED=false` → `make up`) 백업합니다 — 백업 뒤 로컬에 결정·체결이 더 쌓이지 않고, 서버가 복원을 마치는
    순간에도 두 곳이 겹치지 않습니다. 서버 확인이 안 되면 **서버 정기 작업을 먼저 끄고**(서버 `.env`에 `PAPER_ENABLED=false` → `docker compose up -d backend`,
    다음 `deploy.sh`도 켜지 않고 알림) 로컬의 그 줄을 지워 되돌립니다(로컬 DB는 백업 시점 그대로). 컨테이너를 멈추는 것(`stop`)만으로는 다음 배포가 다시 켭니다.
13. **비용** 월 약 $19(탄력적 IP 전 $17) — 인스턴스 $12.7(t4g.medium $0.0416/시간 × 하루 10시간 × 30.4일) + 토요일 2시간 더 약 $0.4 + 디스크 $2.7(gp3 30 GB, 꺼져 있어도 붙음)
    + 공인 IPv4 $3.6(2026-10-27부터 탄력적 IP — 꺼져 있어도 시간당 $0.005가 붙음. 그 전 자동 할당은 켜진 동안만 약 $1.5) + S3 소액 + EventBridge Scheduler(월 무료 사용량 안). 24시간이면 약 $37이었습니다.
    예산 `my-macro-monthly-45usd`(COST, 계정 전체, 실제 비용 80%·100% 알림)를 새로 둡니다. t4g는 기본이 무제한 크레딧이라 기준선(vCPU당 20%)을 오래 넘기면
    추가 요금 — CloudWatch `CPUSurplusCreditsCharged`가 0인지 봅니다.
14. **가동 시간은 밤 창 — 매일 KST 21:55 켜고 08:00 끔(토요일만 10:00)**(2026-10-26 사용자 결정). EventBridge Scheduler 세 개(시간대 `Asia/Seoul`)가
    범용 타깃으로 EC2 API를 바로 부릅니다(Lambda 없음): `my-macro-start` `cron(55 21 * * ? *)` → `ec2:startInstances`, `my-macro-stop`
    `cron(0 8 ? * SUN-FRI *)` → `ec2:stopInstances`, `my-macro-stop-sat` `cron(0 10 ? * SAT *)`. 실행 역할 `my-macro-scheduler`는 그 인스턴스 하나에만
    `ec2:StartInstances`·`StopInstances`(신뢰는 `scheduler.amazonaws.com`, 같은 계정 조건). 실패하면 1시간 안에 세 번 다시 시도합니다.
    창 안에 들어가야 하는 것과 근거:

    | 일 | 시각(KST) | 창 안인가 |
    |---|---|---|
    | 미국 정규장 | 23:30~06:00(11월~3월), 서머타임 22:30~05:00 | 켜고 35분(서머타임) 뒤 개장, 닫고 2시간 뒤 정지 |
    | 마지막 지연 봉(확정 종가) | 마감 + 15분 뒤 수집 → 06:15~06:20, 리스크 작업(5분)이 처리 | 정지 1시간 40분 전 |
    | DB 백업(cron) | 06:10(21:10 UTC) | 창 안 — 11월~3월에는 확정 종가 처리(06:15~06:20) 전이라 그 몫은 다음 날 백업에 |
    | 정기 결정 | 07:30부터(10분 주기, Claude 한 번 최대 5분) — 실패하면 08:00 전에 두 번 더 | 정지 30분 전 |
    | 국면 판정 기록 | 23:00 뒤 첫 실행(30분 주기 → 23:2x) | 기동 뒤 수집이 한 바퀴 돈 뒤 — 기본 18시면 켜자마자 08:00에 멈춘 저장본으로 기록 |
    | 주간 복기 | 토요일 09:00 뒤 첫 실행(30분 주기) | 토요일만 10:00 정지 |

    - 주간 복기 시각(토 09:00)은 설정이 아니라 코드 상수(`ReviewFacts.OPENS_AT`)라 창 안(07:45)으로 옮기지 못해 **토요일 정지를 늦췄습니다**. 처음 안은 09:30이었지만,
      복기 작업이 기동(21:55 + 몇 분) 뒤 30분 주기로 돌아 09:00 뒤 첫 실행이 09:29~09:30에 걸릴 수 있어 10:00으로 둡니다(월 $0.1 미만 차이). 그래도 놓치면 다음 기동 때
      그 주 복기를 냅니다(PaperReviewJob의 '놓친 토요일').
    - 결정 마감(12:00 KST, `decisionDeadlineKst`)은 그대로 둡니다 — 창을 지키는 것이 원칙이고 마감은 안전장치입니다. 창 밖에서 마감이 지나면 다음 기동 때 처리합니다.
    - 매일 아침 정지는 OS 종료 → dockerd가 컨테이너를 멈추는 순서라, postgres에 `stop_grace_period: 30s`를 줍니다(기본 10초면 강제 종료 뒤 복구부터 함).
      다시 켜지면 `restart: unless-stopped`가 컨테이너를 다시 띄웁니다(순서 보장은 없어 DB가 준비될 때까지 백엔드·수집기가 몇 번 다시 뜰 수 있음).
    - 창 밖(주말 낮 등)에 볼 때는 PC에서 `bash scripts/aws/instance.sh start` — 다음 정지 일정에 꺼집니다. `instance.sh stop`은 창 안에서 `--force` 없이 끄지 않습니다.
    - 국내 장중(09:00~15:30 KST) 수집은 서버에서 돌지 않습니다. 켜진 뒤 일별 자료로 따라잡고, 장중 화면은 로컬에서 봅니다.
15. **탄력적 IP**(2026-10-27, 사용자 승인): 토스증권 Open API는 콘솔에 등록한 허용 IP에서 온 요청만 받는데(토큰 발급부터 403 `IP address not allowed`),
    자동 할당 주소는 끌 때 반납돼 매일 바뀌므로 등록할 수 없습니다. 탄력적 IP(태그 `Project=my-macro`·`Name=my-macro-app-eip`)를 인스턴스에 붙이고
    그 주소를 토스 콘솔 허용 IP에 넣습니다. 들어오는 규칙은 여전히 없습니다(보안 그룹 인바운드 0 — 공인 IP에 앱 포트를 열지 않는 원칙 그대로).
    공인 IPv4 요금은 쓰는 중·쉬는 중 모두 시간당 $0.005(서울, AWS 가격 API로 2026-10-27 확인)라 월 약 $3.6 — 자동 할당보다 약 $2 더 듭니다.
    v2로 교체할 때(계획서 §5) 같은 인스턴스·같은 탄력적 IP를 그대로 쓰므로 토스 등록을 다시 할 일은 없습니다.

## 이유

- **인바운드 0 + SSM**: 인터넷에서 닿는 포트가 없어 스캔·대입 공격의 대상이 없습니다. 키페어·SSH 데몬 설정이 필요 없고, 접속은 IAM 로그인으로 인증되며
  CloudTrail에 남습니다. v3 데모에서 이미 써 본 방식이고, PC에 깔 것도 이미 있습니다(aws CLI · session-manager-plugin).
- **Postgres 컨테이너**: 가장 작은 RDS도 인스턴스·스토리지·백업 요금이 따로 붙는데, 사용자 1명에는 관리형 DB의 장점(자동 장애 조치·패치)보다 비용이 큽니다.
  로컬과 같은 판·같은 백업·복원 스크립트(ADR 0003)를 그대로 쓰고, 날마다 S3로 덤프를 옮깁니다.
- **t4g.medium**: 상주 메모리 상한(backend·collector 1g, postgres 512m, frontend 256m, caddy 128m)이 4 GiB 안에 들어갑니다. 빌드는 하나씩 + 스왑으로
  버팁니다(부족하면 잠시 t4g.large로 올려 빌드하고 되돌림). 같은 크기의 x86보다 싸고, 쓰는 베이스 이미지(Temurin·Node·Python·Postgres·Caddy)는 모두 arm64를 냅니다.
- **공인 IPv4 자동 할당(EIP 아님)**: 수집(외부 시장 데이터)·Anthropic API·GitHub·apt는 나가는 통신이 필요합니다. NAT 게이트웨이보다 훨씬 싸고, 들어오는 길이
  없어 고정 주소가 필요 없습니다. → 2026-10-27 바꿈: 나가는 쪽에도 고정 주소가 필요한 출처(토스 허용 IP)가 있었습니다(결정 15).
- **TLS 없는 Caddy**: 브라우저 ↔ PC의 session-manager-plugin은 루프백, PC ↔ 서버는 SSM이 암호화합니다. 인증서를 둘 이름(도메인)도 없습니다.

## 대안과 버린 이유

- **RDS**: 위 이유. 백업은 S3 덤프로 충분합니다.
- **데모 EC2(portfolio-app)에 얹기**: 데모 스택은 10-23부터 멈춰 있고 건드리지 않기로 했습니다. 켜면 m7i-flex.large 요금이고, 공개 데모와 개인 모의 매매가 한 호스트에 섞입니다.
- **NAT 게이트웨이 · IPv6 전용**: NAT 게이트웨이는 그것만으로 이 안 전체보다 비쌉니다. IPv6 전용 서브넷은 IPv4만 받는 곳(GitHub 등)에 닿으려면 결국 NAT64(NAT 게이트웨이)가 필요합니다.
- **Tailscale**: 처음 고른 안이었으나 뺐습니다. 2026-10-25 'Tailworm' 보고(CVE·패치 없는 미확인 보고)가 나왔고, 보고된 부위인 Tailscale SSH는 2026년에만
  보안 공지가 5건입니다. 서버에 상주하는 원격 접속 데몬을 하나 더 두는 위험을 지금 확인할 방법이 없습니다. Tailscale SSH를 끄고 쓰는 안도 같은 이유로 보류합니다.
- **WireGuard 직접**: UDP 포트 하나를 열어야 해서 인바운드 0이 깨지고 키를 따로 관리합니다. 터널을 띄우지 않고 늘 열려 있는 주소가 필요해지면 차선입니다.
- **Cloudflare Tunnel + Access**: 휴대폰에서 열어야 하면 후보입니다. 다만 TLS가 Cloudflare 엣지에서 풀려 화면·API 평문이 제3자 인프라를 지납니다.
- **공개 HTTPS + mTLS**: 443을 인터넷에 열고 서버·클라이언트 인증서를 관리해야 합니다. 사용자 1명에 노출 표면만 늘어납니다.
- **tailscale serve**: Tailscale을 빼면서 함께 뺐습니다.

## 결과와 남은 위험

- 저장소 쪽(덧붙임·스크립트·CI·시험)은 2026-10-26에 반영했습니다.
- 서버를 만든 결과(2026-10-26, 인스턴스·버킷 ID는 공개 저장소라 적지 않음):
  - bootstrap(user-data)이 첫 기동 70초 안에 끝남 — Docker 29.9.2 · compose 5.6.1 · AWS CLI 2.38.5(aarch64) · 스왑 2G. SSM 에이전트는 AMI의 snap 그대로 Online.
  - 첫 `deploy.sh`(세 이미지 arm64 빌드 포함) 약 6분, 메모리 부족 없음(t4g.large로 올릴 일 없었음). 상주 메모리 collector 613MiB · backend 202 · postgres 78 ·
    frontend 61 · caddy 10, 남은 메모리 약 2.2 GiB. 디스크 49%.
  - 터널 화면(curl): 로그인 200, 세션 쿠키 `Secure; HttpOnly; SameSite=Strict`를 받음, 쿠키 없는 운영 경로 401, 다른 출처(`http://localhost:3000`) 쓰기 403
    (`FRONTEND_PORT` 8201 고정이 막음). 브라우저 확인은 사용자 몫(Safari면 결정 10).
  - 서버 안에서 듣는 포트: 앱 포트는 모두 `127.0.0.1`. Ubuntu 기본 sshd가 `0.0.0.0:22`에서 듣지만 보안 그룹 인바운드 0·키페어 없음이라 닿지 않고 쓰지 않습니다.
  - 데이터 전환 2026-10-26 05:31 KST(월 — 직전 정기 결정은 10-24, 다음은 10-27 07:30이라 그 사이): 로컬 정기 작업을 먼저 끄고 백업(198 MB) → S3 → 복원.
    계좌 4개 순자산·현금이 로컬과 같음. 백업 cron 첫 수동 실행 190M이 S3 `db/`에 도착.
  - 2026-10-27: 전환 뒤 서버의 토스 태스크 세 개(`toss_market_flows`·`toss_stock_flows`·`toss_radar_universe`)가 토큰 발급 403 `IP address not allowed`로
    '수집 결과 없음'(저장본 유지)이었습니다 — 수급 자료가 10-26 05:25부터 새로 쌓이지 않음. 탄력적 IP를 붙이고(결정 15) 사용자가 토스 콘솔에 등록한 뒤
    서버에서 손으로 돌려 확인: 시장 2/2, 종목 40/40(800건), 레이더 94/100. 레이더 6종목은 401 `token-revoked` — 서버와 로컬 스택이 같은 토스 client를
    쓰기 때문입니다(client당 토큰 1개). 사용자 결정으로 키는 하나를 유지하고, 충돌한 종목은 이전 값을 이어받아 다음 실행에서 다시 받습니다.
- 21:55 기동이 실패하면(용량 부족 등 — 일정이 1시간 안에 다시 시도) 그날 밤 리스크 점검·결정이 빠집니다. 결정은 마감(12:00) 규칙대로 그날 주문 없음.
- 낮에 손으로 켜 두면 다음 정지 일정(08:00, 토 10:00)까지 계속 켜져 있습니다(시간당 약 $0.05).
- 서버가 한 대라 인스턴스·디스크 장애 때는 마지막 S3 백업(최대 하루 전)으로 돌아갑니다. 그 사이의 모의 매매 기록은 잃습니다.
- 버킷 버전 관리를 켜지 않아(지운 `.env`가 이전 버전으로 남지 않게), 서버를 빼앗은 사람은 `db/`의 백업 목록을 보고 같은 키에 빈 내용을 올려 모두 없앨 수
  있습니다(삭제 권한이 없어도 사실상 삭제). 막으려면 `db/` 백업만 버전 관리·Object Lock을 켠 다른 버킷에 두거나 조건부 쓰기(`If-None-Match`)만 허용해야 합니다 —
  사용자 1명·인바운드 0인 지금은 두지 않습니다. 그때의 마지막 보루는 로컬 v1 `backups/`의 전환 전 백업과, PC에서
  `aws s3 sync s3://<버킷>/db/ <폴더>`로 받아 둔 사본입니다.
- `gh repo deploy-key add`로 등록한 배포 키는 그때의 `gh` 인증 토큰에 묶여, 그 토큰을 끊으면 함께 지워집니다(서버 `git fetch`가 `Permission denied`).
- `X-Forwarded-For`를 믿는 범위는 Tomcat의 내부 대역 전체(같은 compose 네트워크의 컨테이너·서버 안 프로세스)입니다. 바깥에서 닿는 길은 Caddy뿐이고,
  서버 안에서 위조해 얻는 것은 로그인 지연 우회뿐입니다.
- 서버에서 `make up`을 치면 이미지를 한꺼번에 빌드합니다(4 GiB에서 메모리 부족 위험). `COMPOSE_FILE` 덕분에 덧붙임은 빠지지 않지만, 배포는 `deploy.sh`로 합니다.
- 터널을 열 때마다 PC에서 `aws login`이 살아 있어야 합니다. 세션이 만료되면 `tunnel.sh`가 멈추고 다시 로그인하라고 알립니다. 포트 포워딩 세션에도
  유휴 제한이 걸리는지는 AWS 문서에 없습니다(약 60분마다 끊긴다는 보고가 있음) — `tunnel.sh`가 다시 잇습니다.
- 메일을 꺼 두어 비밀번호 재설정이 없습니다. 로그인 비밀번호는 운영자 계정을 만들 때의 `APP_PASSWORD`(로컬 DB를 옮겼으면 로컬에서 계정을 만들 때의 값,
  화면에서 바꿨다면 그 값)입니다. 계정이 이미 있으면 서버 `.env`의 `APP_PASSWORD`는 읽지 않습니다.
- 쿠키는 포트를 가리지 않습니다. 같은 PC의 QA 스택(`localhost:13001`, 로그인 모드)과 세션 쿠키 이름(`my_macro_session`)이 같아 서로 로그아웃시킬 수 있습니다
  (로그인 없는 로컬 v1은 쿠키를 쓰지 않아 상관없음). 둘을 함께 쓸 때는 터널을 `http://127.0.0.1:8201`로 엽니다(허용 출처에 있음).
- 수집기 상주 메모리가 상한(1g)에 가깝습니다(로컬 실측 937MiB, 기동 43분 뒤). 넘치면 OOM으로 재시작돼 그 회차 수집만 빠집니다 — 서버에서 `docker stats`로 봅니다.
- t4g.medium은 vCPU가 2개라 비싼 계산 동시 실행 상한이 자동 1입니다(QA-131). 캐시가 빈 첫 화면에서 429가 잦으면 `.env`에 `COMPUTE_MAX_CONCURRENT=2`.
