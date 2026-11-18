# 2026-11-19 결함 기록 — 규칙 계좌 재선정 다음 묶음의 회전율 예외(브랜치 `claude/rebalance-turnover-2026-11`)

> - 기준: `main@5e25641b`. 결정은 [ADR 0028](../adr/0028-real-trade-mirror.md) 덧붙임 2026-11-19(사용자 승인 R1~R4 — "회전율 예외 규칙 권장안대로 승인"), 구현은 `6646bd06`(화면)·`df3b43de`(백엔드)·`20e3e4c1`(문서)입니다.
> - 처리 순서: 결함마다 재현 시험 커밋(수정 전 코드에서 실패를 확인한 뒤 `@Disabled`·`it.fails`) → 근본 원인 수정 커밋(표시 해제). 시험·문서만 바뀐 항목은 한 커밋이고 재현 칸이 `—`입니다.
> - 환경: 로컬 테스트 DB(`macrodash_test`)와 목·합성 계좌(E 1,000만 원, 가격 1원·1,000원)만 썼습니다. 실제 계좌 자료·운영 DB·QA 스택은 쓰지 않았습니다 — QA 스택은 `REAL_TRADE_ENABLED="false"` 고정이라 실제 매매 경로는 DB 시험이 유일한 확인입니다.
> - 번호: 이 작업에 예약된 번호는 QA-800~809이고, 이번 검토 반영에서 QA-800·801을 썼습니다.

## 독립 검토 반영 — `20e3e4c1`에서 (2026-11-19)

