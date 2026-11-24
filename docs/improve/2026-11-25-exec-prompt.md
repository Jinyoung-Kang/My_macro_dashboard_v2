아래에 적힌 문서를 순서대로 읽고, 실행 세션 규칙을 그대로 따라 이 프로젝트의 개선 작업을
실행해 줘. 이 메시지가 계획 승인이고, 작업 브랜치에 커밋해 달라는 요청이야. 원격 push와
대상 브랜치 병합은 실행 세션 규칙이 허용하는 경우에만 해. 비어 있는 값은 괄호 안 기본값을 따라.

- 프로젝트 위치: /home/jykang/Projects/My_macro_dashboard_v2
- 실행 세션 규칙: /home/jykang/Projects/My_macro_dashboard_v2/docs/improve/2026-11-25-exec-rules.md
- 프로젝트 사실: /home/jykang/Projects/My_macro_dashboard_v2/docs/improve/2026-11-25-exec-context.md
- 계획서: /home/jykang/Projects/My_macro_dashboard_v2/docs/improve/2026-11-25-plan.md
- 진행 기록: /home/jykang/Projects/My_macro_dashboard_v2/docs/improve/PROGRESS.md
- 보안 상세 파일: /home/jykang/Projects/My_macro_dashboard_v2/docs/improve/private/2026-11-25-security.md
- 문서 상태: 위 문서는 아직 커밋되지 않았어. 네 작업 폴더에 없으면 위 경로에서 읽어.
- 계획 기준 커밋: a1af4ebdbdf7c299a099f5e1f10ebd5a46a34a81 (main)
- 대상 브랜치: main
- 동결 영역: 없음
- 실행 재량: 표준
- 승인 범위: (계획서의 "이번 회차 제안 범위" 전체. 일부만 승인하려면 항목 번호를 적음)
- 결정 사항 답변: (비어 있으면 계획서에 적힌 "답이 없을 때의 행동")
  - D-1: 전달을 어디까지 할까 — (가) main 병합·push·CI까지, 배포 안 함 (나) (가) + Vultr 배포 (다) 작업 브랜치 push·CI까지만 →
  - D-2: QA-1017(추가 매수 뒤 보유 종목 조건 — 켠 판의 Claude 결정 입력이 바뀜)을 고칠까 — (가) 고침 (나) 기록만 →
  - D-3: QA-1018(현금 부족으로 줄여 보낸 매수의 나머지 — 실제 돈의 주문 동작이 바뀜) — (가) 매도가 있으면 미뤘다가 온전한 수량으로 (나) 나머지를 시도 2로 (다) 기록만 →
  - D-4: 보안 수정이 메이저 판에만 있는 수집기 간접 의존성 1건의 메이저 업그레이드(상세는 보안 상세 파일) — (가) 올림 (나) 보류 →
  - D-5: 그 밖의 메이저·새 마이너 업그레이드 가운데 이번에 할 것 — (가) 없음 (나) 고른 항목 →
  - D-6: 커밋마다 돌릴 검증 — (가) 바꾼 스택의 전체 묶음만, make test 전체는 묶음 끝·독립 검토 전·최종 보고 전 (나) 커밋마다 make test 전체(약 30분) →
  - D-7: 복원 스크립트가 대기 중 ISA 스탑 지시를 닫는 동작 — (가) 그대로 두고 안내 글과 닫은 건수 출력만 더함 (나) 오늘 세션의 지시만 닫음 (다) 기록만 →
- 그 밖에 알릴 것: (없음)
