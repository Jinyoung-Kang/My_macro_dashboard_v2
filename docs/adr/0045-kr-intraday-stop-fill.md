# 0045. 한국 장중 감시 STOP 체결을 장중에 장부에 적음(1단계): 스위치 `kr.stopWatch.fill`(OFF·SHADOW·ON, 기본 OFF) · 감시 저장본의 R1만 · 기록 전 관문 G1~G6 · 실제 계좌·ISA는 그 세션 밤 처리 전까지 대기로 봄(거울 보기) · 금융위 D 순자산 줄은 되감아 확정 · 밤 대조 자료와 사후 점검

- 상태: 채택 (2026-11-18 사용자 결정 — 한국 봇의 스탑 체결 알림이 밤 21시대에 오는 것을 본 뒤 "스탑 체결을 장중에 기록하고 알림", 계획 2판 작업 3 '지금 구현까지 승인' + 권장안:
  D8 이 ADR, D9 거울 보기 채택('실제 동작 무관'은 따라 하는 책이 규칙 계좌일 때로 한정 — 실제 돈 경로가 읽는 뜻이라 사용자 승인 2026-11-18), D10 (b) 밤 대조 자료(수집기 읽기 확장, 호출 수 그대로),
  D11 SHADOW 기준, D12 (가) 금융위 D 줄 되감기, D13 G3 보수적, D17 저장은 장 마감 뒤 ~ 다음 정기 결정 전). **구현 끝, 배포 전**(브랜치 `claude/kr-intraday-stop-fill-2026-11`).
  스위치 기본값이 `OFF`라 배포만으로는 장부·패킷·실제 계좌 동작이 바뀌지 않는다(OFF에서는 장중 기록이 없어 떼어 낸 함수·거울 보기·D12 갈래가 모두 지금과 같은 길). **SHADOW·ON 저장은
  각각 사용자에게 다시 확인받는다**(한국 한 시장 — ADR 0032 결정 5 선례). 배포 커밋·시각과 저장한 설정 판은 배포·저장 뒤 이 줄과 [ADR 0018](0018-paper-trading-guardrails.md)의 절에 적는다.
- 바꾸는 결정:
  - [ADR 0032](0032-paper-intraday-stop-watch.md) 결정 6('한국은 그날 밤 장부') — 스위치를 ON으로 저장한 동안, 관문을 지난 R1 체결은 장중에 장부에 적는다. 체결가·기준 시각 T·재판정 없음·재진입 금지 마감일은 그대로.
  - [ADR 0033](0033-real-isa-open-offset-and-stops.md) 결정 4 덧붙임 — 실제 계좌·ISA가 읽는 모의 공개 창(`PaperMirrorService`)이 장중 기록 STOP을 그 세션 밤 처리 전까지 대기 STOP으로 되감아 본다(결정 7).
  - [ADR 0021](0021-kr-paper-prices-fills-start.md) 결정 3 일부(확정 순자산 줄 — 결과의 '장부 상태가 그날 마감일 때만 다시 쓴다' 포함) — D 뒤 체결이 모두 장중 기록 STOP 매도이고 관측일이 D 다음 거래일이면
    그 매도를 되감아 D 줄을 다시 쓴다(결정 8).
  - [ADR 0039](0039-fixed-intraday-preopen-briefing.md) 결과 '한국 16:00 브리핑의 한계'의 '순자산·체결은 직전 처리 기준' — 그 세션에 장중 기록 스탑이 있으면 그 반영을 함께 적는다(결정 11).
- 함께 보는 결정: [ADR 0044](0044-market-first-minute-after-creation.md)(장중 시장가 T = 생성을 분으로 내린 뒤 + 1분 — 이 문서의 T는 그 식, SHADOW 대조는 0044 배포 뒤에 모아야 뜻이 있음),
  [ADR 0008](0008-backend-owned-tables-and-scheduled-jobs.md)(장부 표는 백엔드만 쓰고 수집기는 `paper_orders`·`paper_fills`·`paper_positions`를 읽기만), [ADR 0018](0018-paper-trading-guardrails.md)(실험 조건 경계 —
  아래 '결과'의 문안을 SHADOW·ON 저장 때 옮겨 적음), [ADR 0028](0028-real-trade-mirror.md)(실제 매매 쓰기 경로 — 바뀌지 않음).
