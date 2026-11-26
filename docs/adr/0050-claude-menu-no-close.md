# 0050. Claude 계좌 켠 판 메뉴에서 종가(`NEXT_CLOSE`)를 뺌: 정기 결정은 분 단위 지정 시각(`AT_MINUTE`)만, 장중 판단은 장중 시장가·그날 남은 지정 시각, 한국 지정 시각의 끝은 연속 매매 끝 5분 전(보통 날 15:14 KST), 판 `ft-3`·`kr-ft-3`·메뉴 판 5, 스위치 없음(배포가 경계), 장부는 그대로

- 상태: 채택 (2026-11-27 사용자 결정 — "미국·한국 Claude 계좌의 결정으로 내는 매수·매도에서 종가 없애. 정규장 내 장중 시장가, 그날 남은 지정 시각로 매매", 계획 승인과 수정
  "지정 시각을 한국/미국 정규장 개장 10분 후 ~ 마감 5분 전으로 각각", 질문 답 "연속 매매 끝 5분 전 15:14"). **배포 끝 — 2026-11-27 07:28 KST Vultr `main@9075dbae`**(구현 커밋 `0b577b48`·`b6dcbb3a`, 브랜치 `claude/no-close-menu-2026-11`). 아래 문장과 결정 7이 정한 창(2026-11-28 03:00 KST 뒤)보다 앞당겼다 — 사용자 지시 2026-11-27 "모두 지금 배포해"(ADR 0051과 함께). 그래서 첫 효과가 11-30에서 **11-27**로 당겨졌고 프레임 v18·v19·QA-1017의 첫 효과일과 겹친다(아래 결정 7의 적용 줄).
  스위치가 없으므로 `main` 병합 → push → CI → `deploy.sh`를 한 창(2026-11-28 토 03:00 KST 뒤 ~ 11-29 일 밤, 두 시장이 닫혀 있고 대기 Claude `NEXT_CLOSE` 주문과 남은 장중 판단 계획이
  0일 때) 안에서 잇달아 한다. 배포 커밋·시각은 배포 뒤 이 줄과 [ADR 0018](0018-paper-trading-guardrails.md)의 절에 적는다.
- 바꾸는 결정:
  - [ADR 0031](0031-open-offset-window-intraday-budget.md) 결정 2('켠 판 결정 메뉴에서 시가를 빼고 종가는 남긴다') — 종가도 뺀다. 결정이 받는 시점은 `AT_MINUTE` 하나다.
  - [ADR 0031](0031-open-offset-window-intraday-budget.md) 결정 1의 한국 지정 시각 범위(09:10~15:19 KST) — **Claude 계좌의 지정 시각에 한해** 끝을 종가 단일가 시작 5분 전으로(보통 날
    09:10~15:14 KST). 규칙 계좌 체결 시각의 저장 범위·장중 스탑 감시·실제 계좌·ISA·장부 사다리가 받는 범위는 그대로다.
  - [ADR 0027](0027-free-fill-timing.md) 결정 3('교체 … 새 주문이 받는 시점은 장중 시장가 `MARKET`·`AT_MINUTE`·`NEXT_CLOSE`') — `MARKET`·`AT_MINUTE` 둘.
- 함께 보는 결정(문장이 그대로 맞아 개정 표지는 달지 않음): [ADR 0032](0032-paper-intraday-stop-watch.md)(장중 감시 STOP — 15:20 뒤 감지는 그날 종가, 그대로),
  [ADR 0033](0033-real-isa-open-offset-and-stops.md)(실제 계좌·ISA — 규칙 계좌를 따르는 동안 바뀌지 않음), [ADR 0044](0044-market-first-minute-after-creation.md)(장중 시장가 기준 시각 — 그대로),
  [ADR 0018](0018-paper-trading-guardrails.md)(실험 조건 경계 기록).
