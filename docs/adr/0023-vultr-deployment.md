# 0023. Vultr 서버로 이전 — Vultr 서울 vhf-2c-4gb 한 대를 24시간, 접속은 Tailscale 하나(공개 TCP 포트 0, 잠금화면 없음), AWS와 병행한 뒤 컷오버하고 AWS my-macro 자원은 한 주 뒤 정리

- 상태: 채택 (2026-11-03). **2026-11-03 02:30 KST 컷오버 — 운영본(모의 매매 정기 작업)은 Vultr**. 그 전의 AWS([ADR 0019](0019-aws-personal-deployment.md))는 정지 상태로 한 주 두기로 했다가 같은 날 사용자 결정으로 앞당겨 지웠습니다(단계 D — 결과 절).
  작업 목록은 [Vultr 이전 명세](../specs/2026-11-02-vultr-migration.md)(§8 사용자 결정 D1~D6). 포트폴리오 데모(portfolio-app·RDS·CloudFront 3개)는 AWS에 그대로 둡니다.
- 지키는 방법:
  - CI `images` 잡의 'Vultr 덧붙임 해석' 단계: 서버 `.env`에 로컬·옛 AWS 값이 섞인 경우를 흉내 낸 가짜 값으로 `compose.vultr.yml`을 합쳐 해석 —
    caddy를 포함해 모든 포트가 `127.0.0.1`이고 caddy는 `8201` 하나, gate 서비스·`ORIGIN_SECRET`·대역 파일 없음, `PUBLIC_ORIGIN`이 비면 해석 실패,
    허용 출처는 Tailscale 주소와 비상용 `localhost:8201`, 로그인 유지·`Secure` 쿠키 기본·메일 끔·같은 출처(`NEXT_PUBLIC_API_BASE=/`)·postgres 30초·국면 기록 23시,
    Caddyfile 문법(`caddy validate`).
  - `collector/tests/test_vultr_scripts.py`: 일곱 스크립트의 문법·`set -euo pipefail`, `tailscale-up.sh`(auth key는 stdin만, serve는 tailnet 안 — funnel 없음),
    `deploy.sh`(빌드 backend → frontend → collector → browser(ADR 0026의 브라우저 컨테이너) — gate 없음, CloudFront 대역 단계 없음, 서버 `.env`에 적지 않는 이름에 `ORIGIN_SECRET`·`GATE_*`·`VULTR_*`·
    `TAILSCALE_*`·`TAILNET_DOMAIN`, `PAPER_ENABLED=false`면 막지 않고 '주의'(끝 요약에도)·없으면 '참고: 정기 작업 켜짐'만 — QA-194, 빌드 뒤·기동 전 배포 전 덤프 `pre-deploy-…`(실패하면 기동하지 않음, postgres가 꺼져 있으면 그것만 먼저 띄움 — QA-200), QA-145 다시 돌기, 스키마 10번 실패면 0이 아닌 값, 끝 요약의 마지막 S3 백업 나이 — 36시간 넘거나 없으면 경고, 판정은 `make status`와 같이 쓰는 `backup-age.sh`, QA-199), `backup-s3.sh`(`db/vultr/`, 실패하면 텔레그램 한 줄 — 토큰은 curl 인자에 없음·값이 없으면 건너뜀·알림 실패가 종료 코드를 바꾸지 않음, 성공하면 `backups/.last-s3-ok` — QA-199),
    `make status`(마지막 S3 백업 나이 — 기록이 있을 때만 찍고 36시간 넘으면 경고, 수집기가 꺼져 있어도, `deploy.sh`와 같은 줄 — QA-199),
    `instance.sh`·`firewall-pc-ip.sh`(가짜 Vultr API — 새 22 규칙을 먼저 넣고 옛 규칙만 지움, 다른 규칙 그대로, API 키가 curl 인자에 없음, 401·403이면 콘솔 안내).
  - `collector/tests/test_deploy_migrations.py`(QA-107·118 머리말 손 배포·README 배포 명령을 Vultr 덧붙임에), `CorsOriginsTest`(QA-136 — Vultr 허용 출처),
    `RegimeLogServiceTest`(국면 기록 23시가 24시간 하루에 한 번), 비밀 파일·이모지 시험 목록. 공용 가짜 실행 파일은 `collector/tests/fake_server_tools.py`.
  - 한국 관측치 늦음 = 다음 거래일 D′ 20:30 KST + 2시간 5분(D′ 22:35): `KrPaperMarketTest`·`KrCollectionStatusTest`의 늦음 경계.
  - Tailscale 신원 자동 로그인(결정 10): `TailnetLoginTest`(비면 꺼짐·대소문자·공백), `SessionFilterTest` 'Tailscale 신원 자동 로그인'(맞는 신원만 운영자, 다른 신원·
    꺼짐은 로그인, 쿠키 없는 쓰기의 다른 사이트 출처 403, 화면 포트의 다른 호스트 `http://attacker.example:8201`도 403 — QA-171), `CorsOriginsTest`(켜지면 와일드카드 없음),
    `AuthControllerTest`(세션 응답 `noLogin`·`user.tailnet`), CI 'Vultr 덧붙임 해석'(기본 빈 값·서버 `.env` 값 전달).
  - Vultr 방화벽·Tailscale 설정·IAM 사용자는 저장소 밖 자원이라 시험이 없습니다 — 명세 §0·§5에 확인한 것을 적고, 바뀌면 이 문서의 결과에 적습니다.