- 지키는 방법(시험):
  - 가격 동치(같은 함수, 두 길): `KrIntradayFillParityTest.bothPathsAgree`·`correctedCaseIsCaughtByTheCheck`와 수집기 `test_kr_intraday_fill_parity.py`(같은 표 `backend/src/test/resources/paper/kr-intraday-fill/cases.json`),
    `KrTimedLadderTest.extractedFunctionsGiveTheSameAnswers`(떼어 낸 Timed 판·`KrFills.termsFor`가 옛 함수와 같은 값), `KrIntradayFillTest.timedWindow`·`r1AndTheLookAheadTrap`(라벨 T 봉 반례).
  - 대상·관문: `KrIntradayFillTest.candidates`·`gateAt`·`orderGateTable`(G3)·`corpGateFour`(G4)·`nightCheck`·`nightCheckComparesCosts`(QA-792), `RealTradePlannerTest.paperStopGateMatchesStopWindow`(G5 — 실제 매매 창 식과 같은 표),
    `KrStopFillTest.effectiveTable`(유효 값 = 감시 ON일 때만 그 값 — G1과 글 스위치가 함께 씀).
  - 단계(가짜 저장소): `KrStopFillStepTest` — SHADOW `shadowRecordsOnce`·`gatesDefer`·`givesUpBeforeTheClose`·`decidedNoR1IsRecordedAtOnce`·`checksAfterTheNight`, 스위치 `switchOff`, 잠금 `readsOutsideTheLedgerLock`·
    `discardsWhenTheOrderMovedOn`, ON `onWritesTheLedger`·`onDefersUntilTheGateClears`·`onWritesTwoStopsInOneTransaction`(체결 알림 묶음 한 통 포함)·`onDiscardsWhenPendingOrdersChanged`·
    `onDiscardsWhenTheLedgerProcessedDuringTheEvaluation`(QA-790), ON 실제 쓰기 → 거울 보기 `onWriteIsRewoundByTheMirror`(공개 창 여덟 값이 기록 전과 같음 — 뒤 주기의 다른 트랜잭션까지,
    S 밤 처리 뒤에는 되감지 않음), 작업 `jobCallsTheStepEveryCycle`.
  - 동치와 그 전제(실제 저장소·실제 밤 장부 — macrodash_test): `KrIntradayStopFillDbTest.intradayThenNightEqualsNightOnly`(장중 기록 → 금융위 D 도착·확정 조정 → S 밤 처리 = 밤 일괄, 뒤 시각 규칙 매수 포함, 사후 점검 일치)·
    `twoStopsInOneTransactionEqualNightOnly`(같은 분 STOP 둘 한 트랜잭션)·`oneOfTwoStopsDeferredEqualsNightOnly`(둘 가운데 하나만 G4로 밤 — 보유 레코드 밖 칸 `fill_ref_volume`·`corp_action_hold`와
    확정 조정 행 수도 견줌)·`d12ProvisionalWithoutTheRow`·`nightWithoutTheTickerBreaksEquivalence`(동치가 깨지는 길 1 — S+1 시가 목표가 갈리는 범위 표시)·`nightStaleTickerBreaksEquivalence`(길 1 이어받음)·
    `pauseBetweenRecordAndNightBreaksEquivalence`(길 4 — ON 사후 점검·SHADOW 대조 모두)·`nightCorporateActionBreaksEquivalence`(길 5)·`costSaveBetweenRecordAndNightIsCaught`(알려진 차이(경제적) — 비용 키 저장, ON·SHADOW 모두
    `COST_MISMATCH`·`SETTINGS_CHANGED`)·`rollsBackWhenTheOrderIsNoLongerPending`(조건부 갱신 0행 → 그 책 되돌림). 이 시험의 밤 세계 1분봉은 장중 길 함수(`KrIntradayFill.timed`)로 만든다 — 두 길의
    가격이 같은지는 위 '가격 동치'가 따로 지킨다. 길 2(1분봉 `FAILED` — 밤 사다리 기다림 뒤 다음 세션 관측치)·길 6은 사후 점검(`KrStopFillStep.night`)의 갈래로 다루고, 그 갈래를 거치는 시험은 아직 없다.
  - 거울 보기: `PaperMirrorServiceTest.mirrorRewindsIntradayRecordedStop`·`mirrorStopsAfterTheNight`·`mirrorWhenTheNightIsLate`·`mirrorAfterPause`·`mirrorRewindsByTheProcessedSession`·`mirrorCashIsExactAfterAConfirmationShift`·
    `mirrorDoesNotUndoLaterOrders`(Claude 계좌를 따를 때의 범위 표시), `PaperMirrorIntradayDbTest.mirrorIsTheSameWithTheRealStore`(대기 STOP 종목과 시각 목표를 한 주기에 함께 읽음),
    `PaperStoreDbTest.intradayRecordedStopReadsAndWrites`(jsonb 조건 SQL).
  - D12: `KrConfirmationsTest.d12RewindsIntradayStopForTheConfirmedLine`·`d12RewoundLineStaysProvisionalWithoutTheRow`·`d12DoesNotRewindOtherFills`, DB 쪽 `KrIntradayStopFillDbTest`의 P 줄 비교.
  - 밤 대조 자료·감시 범위(수집기): `test_kr_paper_timed.py::test_장중에_장부에_적은_감시_STOP은_대기가_아니어도_그_기준_분_창을_받는다`(실제로 그 종목·세션을 받음, 수명 밖은 받지 않음),
    `test_paper_stopwatch.py::test_한국_범위는_그_세션에_장중_기록으로_판_종목도_담는다`.
  - 글·고정본: `StopWatchTest.krFillPhraseIsTheOnlyChange`(끈 판·대조 판 규칙 글 = ADR 0045 전 고정본의 `1_basis.stopWatch.rule`), `KrPacketBuilderTest.stopWatchFillOnPacket`(새 고정본 `packet-kr-ft-stopwatch-fill-scheduled.json` — 그 구절만 되돌리면 감시 ON 고정본, SHADOW는 그 고정본 그대로),
    `KrStartTest.goldenKrFreeIntradayPacketWithStopFill`(새 고정본 `packet-kr-ft-intraday-stopwatch-fill.json` — 구절과 장부 글만 되돌리면 `packet-kr-ft-intraday-stopwatch.json`),
    `KrStartTest.ledgerNoteFollowsTheIntradayRecordAfterSwitchingOff`(QA-791 — 기록 뒤 OFF여도 장부 글은 자료로)·`krClaude2CheckpointLedgerNoteFollowsTheIntradayRecordAfterSwitchingOff`(같은 것의 끈 판 장중 확인 쪽), `BriefingTest.krLedgerNoteFollowsTheIntradayRecord`. OFF(키 없음)의 기존 고정본
    (`packet-kr-ft-stopwatch-scheduled.json`·`packet-kr-ft-intraday-stopwatch.json`·`packet-kr-claude2-checkpoint.json`·`render-kr-ft-claude-v0-stopwatch.txt` 등)은 기존 고정본 시험이 바이트로 지키고,
    SHADOW는 `KrPacketBuilderTest.stopWatchFillOnPacket`(결정 패킷)·`KrStartTest.shadowKeepsTheKrFreeIntradayPacketBytes`(장중 판단 패킷)·`krClaude2CheckpointPacketWithStopFill`(끈 판 장중 확인 패킷 —
    SHADOW는 바이트 그대로, ON은 장부 글만)·`PaperBriefingJobTest.krLedgerNoteReadsTheIntradayRecordMode`(마감 브리핑 — 근거 mode가 SHADOW면 예전 안내 글)가 지킨다.
  - 설정·화면: `PaperSettingsServiceTest.krStopFillKey`, `KrRuleBookServiceTest`(규칙 계좌 영향 키), `frontend/src/lib/__tests__/paperStopWatch.test.ts`(세 프로필 키·이름표·스탑 문장).
  - 고치지 않고 통과하는 경계: `ArchitectureRulesTest.realtradeIsIsolated`, 수집기 `test_toss_trade.py` 쓰기 금지·`test_table_ownership.py`, `isaBoundary.test.ts`·`realtradeBoundary.test.ts`, `RealTradeJobDbTest`·`ManualAccountJobDbTest`.