- 지키는 방법:
  - 메뉴·잠금: `DecisionTimingsLockTest.freeTimingContextsAreLocked`(네 계좌 프로필의 받는 시점 = 결정 스키마 enum = `FreeTiming.DECISION_TIMINGS` = `AT_MINUTE` 하나, 장중 판단 응답 = 장중 판단
    스키마 enum = `INTRADAY_TIMINGS` = `MARKET`·`AT_MINUTE`, 고정 문단의 `NEXT_CLOSE`는 우선순위 줄(프레임 문장 읽는 법)에만, 범위 글자 = `FreeTiming.regularRange` — 미국 09:40~15:54·한국 09:10~15:14,
    미국 켠 판은 체결 절의 종가 줄이 슬리피지 줄로, 한국 켠 판 하드 규칙 줄은 'AT_MINUTE(…)뿐').
  - 창·검증 표: `FreeTimingTest.claudeWindowEndsFiveMinutesBeforeContinuousTradingEnds`(Claude 창 — 한국 15:14·수능일 16:14, 미국은 공용 창 그대로)·`windowIsInsideTheRegularSession`(공용 창은
    15:19 그대로 — 규칙 계좌)·`decisionTableOrdersByTargetTime`(표에 종가 없음, 응답의 시각이 모두 닫혀도 표가 만들어짐)·`closeOrdersAreRejected`(종가 주문은 MALFORMED)·
    `intradayTableStartsAtTheMarketMinute`(한국 15:15·15:19 닫힘), `CheckpointPacketTest.freeRemainingOptions`·`KrIntradayPacketTest.remainingMinutes`·`remainingTimings`(장중 판단 남은 시점에 종가 없음,
    한국 지정 시각은 15:14까지).
  - 결정·장중 판단: `FreeTimingDecisionTest.claude1SwitchSelectsTheVariantButNotForTheOldCheckpoint`(종가 응답은 스키마 위반 — 형식 오류, 주문 행 없음)·`claude2SwitchSelectsTheVariantAndAtMinuteOrdersBecomeRows`
    (받는 마지막 분 15:54), `PaperIntradayJobTest.replaceSupersedesOnlyOrdersAheadAndAcceptsTheTwoTimings`(옛 판의 대기 종가 주문은 교체로 취소, 새 주문은 둘), `KrStartTest.krFreeTimingDecisionsUseTheOnVariant`
    (한국 15:14 받음·15:15 거절).
  - 고정본: 켠 판(`-ft-`) 23개만 다시 만들었고 끈 판 고정본은 바이트 그대로(같은 시험들이 함께 대조). 고정본을 해시로 지키는 'ADR 0030·0044 문장만 바뀜' 시험의 켠 판 해시는 이 판으로 갱신했다
    (`PacketBuilderTest.usCostFieldsAreTheOnlyPacketChange`·`onlyTheStopTimingSentenceChanged`, `KrPacketBuilderTest.onlyTheStopTimingSentenceChanged`, `CheckpointPacketTest.onlyTheEstimateNoteChangedForCosts`·
    `onlyTheMarketSentenceChangedForFirstMinute`, `FreeTimingDecisionTest.onlyTheMarketSentenceChanged`, `KrStartTest.onlyTheMarketAndStopSentencesChangedInTheKrIntradayPacket`).
  - 장부(바꾸지 않음): 옛 판에서 만든 대기 주문이 만든 그대로 체결되는 것은 기존 전환 시험(`UsTimedFillsTest.ordersMadeUnderTheOldWindowFillAsMade`·`KrLedgerTest.ordersMadeUnderTheOldWindowFillAsMade`)과
    장부 시험이 그대로 지킨다. 화면: `paperAccount.test.ts`(설정 설명 글).

## 배경
ADR 0031(2026-11-06)은 켠 판 결정 메뉴에서 시가를 빼고, 종가 단일가는 공식 종가와 같은 가격이라 남겼다. 2026-11-10~11-27 네 Claude 계좌의 결정 주문(거절 제외) 22건 가운데 종가는
4건이었고(미국 계좌1 SPY 매도·계좌2 XLP 매도·한국 계좌2 069500 매수 둘), 넷 다 '밤사이 선물 갭 뒤 개장 변동을 피해 하루 흐름을 본 뒤'라는 이유였다. 장중 판단이 낸 종가 주문은 없었다.
사용자는 Claude 계좌의 매매를 정규장 안의 장중 시장가와 지정 시각으로만 하기로 했다.

