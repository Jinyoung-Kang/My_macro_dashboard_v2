실행 세션 지시문(아래 경로의 파일)을 먼저 끝까지 읽고 그대로 따라 이 프로젝트의 성능 개선 세 가지(상태 질의·공용 JS·매크로 화면)를 실행해 줘.
이 메시지가 계획 승인이야. 비어 있는 값은 괄호 안 기본값을 따라.

- 프로젝트 위치: /home/jykang/Projects/My_macro_dashboard_v2 (Windows 경로 \\wsl$\Ubuntu\home\jykang\Projects\My_macro_dashboard_v2)
- 실행 세션 지시문: docs/specs/2026-11-22-perf-status-macro-js-exec-instructions.md
- 기준선 원자료: docs/qa/evidence/2026-11-22-perf/baseline.txt
- 진행 기록: docs/specs/2026-11-22-perf-status-macro-js-progress.md (없으면 새로 만듦)
- 계획 기준 커밋: 이 프롬프트 파일을 넣은 main 커밋 (`git log -1 --format=%h -- docs/specs/2026-11-22-perf-status-macro-js-exec-prompt.md`)
- 대상 브랜치: main (작업 브랜치 claude/perf-2026-11)
- 승인 범위: 단계 0(측정 도구), 작업 A(상태 질의), 작업 C(공용 JS), 작업 B(매크로 화면) 전부
- 결정 사항 답변:
  - D-1 순서와 멈춤: 단계 0 → 1(A) → 2(C) → 3(B). 단계를 끝낼 때마다 보고하고, 받아들임 기준을 채웠으면 묻지 말고 다음 단계로 넘어가
  - D-2 배포: 승인 — 서버 코드가 바뀐 단계마다 main·CI 뒤 지시문 §7의 권하는 창에서 Vultr에 배포
  - D-3 행 수 세기: 화면에 보이는 숫자는 그대로 정확한 값. 상태 화면(`/api/status`)에서만 세고, 수집기 안에서 60초 동안 기억해 다시 씀. 추정값으로 바꾸지 않음
  - D-4 미리 받기: 가리킬 때만(마우스 올림·키보드 초점·터치 시작). 이동 시간이 중앙값 150 ms 넘게 늘면 멈추고 보고
  - D-5 매크로 화면: 보이는 내용·순서·구조는 그대로 두는 고침만. 탭 나누기·스크롤해야 그리기·구역 접기는 하지 말고 필요하면 물어봐
  - D-6 새 의존성·스키마 변경·백엔드 새 경로: 하지 않음. 꼭 필요하면 이유를 설명하고 멈춰
- 그 밖에 알릴 것: QA 스택이 다른 세션의 작업 폴더에서 떠 있으면 다시 빌드하거나 내리기 전에 물어봐. 세션 예약은 걸지 마.