## 배경

장중 스탑 감시(ADR 0032)는 스탑을 장중 가격으로 체결하지만, 한국 장부는 밤 관측치가 들어온 뒤 하루 한 번(20:40~21:20) 체결을 적는다. 그래서 체결 알림이 밤에 오고, 그동안
화면에는 판 종목이 보유로 남으며, Claude 장중 판단 패킷의 현금·보유도 스탑 전 값이다. 미국 장부는 매시 처리하므로 한 시간 안에 적힌다. 사용자는 한국 스탑 체결을 장중에 기록하고
알리기를 원했다(지시문 2026-11-18 작업 3). 감시 저장본(`paper.stopwatch.kr`)이 5분마다 보유 종목의 토스 1분봉을 이미 받으므로, 다음 저장본에 기준 분 T의 봉이 들어 있어 외부 호출을
늘리지 않고 감지 몇 분 뒤 체결을 적을 수 있다. 문제는 실제 돈 경로다 — 실제 계좌·ISA는 모의를 `PaperMirrorService`의 대기(PENDING) 주문으로 읽으므로, 장중에 STOP이 체결로 바뀌면
'대기 STOP 종목 매수 금지'·놓침 집계·ISA 스탑 지시·세션 지시의 목표가 달라진다.

## 결정

1. **스위치** `kr.stopWatch.fill` = `OFF`·`SHADOW`·`ON`(기본 `OFF`, 키가 없는 행도 OFF, 규칙 계좌 영향 키). **유효 값**은 한 술어 `KrStopFill.effective`로 정한다 — `kr.stopWatch.mode = ON`일 때만
   그 값, 아니면 OFF(감시가 주문을 내지 않으면 대상 STOP이 없다). 관문 G1과 글 스위치(결정 11)가 같은 술어를 쓴다.
   - `SHADOW`: 장부를 쓰지 않는다. '장중에 적었을 것'(R1 값·비용·관문 판정)을 주문 근거 `intradayFill`에 한 번 남기고, 밤이 그 주문을 닫은 뒤 밤 체결과 견준다(대조만 — AI 입력·장부·실제 계좌 무변경).
   - `ON`: 관문을 모두 지난 R1 체결을 장중에 장부에 적는다. 관문에 걸린 STOP은 대기 그대로라 그날 밤 장부가 지금처럼 체결한다.
2. **범위(1단계)**: 장중 감시 STOP(`stopMode INTRADAY_WATCH`)·장중 시장가(`MARKET`)·목표 세션과 만료일이 그 세션·T가 종가 단일가 앞인 것, 운용 중이고 벤치마크가 아닌 한국 책(규칙·Claude 계좌1·2).
   같은 STOP의 R2·R2b·체결 불가, 감시 STOP의 첫 분 `AT_MINUTE`·종가, 밤 대체 STOP(`NIGHT_FALLBACK` — 금융위 재판정), 미국, 규칙 09:10 주문·Claude 지정 시각·장중 판단 주문은 지금처럼 밤이다
   (2단계는 따로 승인).
3. **원천과 가격 동치**: 감시 저장본의 그 종목 항목(완성 봉 40개, 라벨 = 봉 끝)으로 밤 `kr_paper_timed.summarize_windows`와 같은 규칙의 창을 만들고(`KrIntradayFill.timed`), **밤과 같은 사다리 함수**
   (`KrTimedLadder.price`의 Timed 판 — 떼어 낸 것)를 부른다. 결과가 R1(`TOSS_1M_AT` — 라벨 T+1 봉 시가)일 때만 받는다 — 저장본은 '아직 없음'과 '없음'을 가리지 못하므로 R2 이하는 밤에 맡긴다.
   안정 조건: 항목이 그 세션 것이고 이어받지 않았음, **종목 항목** `fetchedAt` ≥ T + 1분 + 60초, 라벨 T+1 봉 거래 있음. 라벨 T 봉(생성을 품은 분)은 창 키 T의 첫 라벨이 T+1이라 고르지 않는다.
   감시 항목은 종가가 비거나 0인 봉을 버리고 밤 요약은 거르지 않는다 — 장중이 R1을 못 고르는 쪽(밤에 맡김)이라 안전하다(대조 표에 사례). 기존 관례(백엔드 시험이 수집기 시험 표를 읽음)와 달리
   이 표는 백엔드 시험 자원의 JSON을 두 쪽이 읽는다(새 꼴 — CI 두 job 모두 저장소 전체를 씀).
4. **기록 전 관문**(SHADOW는 판정만 남기고, ON은 모두 지나야 씀):
   - **G1** 스위치 유효 값·세션 S 거래일·`[첫 판정 격자, 마감)`·책 운용 중·대상 STOP(결정 2).
   - **G2** 장부 밀림 — `PaperMirrorService.ledgerCaughtUp(book, S)`를 그대로(실제 매매·ISA와 같은 조건, QA-331·336의 낮 재처리가 장중 기록보다 늦게 들어와 순서가 뒤집히지 않게).
   - **G3** 시간 순서 — 밤 `processAuction`처럼 날짜를 보지 않는 `LocalTime` 순서로, 그 책 대기 주문(만료일 < S 빼고) 가운데 (a) 시가 주문이 하나라도, (b) 장중 시각 ≤ T인 주문(다른 종목 STOP 매도는 빼고 —
     매도는 현금을 쓰지 않아 서로 결과를 바꾸지 않음), (c) 같은 종목 주문이 있으면 밤에 맡긴다(D13 — 보수적, SHADOW `reasons` 분포를 본 뒤 완화를 따로 정함). 같은·이른 T의 다른 종목 STOP들은 한
     트랜잭션에 시각 순으로 함께 적는다.
   - **G4** 기업행위(밤 `corporateActions`가 보류했을 STOP을 장중이 먼저 팔지 않게): ① 미처리 기업행위 표시 `CORP_HOLD`, ② 보유 since 봉 ≠ S−1 `CORP_SINCE`, ③ 같은 항목의 감시 갭 가드가 통과가 아니거나
     전일 원시·수정 종가가 없거나 그 날짜 ≠ S−1 `CORP_GUARD`(가드는 수정 값이 없으면 통과시키므로 더 엄하게), ④ 금융위 상장 상태 신호(`KrxCorporateActions.assess` — since 봉 하나, 상장주식수 ±10% 등)
     `CORP_LISTING`. 넷을 모두 남긴다(통계).
   - **G5** 실제 계좌 창 — 지금 ≥ `SessionWindows.krStopMirrorEnd`(모의 달력으로 센 실제 스탑 창 끝 — 시작 max(T, 개장 + 30초, 개장 + 10분), 끝 min(시작 + 3분, 종가 단일가 − 30초)) + 60초.
     예: 감지 09:10:30 → T 09:11 → 창 끝 09:14 → 09:15 뒤 기록. 거울 보기(결정 7)가 있으므로 이중 방어다.
   - **G6** 금융위 D 줄 — 결정 8((가) 되감기)이라 관문이 없다.
   - 체결 조건: `KrFills.termsFor`(밤 `terms`에서 떼어 낸 요율·종목 구분·세율 시행일·호가 경고). 금융위 시장 구분이 없거나(`NO_FSC_MARKET`) 보류면(`HOLD`) 밤에 맡긴다. 보유가 없으면 `NO_POSITION`.
