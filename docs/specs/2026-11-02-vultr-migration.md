# Vultr 이전 작업 명세 (2026-11-02, 11-03 Tailscale로 고침)

운영본(my-macro, v2)을 AWS EC2(t4g.medium, 가동 창)에서 Vultr 서울(vhf-2c-4gb, 24시간)로 옮긴다. 포트폴리오 데모(portfolio-app·RDS·CloudFront 3개)는
AWS에 그대로 둔다. 저장소는 가르지 않고 이 저장소(v2)에 Vultr 배포 경로를 더한다(결정은 ADR 0023에 적는다 — 이 문서는 작업 목록).

사용자 결정(2026-11-02): AWS·Vultr 둘 다 배포해 병행 → Vultr가 AWS처럼 정상 동작하면 컷오버 → AWS의 my-macro 리소스 정리.
접속은 **Tailscale**(아래 §2, 2026-11-03 사용자 결정 — Cloudflare Tunnel+Access와 비교해 도메인·DNS가 필요 없고 공개 포트가 0이라 택함). 공개 인터넷에는 아무 포트도 열지 않는다.

## 0. 이미 끝난 것(2026-11-02 밤, 이 PC에서 Vultr API로)

- Vultr 계정·결제 수단·API 키(로컬 `.env` `VULTR_API_KEY`, 허용 IP = PC 공인 IP). 커넥터는 없다 — `curl -H "Authorization: Bearer $VULTR_API_KEY" https://api.vultr.com/v2/…`.
- 인스턴스 `my-macro-app`(icn, vhf-2c-4gb, Ubuntu 24.04 x64, 자동 백업·DDoS 끔, IPv6 켬). ID·IP·방화벽 그룹 ID는 로컬 `.env`의
  `VULTR_INSTANCE_ID`·`VULTR_SERVER_IP`·`VULTR_FIREWALL_GROUP_ID`(계정 고유 값 — 저장소에 적지 않는다, 메모리 `vultr-server-2026-11`).
- 방화벽 그룹 `my-macro-app`: 22/tcp는 PC 공인 IP/32만, 443/tcp는 v4·v6 공개. 그 밖은 닫힘.
- SSH 키 `~/.ssh/id_ed25519_vultr`(Vultr 이름 my-macro-app-pc). 접속 `ssh -i ~/.ssh/id_ed25519_vultr ubuntu@$VULTR_SERVER_IP`. 비밀번호 로그인은 꺼짐.
- cloud-init = `scripts/vultr/bootstrap.sh`(서버에서 실행 끝): Docker 29.9.2·compose 5.6.1·AWS CLI v2·ubuntu 사용자(sudo·docker)·스왑(이미지 기본 8 GiB)·journald 500M.
  sshd 드롭인은 `00-my-macro.conf`(cloud-init의 50-cloud-init.conf가 PasswordAuthentication yes를 넣으므로 먼저 읽혀야 한다).
- `.env.example`에 `VULTR_API_KEY` 이름 추가.
- (11-03) Tailscale: 서버가 tailnet에 들어감(`my-macro-app.<tailnet>.ts.net`, `scripts/vultr/tailscale-up.sh` — 키는 stdin, 실행 방법은 머리말), Tailscale SSH 켜짐(WSL에서 `ssh ubuntu@my-macro-app` 확인),
  tailnet에서 Serve 켬(사용자), `tailscale serve --bg --https=443 http://127.0.0.1:8201` 등록·Let's Encrypt 인증서 발급 확인(PC에서 502 = caddy 없음이 정상). 방화벽: 443 삭제, 41641/udp v4·v6 추가.