한국은 15:20~15:30이 종가 단일가 시간이라 그 사이에 낸 주문은 15:30 종가로 체결된다. '마감(15:30) 5분 전'을 그대로 쓰면 15:20~15:25 지정 시각이 사실상 종가 주문이 되고,
지금 장부 사다리는 이 시간의 지정 시각을 받지 않는다(`KrTimedLadder` — 마감 10분 전부터 MALFORMED). 미국 지정 시각(09:40~15:54 ET, 15:55 앞까지)은 이미 마감 5분 전이다.

## 결정
1. **정기 결정이 받는 체결 시점은 `AT_MINUTE` 하나다.** 네 Claude 계좌(미국·한국 계좌1·계좌2)의 켠 판 결정 응답 스키마(`us-decision-ft`·`us-decision-ft3`·`kr-decision-ft`·
   `kr-decision-ft3`)의 `timing` enum, `FreeTiming.DECISION_TIMINGS`, 프로필 이름표, 프롬프트·패킷의 시점 문장에서 종가를 뺀다.
2. **장중 판단의 새 주문은 장중 시장가 · 그날 남은 지정 시각이다.** 장중 판단 응답 스키마(`us-intraday-ft`·`kr-intraday-ft`)와 `FreeTiming.INTRADAY_TIMINGS`, 장중 판단 패킷의
   남은 시점(`1_basis.remainingTimings`)·문장에서 종가를 뺀다. 결정에서만 빼면 장중 판단을 거쳐 종가로 갈 수 있다.
3. **Claude 계좌의 지정 시각 범위: 개장 10분 뒤 ~ 연속 매매 끝 5분 전.** 미국은 그대로(마감 5분 전 앞까지 — 보통 날 09:40~15:54 ET, 조기 폐장일 09:40~12:54). 한국은 종가 단일가 시작
   (마감 − 10분)의 5분 전 앞까지 — 보통 날 09:10~15:14 KST, 장 시간 변경일은 그날 개장·마감에서 같은 간격(수능일 10:10~16:14). 값은 `FreeTiming`의 상수 하나이고, 결정·장중 판단의
   검증 표와 패킷의 `1_basis.atMinute`가 같은 창을 읽는다. 규칙 계좌의 체결 시각 저장 범위(`RuleTiming` — 09:10~15:19 KST)·장중 스탑 감시 격자·장중 시장가 상한·실제 계좌·ISA·장부 사다리는
   `analytics.SessionWindows`의 창 그대로다.
4. **판 표시를 올린다**: `ft-2` → `ft-3`, `kr-ft-2` → `kr-ft-3`, `13_execution.executionMenuVersion` 4 → 5. 켠 판 고정본만 다시 만들고, 끈 판 고정본은 바이트 그대로다.
   **스위치는 두지 않는다** — 네 Claude 계좌가 모두 켠 판이고, 배포가 실험 조건 경계다(ADR 0031·0044 선례).
5. **장부는 바꾸지 않는다.** 종가 체결 코드는 장중 감시의 종가 STOP, 규칙 계좌 설정(`rules.timing`·`kr.rules.timing`의 `NEXT_CLOSE`), 끈 판, 옛 판에서 만든 대기 주문이 쓴다.
   배포 전에 만든 대기 주문(종가·한국 15:15~15:19 지정 시각)은 만든 그대로 체결하고, 장중 판단의 교체(REPLACE)는 기준 시각이 남은 옛 종가 주문도 지금처럼 취소한다. 응답에 종가가 오면
   응답 스키마 위반이라 그 응답은 형식 오류(주문 행 없음)이고, 검증 표에서도 받지 않는 시점(MALFORMED)이다.