5. **잠금과 쓰기**(ON): 저장본·금융위 시장 구분·확정 시세·장부 밀림·기업행위 판정은 장부 잠금 밖에서 한다(실제 매매 선점이 같은 잠금을 기다림). 잠금 안에서는 책마다 한 트랜잭션으로 그 책의
   대기 주문 번호 집합과 마지막 처리 저장본(그 책의 판정 입력보다 먼저 읽은 값 — 잠금 밖 판정 중에 끼어든 밤 장부 처리도 잡게, QA-790)이 판정 때와 같은지 다시 읽어, 다르면 그 책을 버리고(다음 주기에 다시 판정), 같으면 기준 시각 순으로 주문마다 밤 `auctionSell`과 같은 칸을 쓴다 —
   체결 행(관측 시각 = 감시 항목을 받은 시각, 관측일 S, 출처 R1, 비용 칸), **대기일 때만** 체결로 바꾸는 갱신(0행이면 예외 → 그 책 기록 전체 되돌림·대기 그대로), 보유 삭제(전량), 재진입 금지(체결한 날부터 —
   밤 `stopLockout`과 같은 값·글), 근거(밤 `annotate`와 같은 판정 근거 칸·호가 경고 + `intradayFill` — 결정 10), 상태는 현금·순자산·평가액·노출 네 칸만(`PaperStore.updateStateValuation` — 마지막 관측·처리
   시각과 순자산 줄 날짜는 그대로, 멱등 키와 결정 관문 세션 판정이 바뀌지 않게). 현금은 밤처럼 체결마다 소수 넷째 자리로 더한다. 순자산 줄은 쓰지 않는다(밤 `settle`). 작업 기록 `kr.stopwatch.fill`(근거·기록·
   대조·알림·오류가 있을 때만, 잠금을 쥔 시간 `lockMillis`). 미룬 사유는 작업 기록에만 처음 한 번(사유가 바뀌면 다시) 남기고, 같은 감시 저장본으로는 다시 판정하지 않는다.
6. **밤과의 관계**: 밤은 대기 주문만 읽으므로 장중에 적은 STOP을 다시 체결하지 않는다. 기록하지 못한 날(봉 없음·이어받음·수집 실패·재기동·관문·예외)은 주문이 대기로 남아 지금처럼 밤이 적는다.
   장중 기록 + S 밤 = 밤 일괄인 까닭: 만료(만료일 S)·재진입 금지 정리·뒤 시각 매수 거절이 두 세계에서 같고, 체결 뒤에 도는 `raiseKrxWatermarks`·`detectStops`·`revalueAuction`·`advanceSince`는 그 종목이
   보유에 없어 밤 일괄에서 STOP이 판 뒤와 같다. `corporateActions`는 **체결보다 먼저** 돌아(`processAuction`) 밤 일괄에서는 그 종목을 판정한다 — 그래서 아래 길 5가 있다.
   **동치의 전제**: 밤이 그 STOP을 S 밤에 체결했을 경우에만 성립한다. 밤만 체결하지 않는 길이 여섯 있다 — 1) S 밤 관측치에 그 종목이 없거나 이어받은 항목·보유 확인 안 됨, 2) `paper.kr.timed`가 그 칸을
   FAILED로 둔 채 만료, 3) 밤 기준 금융위 시장 구분이 없거나 세율 시행일 전이라 보류(기록 뒤 금융위 행이 바뀐 경우), 4) 기록 뒤 밤 전에 그 책을 일시정지(대기 주문 취소), 5) S 밤 기업행위 판정이 그 종목을
   '없음'이 아니게 봄(보류·분할 반영·미처리 표시 → `heldByCorporateAction`), 6) S 자료의 첫 처리가 S+1 세션으로 셈해지거나 그 책의 S 처리가 실패한 채 다음 세션으로 넘어감(1단계 만료가 체결보다 먼저 닫음).
   이때 밤 일괄은 그 STOP을 만료·취소로 닫고 보유가 남지만 ON 장중 기록은 이미 판 채 남는다(되돌리지 않음). SHADOW의 `NIGHT_NOT_FILLED`와 ON 사후 점검(결정 10)이 이 길을 모두 잡는다.