- (11-03) GitHub 읽기 전용 배포 키 `my-macro-app-vultr` = 서버 ubuntu `~/.ssh/id_ed25519_github`, `~/.ssh/config` Host github-v2(`git ls-remote` 확인). 토스 허용 IP는 사용자가 등록 끝.
- (11-03) AWS IAM 사용자 `my-macro-vultr-backup`(ListBucket db/*, PutObject db/vultr/*, GetObject db/*) + 액세스 키 → 서버 ubuntu `~/.aws/credentials`(600, 쓰기·거부 확인). 로컬 `.env.example`에 TAILSCALE_*·VULTR_* 이름.
- 서버에는 아직 저장소·.env·컨테이너가 없다 — 여기부터가 단계 B(§5의 4번부터).
- (11-03) 단계 A(§3) 끝 — 브랜치 `claude/vultr-deploy-2026-11`을 main에 fast-forward. 결정은 [ADR 0023](../adr/0023-vultr-deployment.md).

## 1. 원칙(지킬 것)

- **모의 매매 정기 작업은 한 곳에서만**(ADR 0019·0020). 병행 기간의 Vultr `.env`는 `PAPER_ENABLED=false` 고정. 컷오버 때만 바꾼다.
- 계정 고유 값(Vultr ID·IP, AWS 버킷·인스턴스 ID)과 비밀값은 저장소에 적지 않는다(`.env`·메모리만). 공개 저장소다.
- 이모지 금지(`noEmoji.test.ts`가 스크립트·compose·env 예시·문서를 본다).
- 옮기는 커밋과 고치는 커밋을 나눈다. 모든 커밋이 `make test`를 통과한다. 브랜치 `claude/vultr-deploy-2026-11` → main fast-forward → push → CI 6개.
- AWS 쪽 파일(`scripts/aws`, `compose.aws.yml`, `deploy/aws`)은 컷오버 전까지 그대로 둔다(AWS 운영본이 쓰는 중).

## 2. 접속: Tailscale(공개 주소 없음)

- 서버·PC·휴대폰이 같은 tailnet에 들어가고, 화면은 `https://my-macro-app.<tailnet>.ts.net`(MagicDNS + Tailscale HTTPS 인증서 — Let's Encrypt, 브라우저 경고 없음)으로 연다.
  tailnet 이름은 계정 고유 값이라 저장소에 적지 않는다(`.env` `TAILNET_DOMAIN`, 메모리).
- 서버: tailscaled 설치(공식 apt 저장소), `tailscale up --ssh --hostname my-macro-app`(auth key는 로컬 `.env` `TAILSCALE_AUTH_KEY`, 한 번 쓰고 만료되는 키). `--ssh`로 Tailscale SSH를 켜
  포트 22 없이도 `ssh ubuntu@my-macro-app`가 된다. 서버 쪽 ACL은 tailnet 기본(모든 기기 서로 허용, 사용자 1명)을 쓴다.
- HTTPS는 `tailscale serve --bg https:443 http://127.0.0.1:8201`로 Tailscale이 인증서(`tailscale cert`)를 받고 Caddy `:8201`(루프백)로 넘긴다. Caddy는 루프백 8201만 듣는다 —
  AWS Caddyfile의 `:8301` 공개 블록·origin_guard·gate·trusted_proxies·HSTS는 모두 없다. 따라서 Caddy의 역할은 "/api/* → backend, 나머지 → frontend" 하나다.
  (`tailscale serve`가 tailnet 안에서만 듣는다. `funnel`은 쓰지 않는다 — 공개 노출 금지.)
- Vultr 방화벽 그룹: 443 규칙 두 개 삭제. 22/tcp는 PC 공인 IP/32로 남긴다(Tailscale이 막혔을 때 비상용 — WSL2에서 Tailscale 주소로 SSH가 되는지 확인되면 그때 닫을지 결정).
  직접 연결용 `41641/udp`를 인바운드에 연다(없으면 DERP 중계를 거쳐 느려짐).
- 잠금화면(gate)은 쓰지 않는다 — 공개 주소가 없어 전제가 사라졌다. compose.vultr.yml에 gate 서비스·`GATE_*`·`ORIGIN_SECRET`·`PUBLIC_HOST`가 없다. 텔레그램은 모의 매매 알림만 남는다.
- 백엔드: `PUBLIC_ORIGIN=https://my-macro-app.<tailnet>.ts.net`(허용 출처·알림 링크, QA-136), `COOKIE_SECURE=true` 그대로(HTTPS), `FRONTEND_ORIGIN`에 터널 주소와 함께 들어간다.
- 관리용 길: Tailscale 뒤라 따로 터널이 필요 없다(같은 주소로 /api/admin도 열림). `scripts/vultr/tunnel.sh`는 두지 않고, 대신 SSH는 `ssh ubuntu@my-macro-app`(Tailscale SSH) 또는
  비상용 `ssh -i ~/.ssh/id_ed25519_vultr ubuntu@$VULTR_SERVER_IP`.
- 사용자가 할 것: Tailscale 계정(끝), PC(Windows)·휴대폰에 앱 설치·로그인, 관리 콘솔 DNS에서 MagicDNS·HTTPS Certificates 켜기, auth key 발급 → 로컬 `.env`.
- 뒤에 Cloudflare Tunnel로 바꾸려면 cloudflared가 같은 `127.0.0.1:8201`로 붙으면 된다 — Caddy·앱은 그대로.

## 3. 저장소 작업(단계 A)

AWS 파일에서 갈라낸다. 이름·구조를 AWS 것과 맞춰 두면 컷오버 뒤 AWS 파일을 지우기만 하면 된다.

1. `compose.vultr.yml` ← `compose.aws.yml`. 다른 점: gate 서비스 없음, caddy `ports`는 `127.0.0.1:8201:8201` 하나, `volumes`는 `deploy/vultr/Caddyfile`만, `ORIGIN_SECRET`·`GATE_*` 없음,
   backend `FRONTEND_ORIGIN`·`PUBLIC_ORIGIN`에 `${PUBLIC_ORIGIN}`(ts.net 주소, 필수 `:?`), `DASHBOARD_SCHEDULER_REGIMERECORDHOURKST`는 23 그대로. 머리말 주석은 Vultr·Tailscale 기준(24시간, 가동 창·공개 주소 없음).
2. `deploy/vultr/Caddyfile` ← `deploy/aws/Caddyfile`의 `:8201` 블록만(§2대로). 머리말에 Tailscale serve → 8201 경로를 적는다.
3. `scripts/vultr/deploy.sh` ← `scripts/aws/deploy.sh`. `COMPOSE_FILE=docker-compose.yml:compose.vultr.yml`, trusted_proxies 단계 삭제, 서버 `.env`에 적지 않는 이름 목록(§4), 자기 갱신 검사 경로.
4. `scripts/vultr/backup-s3.sh` ← `scripts/aws/backup-s3.sh`. 같은 버킷, 접두어 `db/vultr/`(병행 중 AWS의 `db/`와 구분). 인증은 서버 ubuntu의 `~/.aws/credentials`(600, 버킷 하나만 쓰는 IAM 사용자 — §5).
   cron은 매일 21:45 UTC(06:45 KST)·일 14:00 UTC(23:00 KST) 그대로.
5. `scripts/vultr/tailscale-up.sh`(서버에서 한 번): 공식 저장소에서 tailscale 설치 → `tailscale up --ssh --hostname my-macro-app --auth-key <stdin>` → `tailscale serve --bg https:443 http://127.0.0.1:8201`.
   키는 인자가 아니라 stdin으로 받아 프로세스 목록·셸 기록에 남기지 않는다.
6. `scripts/vultr/firewall-pc-ip.sh`: PC 공인 IP가 바뀌었을 때 방화벽 그룹의 22 규칙을 지금 IP로 바꾼다(API). Vultr API 키 자체의 허용 IP는 콘솔에서만 바꿀 수 있다고 안내 출력.
7. `scripts/vultr/instance.sh status`: 인스턴스 상태·IP 조회(API). start/stop은 두지 않는다(24시간, 꺼도 과금).
8. `.env.vultr.example`(이름만): 서버 전용 `COMPOSE_FILE=docker-compose.yml:compose.vultr.yml`·`AWS_BACKUP_BUCKET`·`PUBLIC_ORIGIN`·`TELEGRAM_*`.
   병행 기간에는 `PAPER_ENABLED=false`를 적는다고 명시. 적지 않는 이름: 포트 네 줄·`LOCAL_NO_LOGIN`·`FRONTEND_ORIGIN`·`PUBLIC_URL`·`ORIGIN_SECRET`·`GATE_*`·`AWS_INSTANCE_ID`·`VULTR_*`·`TAILSCALE_*`(PC 전용).
9. 로컬 `.env.example`에 `VULTR_INSTANCE_ID`·`VULTR_SERVER_IP`·`VULTR_FIREWALL_GROUP_ID`·`TAILSCALE_AUTH_KEY`·`TAILNET_DOMAIN` 이름 추가(이미 `VULTR_API_KEY`는 있음).
10. `scripts/vultr/bootstrap.sh`(이미 있음) 커밋.
11. 문서: ADR 0023(결정·대안(AWS 24시간 1년 예약 약 $27.5/월 대 Vultr $24, 합치지 않는 이유, Tailscale을 Cloudflare Tunnel+Access·IP 직접 노출 대신 고른 이유, gate를 뺀 이유, ADR 0019 결정 16 'Tailscale은 두지 않는다'를 Vultr에서는 뒤집는 근거)·병행·컷오버·AWS 정리 절차),
    `docs/DEVELOPMENT.md` §8 Vultr 서버(Tailscale 접속·배포·백업·방화벽 IP 갱신), `CLAUDE.md`(명령 절에 Vultr 줄, 포트 규칙은 '서버는 루프백 + Tailscale serve'로, 컷오버 전까지 '운영본은 AWS' 유지),
    `README.md` 실행 방법·아키텍처, `docs/ARCHITECTURE.md` 배포 그림, `docs/adr/README.md` 목록. 2026-10-26 v2 프로그램 계획서 §5(AWS 교체)에 Vultr 이전 한 줄 참조.
12. 테스트: `make test`(noEmoji가 새 파일을 본다). 스크립트는 `bash -n`. gate 시험은 그대로.

## 4. 서버 .env 만들기

로컬 `.env`에서 `.env.vultr.example`의 규칙대로 만든다(AWS 서버 .env를 만들던 방법과 같음 — `.env.aws.example` 머리말). 병행 기간에는 `PAPER_ENABLED=false`를 넣는다.
PC → 서버 전달은 `scp`(Tailscale SSH 또는 `-i ~/.ssh/id_ed25519_vultr`), 서버에서 `chmod 600`. 텔레그램 값은 넣되 PAPER가 꺼져 있어 병행 중에는 알림이 가지 않는다.

## 5. 서버 올리기(단계 B, 병행 시작)

1. (끝) AWS IAM 사용자·액세스 키 — §0.
2. (끝) GitHub 배포 키 — §0.
3. (끝) 서버 Tailscale 등록·serve·방화벽 — §0.
4. 서버 `git clone git@github-v2:Jinyoung-Kang/My_macro_dashboard_v2.git ~/My_macro_dashboard_v2`(폴더 이름 고정 — compose 프로젝트·볼륨 이름), `.env` 넣기, `bash scripts/vultr/deploy.sh`.
5. 데이터: S3의 최근 AWS 백업(`db/macrodash-….sql`)을 서버로 받아 `make restore F=…`(화면에 보일 데이터, 모의 매매 장부는 읽기만 — PAPER 꺼짐).
6. 확인: 컨테이너 5개 healthy(postgres·backend·collector·frontend·caddy), 백엔드 ERROR 0, PC·휴대폰에서 `https://my-macro-app.<tailnet>.ts.net` → 로그인(OWNER_EMAIL) → 개요·매크로·모의매매 화면,
   `tailscale status`에 직접 연결(relay가 아님), 수집기 status ok·누락 0(토스는 §8 D3에 따라), `backup-s3.sh` 손으로 한 번 → S3 `db/vultr/`에 객체, cron 등록, 디스크·메모리.
7. 병행 기간(며칠): 매일 백엔드 ERROR·수집 누락·메모리·디스크·백업을 본다. AWS는 그대로 돈다.

## 6. 컷오버(단계 C — 사용자가 "지금"이라고 할 때, 모의 매매 정기 작업이 없는 시간)

> 2026-11-03 02:30 KST 끝 — 사용자가 '지금 바로'(미국 장중)를 골라 D4보다 앞당김. 결과는 [ADR 0023](../adr/0023-vultr-deployment.md) 결과 절.

1. AWS 서버 켜기(꺼져 있으면 `instance.sh start`) → AWS `.env`에 `PAPER_ENABLED=false` 넣고 `deploy.sh`(정기 작업 멈춤 확인: 새 risk 행이 안 생김) → `make backup` → S3.
2. Vultr: 그 덤프 `make restore` → 행 수·계좌별 순자산이 AWS와 같은지 → Vultr `.env`에서 `PAPER_ENABLED=false` 줄 삭제 → `deploy.sh` → 첫 risk 행·다음 결정 시각(미국 06:30·한국 checkpoint)·텔레그램 알림이 Vultr에서 나오는지.
3. AWS: EventBridge 일정 6개 DISABLE(다시 켜지지 않게), 인스턴스 정지. 한 주 되돌리기용으로 둔다(EBS·EIP 약 $1.5/주).
4. 문서·메모리: CLAUDE.md '모의 매매 상태는 Vultr 한 곳', `aws-personal-deploy-status`·`paper-trading-repo-and-deploy` 메모리 갱신, ADR 0023 결과 한 줄.

## 7. AWS 정리(단계 D — 컷오버 한 주 뒤, 사용자 확인 뒤) — 끝(2026-11-03)

> 사용자가 한 주 대기를 앞당겨 2026-11-03에 했습니다. 지운 것·남긴 것은 [ADR 0023](../adr/0023-vultr-deployment.md) 결과 절, 작업 지시문은
> [단계 D 명세](2026-11-03-aws-cleanup-stage-d.md). SSM 세션 설정 문서는 계정 전체 적용이라 남겼습니다.

EC2 종료·EBS·EIP 해제·일정 6개·CloudFront `my-macro v2 public`·안내 버킷 `my-macro-offline-*`·IAM 역할 `my-macro-ec2`·SSM 세션 문서(계정 전체 적용이라 그대로 둘지 확인).
백업 버킷과 예산은 남긴다. 저장소: `scripts/aws`·`compose.aws.yml`·`deploy/aws`(gate 포함 — Vultr는 쓰지 않음)·`.env.aws.example` 삭제,
ADR 0019 'superseded by 0023', CLAUDE.md·DEVELOPMENT §7·ARCHITECTURE 정리, 포트폴리오 데모 쪽은 건드리지 않는다.

## 8. 사용자 결정(작업 전에 받은 답)

- D1 접속 방식: Tailscale. → 2026-11-03 결정 끝(Cloudflare Tunnel+Access 대신).
- D2 백업: S3 같은 버킷 `db/vultr/`(권장) / Vultr 디스크만. → 11-03 권장안으로 결정
- D3 토스 허용 IP: 지금 Vultr IP를 토스 콘솔에 등록(권장, 병행 중 토큰 충돌은 감수) / 컷오버 때 등록(병행 중 토스 태스크는 403·이전 값). → 11-03 권장안으로 결정
- D4 컷오버 시점: Vultr 확인 뒤 첫 주말 낮(미국·한국 장 모두 닫힘, 정기 작업 없음)(권장) / 다른 시각. → 11-03 권장안으로 결정
- D5 컷오버 뒤 AWS my-macro: 한 주 정지 상태로 두고 삭제(권장) / 바로 삭제. → 11-03 권장안으로 결정
- D6 GitHub 배포 키: Vultr용 읽기 전용 키 새로 등록(권장) / 공개 저장소라 HTTPS clone. → 11-03 권장안으로 결정