## 배경

ADR 0019의 AWS 서버는 가동 창(평일 밤·평일 낮·일요일 밤)만 켜 월 약 $17이지만, 창 밖에는 화면을 볼 수 없고 창을 바꿀 때마다 일정·문서·스크립트를
함께 고쳐야 했습니다. AWS 계정은 포트폴리오 제출용으로 두고 개인 프로젝트는 따로 두려는 사용자 뜻도 있었습니다(2026-10-28 호스팅 탐색).
2026-11-02 사용자 결정: AWS·Vultr 둘 다 배포해 병행 → Vultr가 AWS처럼 정상 동작하면 컷오버 → AWS의 my-macro 자원 정리.

## 결정

1. **서버**: Vultr 서울(icn) vhf-2c-4gb(2 vCPU · 4 GB · 128 GB NVMe, 월 $24) 한 대, Ubuntu 24.04, 24시간. 자동 백업·DDoS 보호는 끔(DB 백업은 S3 — 결정 6).
   Postgres는 로컬·AWS와 같은 컨테이너, 폴더는 `~/My_macro_dashboard_v2`(compose 프로젝트·볼륨 이름). 첫 준비는 cloud-init `scripts/vultr/bootstrap.sh`
   (Docker 공식 저장소·AWS CLI·ubuntu 사용자·비밀번호 로그인 금지 — sshd 드롭인은 cloud-init의 `50-cloud-init.conf`보다 먼저 읽히게 `00-`).
   인스턴스 ID·IP·방화벽 그룹 ID는 계정 고유 값이라 저장소에 적지 않고 PC `.env`의 `VULTR_*`에만 둡니다.