6. **프롬프트에 대신 쓸 시각을 안내하지 않는다.** '흐름을 보려면 늦은 분' 같은 글은 판단에 손대는 것이라, 메뉴만 바꾸고 시각 선택은 Claude에게 맡긴다.
7. **적용**: 배포는 2026-11-28(토) 03:00 KST(미국 11-27 조기 폐장 세션 끝) 뒤, 실제 매매 창 밖. 배포 직전 서버 읽기로 대기 Claude `NEXT_CLOSE` 주문 0행·남은 장중 판단 계획 0행을
   확인한다. 첫 효과는 한국 2026-11-30 07:00 KST 결정, 미국 11-30 22:45 KST 결정이다 — 프레임 v18·v19의 첫 효과일(11-27)과 날이 다르다('실험 조건을 한 날 한 번').
   - **실제 적용(2026-11-27 07:28 KST 배포 — 사용자 지시로 앞당김)**: 배포 직전 서버 읽기(07:26 KST) — 네 Claude 계좌의 대기 주문 0행(`NEXT_CLOSE` 포함), 남은 장중 판단 계획 0행,
     한국 11-26 세션 기준 정기 결정 #278·#279는 07:09에 옛 판(`kr-ft-2`)으로 끝남(둘 다 주문 없음). 실제 매매 창(평일 08:45~15:35 KST) 밖.
     첫 효과: **한국 2026-11-27 세션의 장중 판단(10:00·14:50 KST — 그 세션 결정은 옛 판), 미국 2026-11-27 22:45 KST쯤 정기 결정(기준일 11-25)**,
     한국 정기 결정은 2026-11-30 07:00 KST(기준일 11-27)부터. 미국은 프레임 v18·v19·QA-1017의 첫 결정과 이 메뉴의 첫 결정이 같은 결정이라
     '실험 조건을 한 날 한 번'을 지키지 못했다 — 이 결정부터의 변화는 세 변경을 가를 수 없다.

## 이유
- 사용자 결정: Claude 계좌의 매매는 정규장 안의 장중 시장가와 지정 시각으로만 한다.
- 한국 끝을 15:14로: 15:20~15:30 안의 분은 종가 단일가로 체결되어 종가가 지정 시각 이름으로 돌아온다. 두 시장을 '연속 매매 끝 5분 전'으로 맞춘다(미국 16:00 − 5분, 한국 15:20 − 5분).
- 공용 창(`SessionWindows`)을 바꾸지 않음: 사용자 범위가 Claude 계좌다. 그 창은 규칙 계좌(대조군)·장중 스탑·실제 돈 경로가 함께 읽는다.
- 스위치 없음: 네 계좌 모두 켠 판이라 끈 판 몫은 쓸 일이 없고, 켠 판 고정본이 두 벌이 된다.

## 대안과 버린 이유
- **한국 15:25(문자 그대로)**: 15:20~15:25가 종가 단일가 안이라 사실상 종가이고, 장부 사다리를 고쳐야 한다.
- **한국 15:19 그대로**: 사용자 결정이 15:14다.
- **결정에서만 빼기**: 장중 판단의 '그날 종가'로 종가가 남는다.
- **계좌별 스위치**: 위 '이유'.
- **공용 창을 15:14로**: 규칙 계좌·스탑·실제 계좌가 함께 바뀌어 범위 밖이다.

## 결과와 남은 위험
- 종가를 고르던 날(개장 갭)에는 늦은 지정 시각을 고를 것으로 보인다(추정). 마감 직전 분에 거래가 없으면 사다리의 대체 체결로 종가 쪽 가격이 될 수 있다 — 미국은 1분봉 사다리의 마지막 단계가
  확정 종가이고, 한국은 기준 분과 그 뒤 4분(봉 라벨 T+1~T+5) 안에 거래가 없으면 그날 T 뒤 첫 거래 봉(종가 단일가 봉일 수 있음)의 시가다(R2b). 지금 유니버스의 대형 종목·ETF에서는 드물다.
- 구현 중 찾은 것: 정기 결정의 검증 표가 지정 시각 하나라 응답의 시각이 모두 범위 밖이면 받는 열쇠가 없어 표 계산이 빈 목록에서 멈출 수 있었다(종가가 늘 받는 시점이던 동안에는 생기지 않음) —
  그때는 닫힌 시점들이 같은 순위로 표를 이룬다(`FreeTiming.validation`).
- 켠 판 프롬프트가 바뀌어 계좌마다 프롬프트 캐시를 한 번 다시 쓴다.
- Claude 계좌 성과 곡선은 11-30 앞뒤로 체결 시점 메뉴가 다르다.