7. **거울 보기**(실제 계좌·ISA — ADR 0033 결정 4 덧붙임, 사용자 승인 2026-11-18): `PaperMirrorService`의 대기 주문·보유·현금을 읽는 모든 창(`openTargets`·`targetsAt`·`weightAfter`·`dueOrders`·
   `pendingStopSymbols`·`claim`·`orderStatus`)이 한 장부 사본(`mirrorLedger`)을 본다 — 출처 STOP·체결·근거 `intradayFill.mode = ON`이고 체결일 > `targetSession(마지막 처리 저장본)`(마지막 처리가 없으면 모두)인
   행마다 따로, 부른 세션과 상관없이(S−1 밤 처리가 S 낮으로 밀린 날도) 그 주문은 대기, 보유는 기록 직전 사본(`intradayFill.before`), 현금은 기록 트랜잭션마다 뒤에서부터 되감는다(지금 현금이
   기록 직후 값과 같으면 기록 직전 값 그대로, 다르면 십진수로 '지금 − (직후 − 직전)' — 상태 현금 열과 같은 소수 넷째 자리라 비트까지 같음). 목표 세션·만료·지난 STOP 거름은 대기 주문과 같은 코드가
   한다(감시 STOP 만료일 = S라 S+1 세션에서는 두 세계 모두 빠짐). 기록 뒤 S 밤 전에 책을 일시정지하면 일시정지 트랜잭션이 근거에 `pausedAt`을 남기고, 공개 창은 그 행의 보유·현금만 되감고 주문은 넣지
   않는다(밤 일괄의 '취소 + 보유 남음' — 상태는 `CANCELLED`로 보임). realtrade 코드와 경계 시험은 그대로다(읽는 뜻만 바뀜 — 실제 계좌 자료는 모의로 들어가지 않음).
   - **'실제 동작 무관'의 조건**: 따라 하는 책이 규칙 계좌(지금 — ISA는 늘 `kr_rules`)이고 S 밤이 그 STOP을 체결할 때만이다. Claude 계좌를 따르면 ON이 Claude의 입력(장중 판단 패킷의 현금·보유·
     REPLACE 문맥·사건 대상)을 바꿔 그 뒤 주문 자체가 달라지고, 되감기는 그것을 되돌리지 못한다(`mirrorDoesNotUndoLaterOrders`). S 밤이 그 STOP을 체결하지 않으면(결정 6의 여섯 길) S 밤 처리로
     되감기가 끝난 뒤 밤 일괄 세계에는 그 종목 보유가 남아 S+1 묶음·ISA 세션 지시가 S에 실제로 판 그 종목을 다시 사지만, ON 세계는 보유가 없어 사지 않는다 — S 밤 처리 뒤 첫 세션부터 실제 돈이
     갈린다. ON 뒤에 이런 일이 생기면 사후 점검이 운영 알림(사유 코드 `NIGHT_NOT_FILLED`)으로 알리고 되돌리지 않는다(D11).
8. **금융위 D 순자산 줄**(D12 (가) — ADR 0021 결정 3 일부 개정): `KrConfirmations.confirmRead`가 줄(거래일 D)을 다시 쓰기 전에 되감을 STOP을 읽는다 — 마지막 처리 세션이 D이고, D 뒤 체결이
   하나 이상이며 **모두** 장중 기록 STOP 매도이고 관측일이 D 다음 거래일이며 기록 직전 보유 사본이 있을 때. 그때 판 종목을 금융위 D 시세 읽기에 더하고, 줄을 셀 사본에만 보유를 되살리며(수량은 체결 행,
   평단·평가 가격은 사본 — 저장된 보유·상태 현금은 그대로), 줄의 현금은 확정 조정을 반영한 현금에서 체결 행의 현금 흐름(`KrxCosts.cashFlow(SELL, 체결가 × 수량, 수수료, 세금, 슬리피지)` — `confirmFill`의
   잠정 쪽과 같은 식)을 뺀다. 그 줄은 밤 일괄이 S 13시대에 썼을 줄과 같다(판 종목의 금융위 D 행이 있으면 확정, 없으면 잠정). 조건 밖이면 지금처럼 'D 뒤 체결이 장부에 있음'으로 다시 쓰지 않는다.
9. **밤 대조 자료**(D10 (b) — 수집기 읽기만): `kr_paper_timed`가 ON 장중 기록 STOP(`store.kr_intraday_filled_stops` — 출처 STOP·체결·장중 시장가·근거 mode ON)을 받을 목록(`wanted`)과 창 키(`targets`)에
   함께 넣는다 — 대기가 아니어서 기존 세 읽기에 들지 않는 행이다. 기간은 밤 일괄 세계의 대기 수명(목표 세션 다음 거래일까지)이라 호출 수가 그 세계와 같다(한 번 + 16:40 뒤 재확인, FAILED면 수명 안에서만 다시).
   감시 범위 `stopwatch_scope('KR', 세션)`에도 그 세션에 장중 기록으로 판 종목을 담는다 — 밤 일괄이면 그날 밤까지 보유라 호출 상한(120회·40초)에 닿는 회차의 다른 종목 수집·판정이 그 세계와 같게.
10. **근거 칸·대조·사후 점검·ON 기준**:
    - 근거 `intradayFill` = `{mode, evaluatedAt, outcome: RECORD|DEFER, reasons[], snapshotFetchedAt, targetAt, barLabel, rawPrice, volume, priceSource, qty, cashDelta, fee, tax, slippageCost, settingsVersion, gateAt}`
      (ON은 `recordedAt`·`before`(보유 사본)·`fillRefVolume`·`cashBefore`·`cashAfter`를 더함). AI 입력에는 들어가지 않는다(패킷은 이 칸을 읽지 않음).
    - SHADOW 대조: 밤이 닫은 뒤 첫 주기에 `check = {checkedAt, nightStatus, nightRawPrice, nightSource, nightQty, nightDate, nightSettingsVersion, match, reasons}` — 판정이 RECORD인 기록만 견주고(가격·출처·
      수량·날짜·비용 — 비용은 수수료·세금·슬리피지 세 칸, 다르면 `COST_MISMATCH`: 기록 때와 밤의 금융위 시장 구분·설정이 갈린 날 현금이 갈림, QA-792), 체결되지 않았으면 `NIGHT_NOT_FILLED`, 설정 판이 다르면
      `SETTINGS_CHANGED`(match와 따로 — 비용까지 달라졌으면 `COST_MISMATCH`로 불일치). 불일치는 운영 알림(작업 기록 `detail.alerts`와 경고 로그 — 건수·사유 코드만).
    - ON 사후 점검: 그 세션 밤 처리 뒤 첫 주기에, 밤 일괄이었다면 그 STOP을 체결했을지를 밤과 같은 함수로 다시 본다 — 그 밤 관측치의 체결 봉 고르기·체결 조건(`MarketRun.fillBar`·`fill`),
      기업행위 판정(`KrIntradayFill.nightCorporate` — 결과는 `postCheck = {checkedAt, kind, details}`), 기록 뒤 일시정지(`pausedAt`), 그 세션 순자산 줄 없이 다음 세션으로 넘어감. 결과는 `check`
      (`NIGHT_NOT_FILLED`·`CORP_ACTION`·가격·출처·날짜·수량·비용 불일치, 그 밤 관측치가 이미 지나 다시 셀 수 없으면 `NIGHT_UNCHECKED`)와 운영 알림. 밤 사다리가 기다림이면 남기지 않고 다음 관측치까지 본다.
    - ON으로 가는 기준(D11): ADR 0044 배포 뒤 SHADOW 10거래일 이상, RECORD이고 대조한 STOP 5건 이상, 가격·출처·수량 불일치 0(비용 불일치 `COST_MISMATCH`도 불일치로 셈 — QA-792), `NIGHT_NOT_FILLED` 0, 단계 오류 0. 넷 다 맞으면 사용자에게 다시 확인받아 저장한다.
      `reasons`의 G3 분포는 G3 완화 결정의 근거로 쓴다(`CORP_GUARD`는 감시 항목이 없을 때 `NO_R1`과 함께 붙으므로 따로 센다).