2. **접속은 Tailscale 하나**(D1): 서버·PC·휴대폰이 같은 tailnet에 있고, 화면은 `https://my-macro-app.<tailnet>.ts.net`(MagicDNS + Tailscale이 받는 Let's Encrypt 인증서).
   서버의 `tailscale serve --bg --https=443 http://127.0.0.1:8201`이 HTTPS를 끝내고 루프백의 caddy로 넘깁니다(`scripts/vultr/tailscale-up.sh` — auth key는 stdin).
   `funnel`(공개)은 쓰지 않습니다. 셸은 Tailscale SSH(`ssh ubuntu@my-macro-app`). tailnet 이름은 계정 고유 값이라 PC `.env`의 `TAILNET_DOMAIN`과 서버 `.env`의
   `PUBLIC_ORIGIN`에만 둡니다.
3. **공개 인터넷에 여는 TCP 포트는 없습니다.** Vultr 방화벽 그룹 인바운드는 22/tcp(PC 공인 IP/32 — Tailscale이 막혔을 때의 비상용 SSH)와 41641/udp
   (Tailscale 직접 연결 — 없으면 DERP 중계를 거쳐 느려짐, v4·v6) 둘뿐입니다. PC 공인 IP가 바뀌면 `scripts/vultr/firewall-pc-ip.sh`가 22 규칙을 바꿉니다
   (Vultr API 키 자체의 허용 IP는 콘솔에서만).
4. **앞단 caddy는 루프백 8201 하나**(`compose.vultr.yml`, `deploy/vultr/Caddyfile` — AWS Caddyfile의 `:8201` 블록): `/api/*`는 백엔드, 나머지는 화면(같은 출처).
   AWS의 공개 리스너 `:8301`·비밀 헤더 확인·잠금화면(gate)·`trusted_proxies`·HSTS는 두지 않습니다 — 공개 주소가 없어 그 전제가 사라졌습니다.
   텔레그램은 모의 매매 알림만 남습니다(잠금 해제 알림은 gate와 함께 없음).
5. **백엔드 설정**: 로그인 유지(`DASHBOARD_LOCAL_NO_LOGIN="false"`, ADR 0016), `COOKIE_SECURE` 기본 true(HTTPS), 허용 출처는 Tailscale 주소(`PUBLIC_ORIGIN`, 필수 —
   비면 compose 해석 실패)와 비상용 SSH 포워딩 `http://localhost:8201`·`http://127.0.0.1:8201`, `PUBLIC_URL`·알림 링크도 Tailscale 주소, 메일 끔.
   그 밖(국면 기록 23시, postgres 종료 대기 30초)은 AWS 덧붙임과 같게 둡니다 — 24시간이라 23시의 제약은 없지만 기록 시점을 바꾸지 않습니다.
6. **백업**(D2): AWS와 같은 S3 버킷의 `db/vultr/`(병행 중 AWS의 `db/`와 섞이지 않게), 같은 시각(cron 06:45 KST·일 23:00 KST, 서버 시간대 UTC). 인스턴스 역할이 없어
   서버 ubuntu의 `~/.aws/credentials`(600)에 IAM 사용자 `my-macro-vultr-backup`의 키를 둡니다 — 권한은 `db/*` 목록·읽기와 `db/vultr/*` 쓰기뿐(지우기 없음).
   60일 만료는 버킷 전체에 걸린 수명주기가 그대로 맡습니다.
7. **코드 받기**(D6): 읽기 전용 GitHub 배포 키(서버 ubuntu `~/.ssh/id_ed25519_github`, `~/.ssh/config` Host `github-v2`). 배포는 `scripts/vultr/deploy.sh`
   (AWS `deploy.sh`에서 gate·CloudFront 대역 단계를 뺀 것).
8. **병행과 컷오버**: 병행 중 Vultr `.env`는 `PAPER_ENABLED=false`(모의 매매 정기 작업은 한 곳 — ADR 0019·0020). 토스 허용 IP에는 지금 Vultr IP를 등록했습니다(D3 —
   병행 중 같은 앱 키의 토큰 충돌은 감수). 컷오버(D4)는 Vultr 확인 뒤 첫 주말 낮(미·한 장이 모두 닫혀 정기 작업이 없을 때): AWS `PAPER_ENABLED=false` 배포 →
   `make backup` → Vultr `make restore` → 행 수·계좌별 순자산 대조 → Vultr `.env`의 `PAPER_ENABLED=false` 삭제 → `deploy.sh` → 첫 리스크 행·다음 결정·텔레그램 확인 →
   AWS 일정 6개 DISABLE·인스턴스 정지. AWS my-macro 자원은 한 주 정지 상태로 두었다가 지웁니다(D5).
9. **AWS 파일은 컷오버 전까지 그대로** 둡니다(`scripts/aws`·`compose.aws.yml`·`deploy/aws`·`.env.aws.example`) — AWS 운영본이 쓰는 중입니다. Vultr 파일은 같은 이름·구조로
   갈라내 두어, 정리(명세 §7) 때 AWS 파일을 지우기만 하면 됩니다.

10. **Tailscale 신원 자동 로그인**(2026-11-03 사용자 결정 — "Tailscale 계정이면 자동 로그인", 이메일·비밀번호 화면을 없애 달라는 요청): Tailscale Serve는 넘기는
    요청에 사용자 신원 헤더 `Tailscale-User-Login`을 붙이고 클라이언트가 보낸 같은 이름의 헤더는 지웁니다(Tailscale 공식 문서 'Serve — identity headers', v1.92+ —
    서버는 1.104.4). 이 값이 서버 `.env`의 `TAILNET_OWNER_LOGIN`과 같으면(대소문자 무시) 쿠키 없는 요청을 첫 운영자로 엽니다 — 로컬 무로그인(ADR 0016)과 같은
    운영자·같은 출처 검사(쿠키 없는 쓰기는 허용 출처의 `Origin`, 다른 사이트면 403). 켜지면 허용 출처는 `FRONTEND_ORIGIN` 명시 목록뿐이고 로그인 모드의
    화면 포트 와일드카드(`http://*:8201`)는 빠집니다(QA-171, 2026-11-04 — ADR 0016 결정 4와 같은 이유: 쿠키가 아닌 자격이라 SameSite가 막아 주지 않음). 비면 꺼짐(로컬·QA·AWS 기본). 비상용 SSH 포워딩으로 온 요청에는 헤더가 없어
    로그인 화면이 그대로입니다. 세션 응답은 `noLogin: true`·`user.tailnet: true`이고 계정 메뉴는 'Tailscale · 로그인 없음'.

## 이유

- **비용**: Vultr 24시간 월 $24. AWS t4g.medium을 24시간으로 돌리면 1년 예약으로도 월 약 $27.5(명세 작성 때 추정)이고, 지금의 가동 창(월 약 $17)은 창 밖에
  화면이 없습니다. 같은 돈이면 늘 켜진 쪽이 낫다는 사용자 판단입니다.
- **포트폴리오 데모와 합치지 않는 이유**: AWS 계정은 포트폴리오 제출용으로 남기고(누가 볼 수 있는 자원), 개인 모의 매매의 상태·비밀값을 그 계정에 섞지 않습니다.
  한 서버에 합치면 데모 쪽 변경이 운영본을 멈출 수 있습니다.
- **Tailscale을 고른 이유**(D1, 대안과 비교): 공개 TCP 포트가 0이고(Cloudflare Tunnel도 같음), 도메인·DNS가 필요 없으며(Cloudflare Tunnel+Access는 도메인 필요),
  PC·휴대폰 모두 같은 주소·같은 인증서로 열립니다. IP를 직접 노출하는 안(공개 443 + AWS식 잠금화면)은 공개 포트와 잠금화면 코드를 계속 지켜야 합니다.
- **ADR 0019(결정 3·16, '대안과 버린 이유')의 'Tailscale은 두지 않는다'를 Vultr에서는 뒤집는 근거**: 0019가 Tailscale을 뺀 것은 2026-10-25 'Tailworm' 보고(당시 패치 없는 Tailscale SSH
  결함)와 Tailscale SSH 보안 공지 때문이었고, AWS에는 SSM이라는 상주 데몬 없는 대안이 있었습니다. Vultr에는 클라우드가 주는 접속 길이 없어, 세 안 모두
  서버에 무엇인가를 상주시키거나(tailscaled · cloudflared) 공개 포트를 엽니다. 그중 공개 포트가 없고 계정·도메인 의존이 가장 적은 것이 Tailscale입니다.
  서버의 tailscale은 1.104.4(2026-11-03 공식 apt 저장소)입니다 — 보도에 따르면 10-28의 1.104.4가 Tailscale SSH 공지 TS-2026-014~017을 고쳤습니다
  (Tailscale 공지 원문은 이 문서를 쓸 때 확인하지 못했습니다 — 결과에 남은 위험으로 적음).
- **잠금화면을 뺀 이유**: gate는 공개 주소(누구나 닿는 URL) 앞의 한 겹이었습니다. tailnet에 들어온 기기만 닿는 지금은 그 전제가 없고, 로그인(ADR 0010·0016)은 그대로입니다.

## 대안과 버린 이유

- **AWS 그대로(가동 창)**: 월 약 $17로 싸지만 창 밖에 화면이 없고, 창을 바꿀 때마다 일정·스크립트·문서를 함께 고칩니다.
- **AWS 24시간(1년 예약)**: 월 약 $27.5로 Vultr보다 비싸고, 포트폴리오 계정과 섞입니다.
- **Cloudflare Tunnel + Access**: 공개 포트 0은 같지만 도메인·DNS가 필요하고 Cloudflare 계정·정책에 기댑니다. 바꾸고 싶어지면 cloudflared가 같은 `127.0.0.1:8201`에 붙으면
  되어 caddy·앱은 그대로입니다.
- **IP 직접 노출(공개 443 + Caddy 자동 HTTPS + 잠금화면)**: 공개 포트·인증서·잠금화면을 계속 지켜야 하고, 도메인이 없으면 IP 인증서가 번거롭습니다.
- **NCP**(같은 사양 월 약 66,240원 + 공인 IP, VAT 별도): Vultr보다 비쌉니다(2026-10-28 탐색).

## 결과와 남은 위험

- (2026-11-03 01:4x) 저장소 작업(명세 §3, main 0741f7b6) → 서버 올리기(명세 §5의 4번부터): clone·`.env`·배포 6분·AWS 백업(11-02 06:45) 복원·PC와 휴대폰에서
  Tailscale 주소로 로그인·직접 연결·백업 `db/vultr/`·cron. 수집 첫 바퀴 55번 ok·누락 0. 토스는 AWS → Vultr → AWS로 번갈아 불러 모두 ok(401 재발급 경로).
- (2026-11-03 02:28~02:33 KST) **컷오버 — 사용자 결정으로 D4(첫 주말 낮)보다 앞당겨 미국 장중에 함**: AWS `.env` `PAPER_ENABLED=false` → 백엔드 다시 띄움 →
  `backup-s3.sh`(460M) → Vultr 복원 → 계좌 10개의 주문·체결·보유·최근 순자산·현금과 전체 수치(결정 24·주문 112·체결 66·작업 기록 246·실행 감사 18·저장본 104)가
  AWS와 같음 → Vultr `.env`의 `PAPER_ENABLED=false` 삭제·`deploy.sh` → AWS EventBridge 일정 6개 DISABLE·인스턴스 정지. 미국 장중 리스크 점검은 약 10분 비었습니다
  (AWS 마지막 02:27:49 → Vultr 첫 02:37:21 — 기동 뒤 첫 실행 지연 포함, 그 사이 체결·스탑 0).
  대조 중 AWS `.env`에만 있던 `PAPER_KR_START_DATE`(로컬 `.env`에는 없음)를 찾아 Vultr에 더했습니다 — `.env.vultr.example`에 적음.
- (2026-11-03 19~20시 KST) **AWS 정리(단계 D) — 사용자 결정으로 한 주 대기를 앞당김**: 지운 것 — EventBridge 일정 6개와 실행 역할, CloudFront 배포판
  'my-macro v2 public'·OAC·안내 버킷, EC2 `my-macro-app`(루트 EBS 함께)·탄력적 IP·보안 그룹, IAM 역할·인스턴스 프로필 `my-macro-ec2`, v2 저장소의
  AWS 서버용 GitHub 배포 키. 남긴 것 — S3 백업 버킷(Vultr가 `db/vultr/`에 씀), 예산 `my-macro-monthly-45usd`, IAM 사용자 `my-macro-vultr-backup`,
  SSM 세션 설정 문서(계정 전체), 포트폴리오 데모 전부. AWS 운영본의 마지막 덤프(컷오버 직전 02:28 KST)는 버킷의 `archive/aws-final/`에 복사했고,
  버킷 수명주기의 60일 만료를 버킷 전체에서 `db/` 접두어로 좁혀 `archive/`는 만료되지 않습니다(불완전 업로드 7일 정리는 버킷 전체 그대로).
  저장소에서는 `scripts/aws`·`deploy/aws`·`compose.aws.yml`·`.env.aws.example`과 그 CI 단계·시험을 지웠습니다.
- (2026-11-03, 단계 D) **한국 관측치 늦음 기준을 24시간 서버에 맞춤**: 다음 수집 예정 E = max(D′ 20:30, D′ 서버 기동 뉴욕 09:20)는 AWS 밤 창(한국 명세 §9 F4)의
  전제라, 24시간 서버에서는 늦음이 실제보다 약 3시간 늦게 떴습니다(겨울 D′+1 01:25). E = D′ 20:30 KST 하나로 되돌려 늦음 = **D′ 22:35 KST**
  (서머타임 분기 없음, 여유 2시간 5분 그대로 — slow 1시간 주기에서 20:30 뒤 첫 slow와 그 다음 slow가 연달아 못 받은 뒤). 화면·API 응답 모양은 그대로이고 값만 당겨집니다.
  결함이 아니라 설계 변경이라 QA 번호·재현 커밋은 없습니다.
- (2026-11-04, 4차 리뷰) **배포 점검을 운영본 기준으로**: `deploy.sh`의 `PAPER_ENABLED` 점검이 병행 기간 방향 그대로라 정상 배포마다
  '주의 — AWS 서버의 정기 작업이 꺼져 있는지 확인'을 찍고, 정기 작업이 멈춘 채 뜨는 `false`는 '참고'뿐이었습니다(QA-194). 이제 `false`면 '주의'(끝 요약에도),
  없으면 '참고: 정기 작업 켜짐'입니다. 백엔드 기동 경고의 '장부는 AWS 서버 한 곳에만'도 Vultr로 고쳤습니다.
  배포에 직전 덤프가 없어 배포가 장부를 망가뜨리면 되돌릴 시점이 그날 06:45 백업뿐이었습니다(QA-200 — 사용자 결정 2026-11-04). 이제 빌드가 끝나고
  기동하기 전에 서버 `backups/pre-deploy-…`를 뜨고, 뜨지 못하면 배포하지 않습니다(서버에만 — S3에는 올리지 않음, 덤프 하나 약 460 MB·10개 보존).
  이 덤프가 줄이는 것은 06:45부터 배포까지의 구간이고, 배포 뒤 늦게 알아채면 통째 복원은 그 뒤 쌓인 장부까지 되돌립니다(DEVELOPMENT §7 '되돌리기').
  S3 백업 실패가 syslog에만 남아 운영자가 `journalctl`을 보기 전까지 몰랐습니다(QA-199 — 사용자 결정 2026-11-04). 이제 실패하면 서버 `.env`의 텔레그램 봇으로
  한 줄 알리고, 성공 시각을 `backups/.last-s3-ok`에 남겨 `make status`(날마다 볼 것)와 `deploy.sh` 끝 요약이 36시간 넘으면 경고합니다(cron이 빠진 경우까지 —
  판정은 `scripts/vultr/backup-age.sh` 한 곳, 기록이 없으면 `deploy.sh`만 경고).
  남은 위험: 결정 6의 60일 만료에는 '최근 N개 보존'이 없어 실패를 60일 넘게 놓치면 `db/vultr/`가 모두 만료됩니다. 만료 없는 주간 사본은 `db/` 밖 접두어와
  IAM 사용자 권한 변경(저장소 밖 자원)이 필요해 두지 않았습니다. 일시 실패 뒤 재시도도 없습니다(다음 cron까지 최대 약 24시간).
- **Tailscale SSH**: 0019가 문제 삼은 부위를 켜 둡니다(`--ssh`). tailnet 사용자는 1명이고 기본 정책(모든 기기 서로 허용)입니다. 공지가 새로 나오면
  `sudo apt-get install --only-upgrade tailscale`로 올리고, 필요하면 `tailscale set --ssh=false`로 끄고 비상용 22(PC IP만)로 대신합니다.
  1.104.4가 공지 TS-2026-014~017을 고쳤는지는 Tailscale 공지 원문으로 확인하지 않았습니다.
- **접속 주소가 하나로 보임**: tailscale serve가 루프백으로 넘긴 요청은 caddy에 모두 같은 주소로 보여, 로그인 지연은 사실상 이메일별입니다(AWS 터널과 같음, 사용자 1명).
- **병행 중 외부 호출이 두 배**: Vultr 수집기도 외부 출처를 부릅니다(정기 작업은 꺼져 있어 Claude 결정 호출은 없음). 토스는 같은 앱 키로 두 곳이 토큰을 받습니다(D3에서 감수).
- **백업 객체 덮어쓰기**: 백업 IAM 사용자는 지우기 권한이 없지만 같은 키로 덮어쓰는 것은 막지 못합니다(0019와 같은 남은 위험). 파일 이름에 시각이 있어 평소에는 겹치지 않습니다.
- **신원 헤더를 믿는 전제**(결정 10): 앱이 루프백(caddy `127.0.0.1:8201`·백엔드 `127.0.0.1`)에만 열려 Serve를 거치지 않고는 닿지 않아야 합니다 — 포트를 공개로
  (2026-11-06 [ADR 0026](0026-polite-fetch-layers.md): 제3자 스크립트를 실행하는 브라우저 컨테이너가 더해졌습니다. 그 컨테이너는 기본 망에 붙지 않아 caddy·백엔드에
  이름으로 닿지 못하고, 브라우저가 보내는 요청은 전역 주소가 아닌 목적지면 막습니다 — CI가 망 구성을 봅니다.)
  바꾸면 누구나 헤더를 붙여 운영자가 됩니다(CI가 포트를 봄). 서버 안의 다른 프로세스는 헤더를 붙여 루프백으로 부를 수 있습니다(같은 서버 권한이면 `.env`를 읽을 수
  있다고 보고 받아들임 — ADR 0016과 같은 판단). 이 자격은 운영자 기기의 네트워크가 붙이므로 운영자 브라우저에서 연 다른 사이트의 요청에도 붙습니다 — 허용 출처가
  명시 목록이어야 하는 이유입니다(2026-11-03 07:30~11-04 배포 전에는 `http://*:8201`이 남아 있었음, QA-171). tailnet에 다른 사용자를 들이면 그 사용자는 로그인 화면이고, 기기를 잃으면 Tailscale 관리 화면에서 기기를 지웁니다.
- **비상용 22**: PC 공인 IP가 바뀌면 막힙니다 — Tailscale이 살아 있으면 상관없고, 둘 다 막히면 Vultr 콘솔(웹 콘솔)로 들어갑니다. WSL에서 Tailscale SSH가
  계속 되면 22를 닫을지 정합니다(명세 §2).