| 번호 | 심각도 · 분류 | 내용 | 재현 | 수정 |
|---|---|---|---|---|
| QA-800 | S4 · 화면 글(운영자 화면 — 판정 기준을 잘못 읽게 함) | 재선정 예외의 교차 확인(`over-allowance`)은 판정 회전율을 스탑 감소만 뺀 책 변화량 B° + 20%p와 견주는데(`RealTradeRebalance.check`), 화면 이름표는 '회전율이 책 변화량 + 20%p 초과'이고 줄의 '책 변화량' 칸은 현금성 상쇄까지 뺀 B(`bookDriftPct`)였다. 그래서 E1b형(지난 세션 STOP이 장부에서 대기) 예외 줄이 '판정 회전율 120.5% · 책 변화량 100.0%'로 보여 허용폭을 넘었는데 보낸 것처럼 읽혔고, `over-allowance`로 멈춰도 실제 기준(detail `allowancePct` = min(B° + 20, 150))이 줄에 없었다. 판정·백엔드 detail은 맞음. 고침: 이름표 '판정 회전율이 허용폭(스탑 감소만 뺀 책 변화량 + 20%p) 초과', 이벤트 % 칸에 '허용폭'(판정 회전율 바로 뒤, 숫자일 때만), 명세 §8. 수정 전: 이름표 '회전율이 책 변화량 + 20%p 초과(over-allowance)', 줄에 '허용폭' 없음 | `8182413b` | `93b435d0` |
| QA-801 | S4 · 기록 공백(멈춤 까닭) | 하루 한도 판정(`daily-cap-short`)은 '하루 한도로 못 내는 매수 > 20% 또는 남은 하루 건수로 밀리는 매도 있음'인데 측정값 `sellsDropped`를 판정에만 쓰고 HALT detail(`Verdict.detail`)·묶음 로그(`summary`)에 싣지 않았고 화면 이름표도 앞 갈래만 말했다. 남은 건수가 매도 다리보다 적어 걸린 멈춤(예: 못 내는 매수 13.0%, 밀리는 매도 4)의 줄이 이름표와 숫자가 어긋나고 실제 까닭이 어디에도 남지 않았다. 판정 자체는 맞음(멈춤 쪽). 고침: 멈춤 detail에 `sellsDropped`(개수 — `uncounted`와 같은 규칙, 보냄에는 넣지 않음), 로그 요약에 못 내는 매수 %·밀리는 매도 수, 이름표 '…20% 초과 또는 밀리는 매도 있음', 줄에 '밀리는 매도 n'(0보다 클 때만), ADR 0028 덧붙임·명세 §8. 수정 전: 'Expecting map … to contain entry sellsDropped=4'(순수), 'Expecting value to be true but was false'(DB — HALT detail에 칸 없음) | `3b237f2b` | `d5716cdf` |
| — | 시험 공백(동작은 맞음) | 주식 종목 수 N의 대기 STOP 종목 뺌·'목표 1% 이상' 거름, 유지 종목 축소 K·노출 감소 R의 스탑 제외, 빠진 종목 수 U가 계좌 어긋남 계획의 건너뜀도 세는 것을 고정하는 시험이 없어 그 조건을 느슨하게 바꾸는 변이가 모든 시험을 통과했다(검토자 확인 — 변이 셋 순수 20/20, 여섯 묶음 DB 32/32). 더함: `RealTradeRebalanceTest.stockNamesDustBoundary`(1.0% 듦·0.99% 빠짐)·`stopNamesLeftOutOfNameChecks`(스탑 종목뿐인 '모두 팔기' no-names, 스탑 종목 축소는 K 밖, R 양쪽 스탑 제외)·`uncountedIncludesAccountDriftPlan`, `RealTradeJobDbTest.rebalanceNoNamesHalts`의 스탑 종목뿐 사례. 변이 일곱(N 스탑 제외 삭제·1% → 0.5%·`>=` → `>`·K 스탑 제외 삭제·R 보유 쪽/목표 쪽 스탑 제외 삭제·U 계좌 어긋남 계획 제외)을 하나씩 넣어 모두 새 시험이 잡음을 확인(N 스탑 제외 삭제는 DB 시험도 잡음 — 'expected HALTED but was LIVE') | — | `6e0b369c` |
| — | 문서·시험 공백 | ADR 0028 덧붙임의 시험 목록이 'RealTradeJobDbTest의 rebalance*가 열두 확인 각각의 멈춤을 본다'고 적었지만 `value-unknown`·`derisk-over`·`over-allowance`는 작업 경로(DB) 시험이 없었다. 더함: `RealTradeJobDbTest.rebalanceDeriskAndUnknownValueHalt`(E3 넷 순감 → derisk-over, 책 가격이 빠진 목표 종목 → value-unknown — 작업이 책 가격을 측정에 넘기는지). 교차 확인(`over-allowance`)은 두 셈의 어긋남을 잡는 장치이고 종목마다 삼각 부등식으로 판정 회전율이 대개 책 변화량 + 계좌 어긋남(≤ 20) 안이라 정상 계좌·목표로는 작업 경로에서 만들기 어려워 순수 시험(`judgeTableBoundaries`·`crossCheckUsesStopOnlyDrift`)만이라고 ADR 문장을 고침 | — | `e71bb033` |

- 검토 지적 넷 모두 코드에서 확인했습니다(아니라고 판정한 것 없음). 판정 규칙(입구·임계값·순서)과 보내는 주문 계산은 바꾸지 않았습니다 — 고친 것은 화면 글·기록 칸·로그 요약·시험·문서입니다.
- 시험 실행 중 한 번, 다른 작업 폴더의 백엔드 전체 시험이 같은 때 같은 `macrodash_test`를 써서(공용 잠금 파일을 잡은 프로세스는 없었음 — 추정: 그 실행은 잠금을 쓰지 않음) `RealTradeJobDbTest`의 재선정 시험 29개가 설정 행이 사라진 모양(`No value present`·`expected HALTED but was LIVE`)으로 실패했습니다. 그 실행이 끝난 뒤 잠금 안에서 다시 돌려 33개 모두 통과했습니다(결함 아님).
- 새 결함 번호는 QA-802부터(이 작업의 예약은 QA-809까지).