11. **AI 입력과 글**(ON 판 — 끈 판(OFF)·대조 판(SHADOW)은 바이트 그대로): `StopWatch.rule`·`basis`·`hardRuleLine`에 장중 기록 판을 더해 한국 스탑 문장의 반영 시점 구절 하나만 바꾼다 —
    '금융위 확정가로 다시 판정하지 않고 그날 밤 장부에 반영' → '금융위 확정가로 다시 판정하지 않고, 그 분 봉에 거래가 있으면 기준 분 몇 분 뒤 장중에 장부에 반영(보유·현금이 바로 바뀜 — 종가 매도·그 분
    거래 없음·자료 부족·앞 시각이나 같은 종목의 대기 주문·장부 밀림·기업행위 의심 등이면 그날 밤)'(감시 ON인 모든 한국 Claude 결정 패킷의 `12_hardRules` 스탑 줄·`1_basis.stopWatch.rule`, 자유 시점 판 장중 판단 패킷의 `1_basis.stopWatch.rule`).
    장중 판단·끈 판 장중 확인 패킷의 장부 글 `4_portfolio.ledger.note`는 ON이면 '…지난밤 관측치로 평가한 값에 오늘 장중에 적힌 감시 스탑 매도를 더한 값…'(표지는 `KrCheckpointPacket.Inputs.intradayFill` —
    두 작업이 함께 넘김). ON이 아니어도 그 장부에 밤 처리 전 장중 기록 스탑이 있으면(자료 — `Inputs.intradayRecorded`, `PaperKrCheckpointJob.intradayStopsRecorded` — 거울 보기가 되감는 행과
    같은 조건) 같은 글이다(QA-791 — 기록 뒤 같은 세션에 OFF로 바꿔도 현금·보유에는 이미 들어가 있음). 스탑 문장은 설정대로다. 시스템 프롬프트(`StopWatch.krPromptLine` — '곧바로 장중 시장가로 매도')는 그대로. 마감 브리핑의 한국 장부 안내는 **설정이 아니라 자료로** 고른다 — 그 세션 줄이 없는 계좌의
    체결에 장중 기록 스탑이 있을 때만 '장중 감시 스탑 매도를 기록되는 대로 반영했고(… 표시 날짜는 직전 장부 처리일), 그 밖의 체결·순자산·수급은 밤 장부 처리 뒤 확정'(ADR 0039 결과 일부 개정).
12. **저장 시각**(D17): SHADOW·ON·OFF 저장은 장 마감(15:30) 뒤 ~ 다음 정기 결정 전에 한다 — 장중 판단 패킷의 `12_hardRules`는 그 세션 결정 패킷에서 복사하고(`KrCheckpointPacket`), `1_basis.stopWatch`는
    호출 때의 설정 행으로 만들어(`PaperKrIntradayJob.handle` — 그 실행이 연 설정 행), 결정 뒤 ~ 마감 전에 저장하면 한 패킷에 옛 문장과 새 문장이 함께 실리기 때문이다. 잘못된 기록이 보이면 장중에도
    OFF로 바꾸고(실제 돈은 거울 보기가 주문 근거로 되감으므로 장중에 바꿔도 달라지지 않음), 그 세션 장중 판단 패킷에 두 문장이 섞인 것을 ADR 0018에 적는다(장부 글은 자료로도 고르므로
    그 세션 밤 처리 전까지 장중 기록 판 글 그대로 — 결정 11).

## 이유

- 같은 함수(사다리·체결 조건·재진입 금지·근거 칸)를 두 길에서 부르므로 장중 기록의 체결가·비용이 밤과 같다는 것을 시험으로 묶을 수 있다. 밤 함수를 그대로 부르지 못하는 까닭(그 종목 밤 관측치의
  관측 봉·보유 확인·기업행위 판정·`BookRun.at`·모든 칸을 덮는 `upsertState`가 필요)은 떼어 낸 좁은 함수와 장중 전용 입력으로 풀었다.
- R1만 받고 나머지를 밤에 맡기면, 장중이 틀릴 수 있는 갈래(거래 없는 분·자료 부족)는 늘 밤 몫이라 '잘못 적힌 체결'이 생길 길이 좁다. 체결 행은 고칠 수 없으므로 SHADOW로 먼저 잰다.
- 거울 보기는 실제 돈 경로(realtrade 코드)를 고치지 않고, 모의 쪽에서 '장중 기록이 없는 세계'를 다시 만들어 보이므로 규칙 계좌를 따르는 동안 실제 계좌·ISA 동작이 스위치와 무관하다. 그 대안
  (G5 여유만 늘림)은 이상 멈춤(회전율 멈춤 — 2026-11-18에 실제로 드러남) 동안 놓친 스탑이 장중 기록으로 체결이 되면 해제 뒤 놓침으로 세지 않는 길과 ISA 지시 겹침을 남긴다.
- D12 (가)는 아침 갭 하락 스탑(한국 감시 스탑 18건 가운데 11건이 09:1x)도 몇 분 안에 적게 한다. (나) 미룸은 지금 코드를 그대로 쓰지만 그 스탑을 13시대 이후에야 적는다.

