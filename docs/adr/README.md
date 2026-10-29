# 설계 결정 기록 (ADR)

되돌리기 어렵거나, 나중에 "왜 이렇게 했지?"라는 질문이 나올 결정을 한 장씩 남깁니다.
각 문서는 **배경 → 결정 → 이유 → 대안과 버린 이유 → 결과(지키는 방법)** 순서입니다.
한 장을 쓸 만큼 크지 않은 결정(의존성 알림을 닫은 이유 등)은 [../decisions.md](../decisions.md)에 몇 줄로 남깁니다.

| 번호 | 제목 |
|---|---|
| [0001](0001-feature-modules-and-dependency-rules.md) | 백엔드 기능 단위 패키지와 의존 규칙 |
| [0002](0002-spring-boot-4-and-jackson-3.md) | Spring Boot 4.1 · Jackson 3 전환 |
| [0003](0003-backup-and-restore.md) | 백업·복원: 끝 표시 확인과 한 트랜잭션 통째 교체 |
| [0004](0004-frontend-layering.md) | 프런트엔드: 그리기 · 훅 · 순수 함수 · API 클라이언트 나누기 |
| [0005](0005-radar-history-replace-write.md) | 수급 레이더 이력: 조합·날짜 단위 교체 쓰기, 소스가 밝힌 기준일, 거래소 달력 |
| [0006](0006-frontend-api-base-at-runtime.md) | 화면이 백엔드 주소를 실행 시점에 정함 (휴대폰·LAN 접속), CORS는 화면 포트의 모든 호스트 |
| [0007](0007-claude-api-engine.md) | AI 엔진에 Claude Haiku 5.5를 공식 SDK로, 재시도는 SDK가 아니라 자동 탐색이 맡음 |
| [0008](0008-backend-owned-tables-and-scheduled-jobs.md) | 백엔드가 쓰는 테이블과 정기 작업 — 테이블마다 쓰는 쪽은 하나, 스키마 파일 한 곳, 정기 작업은 수집을 일으키지 않음 |
| [0009](0009-regime-track-record-point-in-time.md) | 국면 판정 성과: 시점 기준 재현(발표 지연), 다음 거래일 진입, 표본 부족은 숫자를 내지 않음 |
| [0010](0010-accounts-and-db-sessions.md) | 계정과 DB 세션(토큰 해시 저장), 경로별 접근 정책 표(미분류 금지), 운영자 계정은 OWNER_EMAIL·APP_PASSWORD로 |
| [0011](0011-alert-pipeline-inbox.md) | 알림 파이프라인: 사건/알림함 분리, 매번 전부 평가(멱등), 국면은 3일 확정, 잠정치·백필 금지, 화면 알림함만 |
| [0012](0012-aws-demo-deployment.md) | AWS 데모 배포: RDS · 앞단 프록시 뒤 같은 출처(`NEXT_PUBLIC_API_BASE=/`) · 프록시 IP 신뢰 · 공개 데모에서 닫는 것 |
| [0013](0013-demo-viewer-mode.md) | 데모 열람: 접근 코드를 통과한 공개 방문자는 로그인 없이 읽기 전용(앞단이 붙이는 `X-Demo-Viewer` 토큰, 기본 꺼짐) |
| [0014](0014-aws-demo-ai-report.md) | AWS 데모의 AI 리포트: 엔진 허용 목록(`AI_ENGINES`) · 데모 방문자 공용 하루 한도(메모리) · 데모 쓰기는 `POST /api/ai/report` 하나 |
| [0015](0015-13f-security-identity.md) | 13F 보유 종목의 단위: 이름이 아니라 증권(CUSIP), 보통주 클래스만 발행사로 합침(발행 번호가 숫자인 지분 증권), 직전 분기는 바로 앞 분기만, 티커 매칭은 수집기가 저장할 때 |
| [0016](0016-local-no-login.md) | 로컬 실행은 로그인 없이 이 맥(127.0.0.1)에서만 첫 운영자로 — 웹(v3 AWS 데모)·QA는 잠금 화면·로그인 그대로, 이 저장소의 AWS는 SSM 터널 + 로그인(`LOCAL_NO_LOGIN`, 덧붙임이 끔 고정, 섞이면 기동 실패) |
| [0017](0017-macro-card-delay-and-realtime-sources.md) | 매크로 카드의 지연 배지는 출처가 밝힌 지연으로(카탈로그는 분, 문구는 함수), 같은 종목의 실시간 공개 시세(TradingView)를 먼저 — 장 밖이면 거래일 |
| [0018](0018-paper-trading-guardrails.md) | 모의 알고리즘 매매(별도 Private 저장소 My_macro_dashboard_v1): 제안은 모델·검증과 집행은 코드(현금 비중은 모델 재량), 체결은 결정 뒤 첫 관측치(봉 날짜 > 기준 거래일), 신호 기관은 공시일 기준 복제 성과로 분기마다 두 그룹, 프레임은 승인된 판만, 실패는 그날 주문 없음·하루 호출 상한 |
| [0019](0019-aws-personal-deployment.md) | AWS 개인용 배포: EC2 t4g.medium 한 대 + Postgres 컨테이너, 밤 시간 창(KST 21:55~08:00, 토 ~10:00 — EventBridge Scheduler)만 가동, 접속은 SSM 포트 포워딩(인바운드 0) · 앞단 Caddy는 루프백 8201 하나 · 서버 `.env`에 적지 않는 이름 · 모의 매매는 서버 한 곳(로컬 `PAPER_ENABLED=false`) |
| [0020](0020-v2-program.md) | v2 프로그램: v1을 fork해 프런트만 새로 씀(저장소 공개) · 로컬 3002/8082/8002/5434·쿠키 `my_macro_v2_session` · 모의 매매 상태는 계속 AWS v1 한 곳 · 한국 증시 책 · Claude 호출 상한 20 · 봇 차단 우회의 허용 범위(D29 개정) · AWS는 같은 EC2에서 교체 |
| [0021](0021-kr-paper-prices-fills-start.md) | 한국 모의 매매 책: 잠정가는 토스·확정가는 금융위(체결 행은 고치지 않고 확정 조정 행 `paper_fill_confirmations`), 체결은 다음 거래일 시가(`NEXT_OPEN`, `NEXT_CLOSE`는 G2 뒤 코드 상수), 슬리피지는 체결가가 아니라 비용 칸, 네 계좌는 출발일 밤 결정 → 다음 날 시가에 한 트랜잭션으로 함께 출발(사후 체결 없음), 캘린더 컨센서스는 출발일에 두 책 함께 켬 |
| [0022](0022-us-claude-book2-timing.md) | 미국 Claude 계좌2(체결 시점 실험): 다섯 번째 미국 계좌가 계좌1과 같은 자료·같은 프레임으로 판단하고 체결 시점(시가 `NEXT_OPEN`·매시 `AT_1000`~`AT_1500`·종가)만 스스로 고름(`NEXT_OBSERVATION`은 반사실 기준으로만), 앞으로 체결로 늦게 출발, 시가는 Yahoo 1분봉 첫 봉(공식 개장가와 같은지 미확인 표시), 거래 없는 주문은 멈춘 가격으로 채우지 않음, 수집기는 주문 표를 읽기만, 정기 작업 둘(실행 감사·장중 확인), 판정은 주문 단위 반사실 사전 등록 |
