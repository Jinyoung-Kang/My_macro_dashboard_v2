실행 세션 지시문(아래 경로의 파일)을 먼저 끝까지 읽고 그대로 따라 이 프로젝트의 수집 신선도 개선 작업을 실행해 줘.
이 메시지가 계획 승인이야. 비어 있는 값은 괄호 안 기본값을 따라.

- 프로젝트 위치: /home/jykang/Projects/My_macro_dashboard_v2 (Windows 경로 \\wsl$\Ubuntu\home\jykang\Projects\My_macro_dashboard_v2)
- 실행 세션 지시문: docs/specs/2026-11-13-fresh-feeds-exec-instructions.md
- 진행 기록: docs/specs/2026-11-13-fresh-feeds-progress.md (없으면 새로 만듦)
- 계획 기준 커밋: 이 프롬프트 파일을 넣은 main 커밋 (`git log -1 --format=%h -- docs/specs/2026-11-13-fresh-feeds-exec-prompt.md`)
- 대상 브랜치: main (작업 브랜치 claude/fresh-feeds-2026-11)
- 승인 범위: 작업 A(VIX — 사전 검증 통과 시), B(경제지표 실제치 발표 직후), C1·C2·C3(사건 뉴스 조건부 요청·탄력 주기·소비 시각 맞춤) 전부
- 결정 사항 답변:
  - E-1 순서: 단계 1(C1·C2) → 단계 2(B) → 단계 3(C3, 단계 1 배포 뒤 미국·한국 각 2거래일 이상 관찰해 이상 없을 때) → 단계 4(A, 2026-11-16 월 미국 정규장 이후 사전 검증부터)
  - E-2 배포: 승인 — 단계마다 main·CI 뒤 지시문 §7의 권하는 창에서 Vultr에 배포
  - E-3 VIX 판정 기준: 지시문 §4 A 그대로(TVC:VIX(t)와 CBOE:VIX(t+15분) 차이 0.02포인트 이내 90% 이상 + 마감 값이 다음 날 Yahoo 종가와 같음). 통과 못 하면 A는 하지 않음
  - E-4 저장: 기존 저장 장치(상태 스냅숏·fetch_schedule)를 먼저 쓰고, 새 표가 꼭 필요하면 근거를 ADR에 적고 진행
  - E-5 할 일 없던 틱의 실행 기록: polite 속도군 관례를 따르되, 하루 수백 건 늘면 기록하지 않는 쪽으로(ADR에 결정)
- 그 밖에 알릴 것: 시작 조건이 아직 아닌 단계에 닿으면 보고하고 멈춰. 세션 예약은 걸지 마. 다음 단계는 내가 "다음 단계 진행해"라고 할게.