## 대안과 버린 이유

- **판정 블록(새 저장본·새 격자일 때만 돎) 안에서 적기**: 20초마다 도는 별도 단계(`KrStopFillStep`)로 했다 — 판정 쪽 조기 반환·예외와 상관없이 돌아야 R1이 갖춰진 주기를 놓치지 않는다.
- **새 수집 태스크(T+5 뒤 한 번)**: 외부 호출이 는다. 감시 저장본으로 충분하다(5분 뒤 저장본에 R1 봉이 듦, 40봉 동안 남음).
- **D9 거울 보기를 고르지 않음**: 위 '이유'. **D12 (나) 미룸**: 위 '이유'. **D10 (a) 밤 대조 자료를 받아들임**: ON 뒤 토스 1분봉 사후 정정을 계속 잴 길이 없다.
- **ON 뒤 불일치면 자동 OFF**: 코드가 설정을 쓰게 되어 권하지 않았다(D11 — 알림만, 끄는 것은 사람).
- **fill 표지를 결정의 설정 판에서 읽기**(D17 대안): 코드가 늘어 저장 시각 규칙으로 대신했다.

## 결과와 남은 위험

- **알려진 차이(경제적 결과 밖)**: 체결 행 `observed_at`(장중 기록이면 감시 항목을 받은 시각 — 밤 `Quote.fetchedAt`은 수집기 실행 시작이라 받은 순간보다 이르고, 감시 항목 `fetchedAt`은 응답을 받은 뒤라
  뜻이 반대쪽 경계)·`created_at`·번호 순서, 주문 `filled_at`, 근거 JSON의 `intradayFill` 키, 이미 체결된 STOP에는 확정 조정의 `confirmedHighWatermark`가 붙지 않음(재진입 금지 글은 `highWatermark`를 써서 같음),
  판 종목의 금융위 확정 조정 평단 이동이 그 보유에 없음(평단은 매도 뒤 쓰이지 않음).
- **알려진 차이(경제적)**: 장중 기록은 기록 시각의 설정을, 밤은 처리 시각의 설정을 쓴다. 수수료·슬리피지·세율과 재진입 금지 일수가 여기서 나오므로 기록과 S 밤 사이에 그 키들을 저장하면 현금과
  재진입 마감일이 달라진다. 장중 시장가 체결은 확정 조정 대상이 아니라(`KrConfirmations.finalAsFilled`) 이 차이는 **영구히 남는다**. 대조가 `SETTINGS_CHANGED`로 따로 가르고(비용이 달라졌으면 `COST_MISMATCH` — 불일치·운영 알림), D17로 장중 저장은 드물다.
- **알려진 차이(거울의 다른 입력)**: (a) 되감은 보유 사본은 기록 시점 값이라, 밤 일괄 세계에서 그 뒤 금융위 확정 조정의 평단 이동·낮 재처리의 평가 가격 갱신이 그 보유에 반영되는 것과 다를 수 있다
  (공개 창 가격은 마지막 평가 가격이 있으면 그것을 씀). (b) `weightAfter`의 가격 고르기는 `paper.watch.kr`(계좌2의 보유·대기 주문 범위)를 읽으므로 계좌2의 ON 기록이 같은 종목을 범위에서 빼면 규칙 계좌 STOP의
  그 종목 가격이 감시 봉에서 밤 종가로 바뀔 수 있다. (c) 감시 범위는 결정 9로 맞췄다.
- **알려진 차이(화면·API)**: ON이면 장중 기록 STOP이 그 세션 순자산 줄 전에 상태 `cash`·`nav`·`equityValue`·`exposurePct`(`BookSummary`)에 먼저 반영되고, `lastObservedAtKst`·`/live`의 `ledgerDay.tradingDate`는
  직전 처리 그대로다(그래서 '직전 처리일 장부 변화'에 그 세션 스탑의 실현 차이가 섞임). 마감 브리핑의 `navDate`도 직전 처리일이다(결정 11의 안내 글). 보유 화면의 '장중 기록' 표지는 작업대 개편(P6) 뒤로 미룬다.
- **끈 판 장중 확인**(지금 쓰이지 않는 길 — 네 Claude 계좌가 자유 시점 판): 장부 글 표지는 함께 받지만 `1_basis.stopWatch`는 자유 시점 판에만 있다.
- **텔레그램**: 장중 기록 체결은 다음 알림 주기(60초 + 60초 정착)에 계좌·트랜잭션 묶음 한 통으로 나간다(시점 이름 '장중 시장가 HH:MM KST' 그대로).
- **비용·부하**: 단계는 스위치가 OFF여도 20초마다 한국 책마다 대조할 주문 읽기(`intradayFillsToCheck`, 최근 14일·jsonb 조건)를 한 번 한다. 공개 창 메서드는 장중 기록 읽기 한 번을 더 한다
  (실제 매매 10초·ISA 30초 주기). 운영 측정은 하지 않았다[추정 — 책별 소량 행].
- **남는 틈(G4)**: 토스가 S−1 수정 종가를 S 첫 감시 회차 뒤에 고치면 가드가 못 보고, S−1 상장주식수 변화는 금융위 S−1이 S 13시 이후에야 들어와 오전에는 안 보인다. 둘 다 밤이면 보류했을 경우이고
  사후 점검이 잡는다(되돌리지 않음). G4 ④는 since 봉 하나만 넘겨 이미 반영된 지난 분할이 설명하던 상장주식수 변화도 막을 수 있다(보수 쪽 — SHADOW에서 `CORP_LISTING` 빈도를 따로 잰다).
- **모르는 것**: 토스 1분봉의 사후 정정(SHADOW·사후 점검으로 잼), 거래 없는 분의 봉을 토스가 빼는지, 운영에서 G3·G4로 미뤄지는 빈도, 금융위 데이터셋 실제 도착 시각.
- **다른 가지와의 관계**: 재선정 회전율 예외 가지(`claude/rebalance-turnover-2026-11`)의 예외 판정이 `pendingStopSymbols`와 `targetsAt`을 함께 읽는다 — 거울 보기가 두 읽기를 함께 되감는 것을
  `PaperMirrorIntradayDbTest`가 한 주기 단언으로 지킨다. ADR 0033에는 두 가지가 서로 다른 줄(결정 3 끝·결정 4 끝)에 덧붙인다.
- **되돌리기**:
  1. 평소: `kr.stopWatch.fill = OFF` 저장(배포 없이 즉시, 그 뒤 STOP은 밤 경로) — 결정 12의 시각. 이미 적힌 장중 체결은 남는다. 체결 행은 고칠 수 없으므로 잘못된 기록은 사용자 승인 아래 문서화한
     SQL이나 복원으로만 바로잡는다(SHADOW를 먼저 두는 까닭).
  2. 코드 되돌림(`git revert` → `main` → `deploy.sh`, 실제 매매 가드 평일 08:45~15:35 KST 밖)의 조건은 하나다 — OFF 저장 뒤, ON 기록이 있는 모든 한국 책에서 '출처 STOP·체결·근거 mode ON이고 체결일 >
     `targetSession(마지막 처리 저장본)`'인 행이 0건일 것(거울 보기·D12 되감기가 끝남). 확인 질의(건수만, 운영 서버에서 사용자 승인 뒤):
     `SELECT o.book_code, count(*) FROM paper_orders o JOIN paper_fills f ON f.order_id = o.id JOIN paper_book_state s ON s.book_code = o.book_code WHERE o.source = 'STOP' AND o.status = 'FILLED'
     AND o.reason->'intradayFill'->>'mode' = 'ON' AND f.observation_date > ((s.last_processed_collected_at AT TIME ZONE 'Asia/Seoul') - interval '20 hours 30 minutes')::date GROUP BY 1`
     (마지막 처리 저장본의 세션을 20:30 규칙으로 근사 — 휴장일 앞뒤는 달력으로 다시 확인). 사후 대조·사후 점검이 끝났는지는 권장 확인으로 둔다.

### ADR 0018에 옮길 문안(저장 때 — 이 판에서는 0018에 절을 쓰지 않음)

- **SHADOW 저장**: 'YYYY-MM-DD HH:MM KST 설정 vNN — 한국 `kr.stopWatch.fill=SHADOW`(ADR 0045) 기록만, 조건 변경 없음(장부·AI 입력·실제 계좌 무변경, 주문 근거 `intradayFill`에 대조 칸만).'
- **ON 저장**(새 H3 절 — 그날 다른 조건 변경과 겹치지 않게, 12-08·12-22 재선정일은 피함):
  1. 장중 감시 STOP(`INTRADAY_WATCH`·`MARKET`)이 R1이고 관문을 지나면 장부 반영 시각이 그날 밤에서 T 몇 분 뒤로 바뀐다. 체결가·기준 시각 T·재진입 금지 마감일은 그대로.
  2. 결정 패킷(`kr_claude`·`kr_claude2`, 감시 ON — 자유 시점 끈 판 포함): `12_hardRules` 스탑 줄(`StopWatch.hardRuleLine`)과 `1_basis.stopWatch.rule`의 반영 시점 구절만 바뀐다(결정 11).
     결정 패킷의 보유·현금은 결정이 그 세션 밤 처리 뒤에 돌므로(결정 관문 ①) 그대로.
  3. 장중 판단 패킷(자유 시점 판 + 감시 ON): `1_basis.stopWatch.rule`이 같은 구절로, `4_portfolio.ledger.note`가 ON 판 글로 바뀐다. `12_hardRules`는 그 세션 결정 패킷에서 복사된다(저장 시각 결정 12).
     끈 판 장중 확인 패킷(계좌2 끈 판 + 감시 ON — 지금 쓰이지 않는 길)도 장부 글이 같은 ON 판 글이다(`1_basis.stopWatch`는 자유 시점 판에만 있음).
     현금·순자산·보유가 스탑 뒤 상태다. 대기 주문 목록·예상 장부의 대상 주문(출처 CLAUDE만)은 그대로이고 시작 현금·보유가 스탑 뒤 값이다. 판 종목은 5_feed 종목 범위(그 종목이 예약 watch에 없으면 빠짐)·
     `INTRADAY_CARRIED.holdingChecks`·전 거래일 종가·보유 행 `entry`(판단 이어받기 — `kr.continuity`)·`INTRADAY_EVENTS` 뉴스 대상에서 빠진다. 바뀌지 않는 '밤' 글: 예상 장부 메모('실제 체결은 그 밤 장부가' —
     CLAUDE 주문만 다루므로 1단계에서 참), 지시문 `REPLACE` 줄, 사건 줄의 '이미 대기 중인 스탑 매도는 코드가 집행한다'.
  4. REPLACE 검증 문맥: 판 돈을 같은 세션 장중 판단 매수에 쓸 수 있다(지금은 대금이 밤까지 안 보임).
  5. 장중 판단 사건(보유 ±%·스탑 근접): 판 종목이 그 뒤 사건 대상 보유에서 빠져 사건·호출 횟수가 달라진다.
  6. 마감 브리핑 입력(Claude가 쓰는 의견의 입력 — 모의 매매 입력 아님, ADR 0039): 그날 체결에 스탑이 `stop:true`로 들어가고 보유에서 빠지며, 순자산은 상태값(그날 줄 없음)·표시 날짜는 직전 처리일,
     장부 안내는 장중 기록 판 글(자료로 고름 — 결정 11).
  7. 재진입 금지 행이 장중에 생긴다(마감일은 같고, 매수 거절 종목 집합도 같음 — 대기 감시 STOP이 이미 막고 있었음).
  8. 규칙 계좌(대조군): 관문 G3 덕에 현금·보유·체결가·순자산 줄은 밤 일괄과 같고 반영 시각만 다르다(`KrIntradayStopFillDbTest`) — 동치의 전제(결정 6) 밖의 날은 사후 점검 알림으로 따로 적는다.
  9. 실제 계좌·ISA: 따라 하는 책이 규칙 계좌이고 S 밤이 그 STOP을 체결하는 동안 동작이 바뀌지 않는다(거울 보기 — `PaperMirrorIntradayDbTest`·`PaperMirrorServiceTest`).
  10. 텔레그램 체결 알림이 장중에 계좌·트랜잭션 묶음으로 한 통 더 나간다.
