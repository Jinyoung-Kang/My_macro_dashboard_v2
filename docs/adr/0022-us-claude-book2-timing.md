# 0022. 미국 Claude 계좌2(체결 시점 실험): 다섯 번째 미국 계좌가 계좌1과 같은 자료·같은 프레임으로 판단하고 체결 시점(시가·매시·종가)만 스스로 고름, 앞으로 체결로 늦게 출발해 주문 단위 반사실로 판정, 시가는 Yahoo 1분봉 첫 봉(표시), 수집기는 주문 표를 읽기만, 정기 작업 둘

- 상태: 채택 (2026-10-30, 사용자 지시 "권장안대로 진행해"로 명세 확정 — T1~T19 모두 권장안). **단계 0(측정만)·단계 1(계좌2 — 명세 §16-1의 1-1~1-8) 구현, 배포 전**.
  커밋은 브랜치 `claude/us-claude2-2026-10`에 있고, 병합·배포는 명세 §16-2 순서입니다(단계 0 배포 바로 전 `main`에 병합 — T19 ⓐ, 배포는 단계 단위 — 단계 1 배포 뒤
  `POST /api/paper/init`로 계좌2 행을 만들고, 설정 저장 한 번으로 예약 9·소상한 2·`claude2.enabled`). `claude2.enabled`는 기본 꺼짐이라 배포만으로는 계좌2가 결정·출발하지 않습니다.
  장중 확인(단계 2 — `CHECKPOINT`·`MARKET`·V18·`paper_watch_us`·`PaperCheckpointJob`)은 아직 코드가 없습니다.
  미국 네 계좌(ADR 0018)의 결정·패킷·시스템 프롬프트·응답 스키마·장부 순서·체결 조건은 바뀌지 않습니다 — 이 문서는 계좌2 때문에 **고치는 기존 결정**과 **출발 뒤에는 되돌리기 어려운 것**만 적습니다.
- 근거: [계좌2 명세](../specs/2026-10-30-claude-book2-timing-design.md) §3·§4(§4-3 고치는 기존 결정)·§5-3·§6·§7·§8·§10·§11·§12·§14·§16·§18 **T4·T6·T7·T10·T12·T15·T17·T18** ·
  [ADR 0018](0018-paper-trading-guardrails.md)(미국 책 가드레일) · [ADR 0020](0020-v2-program.md)(v2 프로그램, 장중 평가) · [ADR 0021](0021-kr-paper-prices-fills-start.md)(한국 책 — 앞으로 체결 출발의 선례) ·
  [ADR 0008](0008-backend-owned-tables-and-scheduled-jobs.md)(테이블마다 쓰는 쪽 하나) · [ADR 0017](0017-macro-card-delay-and-realtime-sources.md)(모르는 지연은 '실시간'으로 적지 않음)
- 지키는 방법(결정 번호별 — 단계 0 뒤에 있는 시험, 그리고 그 결정을 만드는 단계가 더할 시험. 단계·커밋 번호는 명세 §16-1):
  1. 다섯 계좌·계좌1 바이트 그대로
     - 있음: 계좌1 고정본 `PacketBuilderTest.goldenUsPackets`·`goldenUsPacketsWithConsensus`, `FrameworkServiceTest.goldenRender`, `StructuredSchemaTest.goldenSchemas`,
       `ClaudeBookServiceTest.goldenScheduledDecision`, `PaperLedgerServiceTest.goldenUsLedgerWeek`, `OrderValidatorTest.goldenOutcomes`, `ReviewServiceTest.goldenReviewRequest`, `PaperQueryUsGoldenTest`.
       단계 0은 `backend/src/test/resources/paper/golden/`을 한 바이트도 바꾸지 않습니다(`main`과의 diff가 빔).
     - 단계 1(있음): 이동 커밋(1-1~1-3)은 위 고정본 그대로 — `ClaudeBookProfileTest.marketDefaultProfilesCarryTheMarketValues`·`renderTakesTheFixedRulesFromTheProfile`,
       `PacketBuilderTest.marketInputsAreReadOnceAndFrozen`, `OrderValidatorRanksTest.randomBatchesMatchTheTwoBranchImplementation`(옛 두 갈래 구현과 무작위 동치).
       고정본 diff(`git diff main..HEAD -- backend/src/test/resources/paper/golden`)는 개요·상태 둘(`PaperQueryUsGoldenTest` — 계좌 행·`navSeries`·`claude2` 묶음이
       더해짐)과 계좌2 새 고정본(`render-us-claude2-v0-default.txt`·`decision-schema-forapi-us-claude2.json`·`packet-us-claude2-*` 셋 —
       `PacketBuilderTest.goldenClaude2Packets`·`StructuredSchemaTest.goldenClaude2SchemaForApi`·`ClaudeBookProfileTest.claude2RenderDiffersOnlyInTheFixedRules`)뿐입니다.
       `ApiIntegrationTest`(계좌 수 5 — `paperInitWithoutPricesSkipsBenchmarks`), `UsPaperMarketTest.books`, 화면 `paperAccount.test.ts`(코드 다섯),
       계좌1 화면 이름 "Claude 계좌1"과 옛 이름 목록 `PaperAdminServiceTest.reconcileLabelsRenamesBookOneBeforeBookTwo`(T3 — 코드 `claude`·ROLE 그대로)
  2. 늦은 출발 — 앞으로 체결(T4)
     - 있음(선례 — 한국 앞으로 체결 출발): `KrStartTest.fourBooksStartTogether`, 미국 사후 체결 경로 그대로 `PaperAdminServiceTest.initBackfillsBenchmarks`
     - 단계 1(있음): `Claude2DecisionTest.initialDecisionStartsTheBookForward`(INITIAL — 정기 조립, 통과 주문은 E 하루짜리, 같은 트랜잭션에서 운용·`started_on = S`·S 순자산 줄)·
       `failedStartWritesNothing`·`bookStateGuards`, `PaperDecisionJobClaude2Test.startIsTriedOncePerWindow`(작업 기록 `claude2.startTried`)·`manualBook2Start`,
       `ApiIntegrationTest.paperInitWithoutPricesSkipsBenchmarks`(기본 꺼짐이면 수동 결정·출발 400, `preview:true`도 400), 화면 `paperClaude2.test.tsx`(설정이 꺼져 있으면
       '계좌2 시작'이 닫힘 → 켜면 확인 → `{book:"claude2"}`). 출발 조건 X1~X5(명세 §19)는 단계 0 측정 기록(`docs/DATA_SOURCES.md`)으로 확인
  3. 계좌2의 시가·시각 지정 메뉴(T5)
     - 있음(0-2): `PaperStoreDbTest.v17TimedTimingsFillBarAndOrderExec`(timing CHECK = 옛 다섯 + `AT_1000`~`AT_1500`, 모르는 시점은 막힘, 계좌1 체결의 `bar_at`·`fill_rung`은 NULL)·`v17RerunIsSafe`,
       계좌1 시점 그대로 `DecisionTimingsLockTest.schemaMarketAndPromptAgree`·`UsPaperMarketTest.timings`
     - 단계 0(0-3): 수집기 `paper_bars_us` 시험 — 메뉴 창 시각이 E 날짜의 `America/New_York`(서머타임 전환 주 포함), 창마다 첫 봉 시가와 `firstTradeAfter`
     - 단계 1(있음): 장부 `UsTimedFillsTest` — 사다리 `r1AtTheTargetBar`·`r2NextTradedBarInTheWindow`·`r2bFirstTradeAfterTheWindow`·`r3OnlyWhenTheBarsThemselvesAreMissing`·
       `quotesCloseAtTheFinalObservation`·`nextOpen`, 조건 ⑤~⑧b `lateForTimingIsCancelledWithAnAlert`·`barBeforeTheTargetIsSkipped`·`unfinishedBarWaits`·`staleTickerEntry`·`zeroVolumeOnly`·
       `recheckRefusesACorruptFirstTrade`, T 시각 순자산 `navAtTheTarget`·`navFallsBackToThePriceBeforeTheUpdate`, 순서 `sameTargetSellsFirstCashLikeLast`·`timedSellBeforeTheHourlyStop`·
       `pendingTimedSellDefersTheStopAtThatObservation`·`pendingTimedBuyIsResolvedBeforeTheStop`(W가 T 창을 다 본 1분봉보다 먼저 오면 그 종목의 스탑은 다음 W에서 T 주문 뒤),
       `expiryComesAfterTimedFills`(E 하루 만료가 2b 뒤)·`hourlyPathNeverFillsTimedOrders`(`fillable` 제외 회귀)·`pollingInvariance`·`neverFillsWithABarBeforeTheTargetOrCreation`(룩어헤드 성질)·
       `dstEndWeek`·`dstStartWeek`·`holidayAndEarlyClose`, 서버가 꺼졌던 경우 `backBeforeTheNextOpen`·`backDuringTheNextSession`·`beyondTheBarsHorizon`; 실제 표
       `PaperStoreDbTest.timedExpiryAndFillBar`·`PaperLedgerDbTest.timedFillsOnRealTables`(시험 행은 시작·끝에 지움 — V14 다시 실행). 검증기·스키마
       `DecisionTimingsLockTest.claude2MenuIsLockedEverywhere`(스키마 enum = 프로필의 받는 시점 = 검증기 순위 = 고정 문단 = V17 CHECK)·`Claude2PipelineTest.acceptsTheMenuAndOrdersLastOneSession`·
       `closedTimingsComeFromTheDecisionDayAndTheClock`·`OrderValidatorRanksTest.sellFundsOnlyBuysAtTheSameOrLaterRank`·`closedTimingsRejectOnlyThatTiming`·
       `StructuredSchemaTest.claude2SchemaDiffersOnlyInTimingAndExecutionNote`. 화면 이름표 `paperClaude2.test.ts`(시가·10:00…15:00 ET·종가, 사다리 칸, 대체 체결 배지)
  4. `NEXT_OBSERVATION`은 계좌2 메뉴에 없음(T6)
     - 단계 0(0-4): 실행 감사 작업 시험 — 계좌1 주문(시점 `NEXT_OBSERVATION`)의 계좌1식 기준 반사실은 그 주문의 실제 체결 원가격에서 옮김(칸 이름
       `QUOTES_OBSERVATION`, `ExecutionAuditTest.nextObservationFromTheActualFill` — 명세 §14-1 '계좌1 주문은 실제 체결 행에서'). 그 밖의 계좌1 주문(`NEXT_CLOSE`)은 `null`
     - 단계 1(있음): 계좌2 주문의 계좌1식 기준(M1의 P_cf,NEXT_OBS)은 체결 조건 ①②④를 통과한 **첫** `paper.quotes`를 관측치 사슬(작업 기록 `quotesChain` 고리 + 수집기
       실행 기록)로 증명한 때만 — `PaperExecutionAuditJobTest.chainProvenFollowsTheLinks`·`book2ObservationBaselineFromTheProvenChain`·`book2ObservationBaselineStaysNullWithoutProof`·
       `book2ObservationBaselineNeedsALinkBeforeTheOrder`, 사이 실행 수 SQL `ApiIntegrationTest.taskRunsStartedBetweenCountsOnlyThatTaskStrictlyInside`(증명하지 못하면 끝까지 `null`).
       사슬은 계좌2 행이 있고 `claude2.enabled`가 켜졌거나 출발했을 때만 세고 기록함(배포만으로 작업 기록이 늘지 않음 — `chainOnlyOnceBook2IsEnabledOrStarted`),
       사슬 계산이 실패해도 계좌1 감사는 그대로(`chainFailureDoesNotStopTheBookOneAudit`)
     - 단계 1(있음): 계좌2 스키마 enum·고정 문단에 `NEXT_OBSERVATION`이 없음(`DecisionTimingsLockTest.claude2MenuIsLockedEverywhere`)
  5. '실시간·지연'(T7)
     - 단계 0(0-3): `lagSeconds`는 정규장 안에서 받은 저장본만(장 밖·휴장 `null`)이고 그 회차에 받은 SPY 세션만(짧게 온 응답으로 남긴 세션은 `null`), 종목 칸의 출처 지연(`declaredDelayMin`)은 늘 `null`
     - 단계 2(2-2·2-3): `MINUTE`·`HOURLY` 피드와 확인 패킷 시각 ⑨(봉 끝·받은 시각 ≤ 조립 시각)
  6. 수집기가 읽는 백엔드 표(ADR 0020 개정)
     - 있음: `test_table_ownership.py::test_수집기는_백엔드_테이블에_쓰지_않는다`(0-2부터 `paper_order_exec` 포함), `test_paper_live.py::test_보유_종목은_그_시장의_출발한_계좌들_것만_중복_없이`(첫 읽기 경우)
     - 단계 0(0-3): 범위 읽기(`store.timed_scope`)가 읽기만, 빈 범위면 Yahoo 호출 0, 수집기의 시각 지정 timing 목록 = 백엔드 상수(파일 대조). 단계 2(2-1): `BACKEND_TABLES`에 `paper_checkpoints`
  7. 장중 평가는 표시 전용 그대로
     - 있음: 시험이 아니라 코드 사실 — `paper.live.*`를 읽는 백엔드 코드는 `PaperLiveService` 하나(`PaperLiveServiceTest`). 계좌2 장부·패킷은 새 데이터셋 `paper.bars.us`(0-3)·`paper.watch.us`(2-2)만 읽음
  8. 정기 작업 둘
     - 있음(선례): `PaperRiskJobTest.disabledDoesNothing`·`PaperReviewJobTest.disabledDoesNothing`(`PAPER_ENABLED=false`면 아무것도 안 함)
     - 단계 0(0-4): 실행 감사 작업의 같은 시험(꺼지면 아무것도 안 함, 저장본은 `StoreReader.quietly`, 장부 잠금을 잡지 않고 장부 표는 읽기만, 계좌1 고정본 그대로). 단계 2(2-3): 장중 확인 작업의 같은 시험·스케줄러 풀 5
     - 단계 1(있음 — 새 작업 없음): 계좌2 결정은 결정 작업 안에서 규칙 → 계좌1 → 계좌2(`PaperDecisionJobClaude2Test.book2RunsAfterBook1WithTheSameInputs`·`disabledBook2IsNotCalled`·
       `book1AlreadyDecided`·`book2ErrorsCountForBook2`), 1분봉 기다림은 리스크 점검 안에서(`UsTimedFillsTest.releasedByFreshBars`·`releasedByTheCap`·`capComesFromTheSettings`·
       `noWaitWithoutDueOrders`·`manualRunsAlwaysRecord`, 결정 작업이 기다림을 봄 `PaperDecisionJobClaude2Test.waitsForTheMinuteBars` — 같은 관측치로 기다리기만 한
       주기는 기록 없음 `repeatedBarsWaitIsRecordedOnce`, 개장 전 컷오프가 기다림보다 먼저 `cutoffComesBeforeTheBarsWait`)
  9. 호출 예산(T10)
     - 있음: `ClaudeBookServiceTest.manualCallsStopAtCapMinusReserveScheduledGoToCap`(수동 문턱 = 상한 − 예약, 정기는 상한까지 — 예약 값은 설정이라 이 결정은 저장 값으로 지킴)
     - 단계 1(있음): 계좌2 소상한(같은 기준 거래일의 결정 주기 단위 — 행마다 1 + 재시도) `Claude2DecisionTest.cycleCapCountsTheDecisionRows`, 수동 결정은 수동 문턱
       `PaperDecisionJobClaude2Test.manualBook2Decision`. 서머타임에 하루 확인 둘(단계 2)은 2-3 몫
  10. 한도·월 상한(T12)
     - 있음: `OrderValidatorTest.monthlyCap`·`goldenOutcomes`(계좌1 그대로), 한국 계산 `KrPacketBuilderTest.monthlyCountLeavesOutTheStartAllocation`(출발 `INITIAL` 주문을 세지 않음), 미국 계산 `ClaudeBookServiceTest.initialBackfillDoesNotUseMonthlyCap`
     - 단계 1(있음): 검증기 시점 순위 일반화의 동치 시험 `OrderValidatorRanksTest.randomBatchesMatchTheTwoBranchImplementation`(옛 두 갈래 = 순위 0/1)·`positionsPerRank`·`checksEveryRankWithBuys`,
       계좌2 출발 배분이 월 상한에 세이지 않음 `Claude2PipelineTest.monthlyCapLeavesOutTheStartDecision`
  11. 기한 지난 날(T17)
     - 있음(계좌1 규칙): `UsPaperMarketTest.decisionTimes`(`PROCEED_UNCONFIRMED`)
     - 단계 1(있음): 개장 전 컷오프 `Claude2DecisionTest.preOpenCutoff`(지난 뒤면 부르지 않고 정기 `SKIPPED` '개장 전 컷오프', 출발은 쓰지 않음, 수동 400 — 계좌1은 그대로 진행),
       기한 뒤 진행은 계좌1과 같은 미국 규칙(`UsPaperMarketTest.decisionTimes`)
  12. 거래 없는 주문(T18)
     - 있음(0-2): `paper_fills.fill_rung` CHECK가 사다리 칸 다섯(`Y1M_AT`·`Y1M_NEXT`·`Y1M_LATE`·`QUOTES_FALLBACK`·`QUOTES_CLOSE`)만 받음(`PaperStoreDbTest.v17TimedTimingsFillBarAndOrderExec`)
     - 단계 1(있음): `UsTimedFillsTest.haltedAllDayIsNotFilledWithAFrozenPrice`(종일 무거래 → `NO_TRADE_AFTER_T` 만료 — 그날 `paper.quotes` 값으로 채우지 않음)·`resumedAfterTheTarget`(T 뒤 재개 → R2b)·
       `r3OnlyWhenTheBarsThemselvesAreMissing`(1분봉 자체가 없음 → R3 `fallback`)·`temporaryClosure`(`NO_SESSION_BARS`)·`backDuringTheNextSession`(E+1 가격으로는 체결하지 않음)
  13. 사전 등록 판정(T15)
     - 단계 0(0-5): `GET /api/paper/books/{code}/execution` 요약 지표는 N < 10이거나 결정일 묶음 < 5면 `null`(`PaperExecutionViewTest.summaryNullsUnderThresholds`). 판정 문턱은 코드가 아니라 이 문서·명세 §14-3에 출발 전에 고정
     - 단계 1(있음): 화면 '체결 시점 실험'은 `null`을 '—'와 '판단 보류'로 적고 값이 있어도 판정 문장을 만들지 않음, 시가는 대리값(`paperClaude2.test.ts`·`paperClaude2.test.tsx`)

## 배경

사용자 요청(2026-10-30): 지금 방식(시세는 1시간마다, 결정은 장 마감 뒤 07:30 KST 한 번, 체결은 다음 장의 첫 관측 시각 또는 다음 종가)은 Claude 계좌1로 두고,
**시가·장중·시장가·종가와 실시간·지연 데이터를 스스로 골라 매매하는 Claude 계좌2**를 미국 장에 먼저 더한다. 사용자가 고르지 않고 Claude가 스스로 판단하며, 규칙 계좌·벤치마크는 그대로다.

- 미국 관측치 `paper.quotes`는 일봉 날짜·종가뿐이고(시가·봉 시각 없음) slow 군 60분마다 저장된다. 계좌1의 `NEXT_OBSERVATION`은 그래서 '다음 시간별 수집 회차'라는, 증권사에 없는 시점이다.
- Yahoo 1분봉을 받는 함수는 있지만(`collector/app/services/market.py`) 장부가 쓰지 않는다. 장중 평가(`paper_live_us`)는 화면을 볼 때만·보유 종목만 받는 표시 전용이다(ADR 0020).
- 미국 개별 종목에 대해 지연을 밝히는 출처를 확인한 적이 없다. '실시간'은 목록에 두지 않는다는 원칙이 있다(ADR 0017, `docs/PRINCIPLES.md`).
- 계좌1과 비교하려면 판단에 쓰는 정보가 같아야 한다. 장중에 결정 회차를 더하면 정보 집합이 달라져 체결 시점의 효과를 가려낼 수 없다.
- 미국 계좌는 2026-10-23 종가 사후 체결로 함께 출발했다(ADR 0018 결정 3). 지금 계좌2를 그 날짜로 출발시키면 겪지 않은 세션이 성과에 들어간다.

## 결정

1. **미국 계좌는 다섯 — 계좌2 `claude2`는 별도 실험군**(명세 L1 '시장마다 계좌 넷' 개정, T2·T3). kind `CLAUDE`, 이름 "Claude 계좌2"(계좌1 행 이름은 화면만 "Claude 계좌1"), 100,000달러, 비교 기준 `bench_spy`.
   계좌1과 같은 실행에서 한 번 읽은 입력(입력 동결)·같은 프레임 판·같은 모델·한도·슬리피지 5bp·트레일링 스탑으로 스스로 판단하고 주문한다. 다른 것은 체결 시점 메뉴(결정 3), 단계 2의 장중 확인 한 번(결정 5),
   자기 체결 기록 섹션 `13_execution.record`(T14)뿐이다. 계좌2는 Claude 복기가 없고 계좌1 복기 입력에도 들어가지 않는다(T13 — 공용 프레임을 계좌2가 바꾸지 못하게).
2. **계좌2만 늦게, 앞으로 체결로 출발한다**(ADR 0018 결정 3의 '같은 날 출발' 개정, T4). 단계 0에서 X1~X5를 3세션 이상 잰 뒤 첫 미국 결정 창에, 세션 S(`lastCompletedSession`) 기준 `INITIAL` 결정
   (사후 체결 문장이 없는 정기 결정과 같은 패킷)을 내고, 주문은 S+1 세션에 메뉴 시점대로 체결한다. `started_on = S`, S 순자산 = 현금 100,000. 사후 체결·`paper_start_prices`·`backfill`은 쓰지 않는다(한국 K28 방식).
   계좌1과는 S 이후 같은 구간에서만 비교하고, 판정은 주문 단위 반사실로 한다(결정 13).
3. **계좌2에 한해 시가(`NEXT_OPEN`)와 시각 지정 체결을 둔다**(ADR 0018 결정 2의 '시가가 없어 `NEXT_OPEN`을 두지 않음' 개정, T5).
   메뉴는 `NEXT_OPEN`(E 09:30)·`AT_1000`~`AT_1500`(E 매시)·`NEXT_CLOSE`(계좌1과 같은 규칙) 8개, 모든 시각은 `America/New_York`(고정 UTC 오프셋 금지), 모든 계좌2 주문은 목표 세션 E 하루짜리다.
   시각 지정 체결가는 Yahoo(yfinance) 1분봉의 T 봉 Open × (1 ± 5bp)이고, 사다리 R1 `Y1M_AT` → R2 `Y1M_NEXT`(T+1~T+4분) → R2b `Y1M_LATE`(E 안 T 뒤 첫 거래 봉, 대체) → R3 `QUOTES_FALLBACK`(1분봉 자체가 없을 때만, 대체) 순이다.
   첫 봉 시가가 공식 개장가와 같은지는 공식 출처가 없어 모르므로, X2를 재기 전에는 `isProxy=true`로 표시한다. 스키마는 V17로 더하기만 한다 — timing CHECK의 상위 집합,
   체결 봉 시각 `paper_fills.bar_at`·사다리 칸 `fill_rung`(계좌1 체결은 NULL), 주문별 실행 감사 표 `paper_order_exec`.
4. **`NEXT_OBSERVATION`은 계좌2 메뉴에 넣지 않는다 — 반사실 기준으로만 쓴다**(T6). 실행 감사 작업이 단계 0부터 계좌1 주문에도 메뉴 시점마다의 반사실을 적어 기준 분포를 만든다.
5. **'실시간·지연'은 '넓게 대 새로'로 옮긴다**(T7). 단계 1에는 데이터 선택이 없다(장이 닫힌 뒤 결정하므로 입력은 모두 확정 종가). 단계 2의 장중 확인(세션당 최대 1회, T9)에서
   `MINUTE`(감시 ≤ 10종목 + 보유·대기, 5분 수집, 잰 지연) 대 `HOURLY`(전 종목, 최대 60분 묵음)를 고른다. **지연 자료로 더 좋은 체결가를 얻을 수는 없다** — 체결은 늘 주문 뒤 시장 시각의 첫 봉이고,
   지연은 판단의 신선도와 장부 반영 시각만 늦춘다. '실시간'이라는 말은 잰 값이 생기기 전에는 쓰지 않는다(ADR 0017).
6. **수집기가 읽기만 하는 백엔드 표를 늘린다**(ADR 0020 '수집기가 백엔드 표를 읽는 첫 경우' 개정): `paper_orders`(단계 0 — 1분봉 수집 범위)·`paper_checkpoints`(단계 2).
   쓰는 프로세스는 여전히 하나다 — `paper_order_exec`과 `paper_fills`의 새 칸은 백엔드 `store.PaperStore`만 쓰고, 1분봉 저장본(`paper.bars.us`)은 수집기만 쓴다(ADR 0008).
7. **장중 평가는 표시 전용 그대로 둔다**(ADR 0020 — 바꾸지 않음). 계좌2의 장부·판단 입력은 새 데이터셋 `paper.bars.us`(단계 0, slow 군에서 `paper_quotes` 바로 뒤)·`paper.watch.us`(단계 2)다.
8. **모의 매매 정기 작업을 둘 더한다**(2단계 명세 §9 A5 '새 `@Scheduled` 없이 기존 작업이 시장을 차례로' 개정): 실행 감사 작업 `PaperExecutionAuditJob`(단계 0, 5분)과 장중 확인 작업 `PaperCheckpointJob`(단계 2, 60초).
   둘 다 자기 잠금을 쓰고, `config.enabled()`가 거짓이면 아무것도 하지 않으며(로컬 v2 `PAPER_ENABLED=false`), 저장본은 `StoreReader.quietly`로만 읽고, 쓰기는 백엔드 표에만 한다.
   감사 작업은 장부 잠금을 잡지 않고 장부 표를 읽기만 한다. 스케줄러 풀 4는 단계 2에서 5로 늘린다.
9. **호출 예산은 상한 30 그대로, 정기 작업 몫 예약과 계좌2 소상한을 설정 저장으로 바꾼다**(ADR 0020 결정 6·'결과'의 '1회 $0.09·하루 최대 약 $2.7' 고쳐 적음, T10).
   지금 패킷 기준 1회 약 $0.12, 하루 최대 약 $3.6(상한 × 1회 — 상한이 그대로라 바뀌지 않음). 예약 `apiScheduledReserve` 7 → 9(단계 1)·10(단계 2), 계좌2 소상한 `claude2.maxCallsPerCycle` 2·3
   (같은 기준 거래일의 결정·재시도·장중 확인 호출 수 — KST 날이 아니라 결정 주기로 셈). 코드 기본값이 아니라 계좌2를 켜는 설정 저장 한 번으로 바꾸고, 교정 재호출(`claude.figureCheck`)은 끈 채라 그 판의 값은 쓰지 않는다.
10. **한도·월 상한은 계좌1과 같은 키**(T12). 출발(결정 종류 `INITIAL`) 주문은 월 20건에 세지 않는다 — 계좌2는 한국 계산(`KrPacketBuilder`, `INITIAL`의 주문을 뺌)을 쓴다(미국 계산은 사후 체결 `BACKFILL`만 뺌).
    검증기는 '이른 시점 하나 + 나머지' 두 갈래를 시점 순위로 일반화한다 — 계좌1은 순위 0/1이라 결과가 같다.
11. **기한(12:00 KST)이 지난 날은 계좌1처럼 진행하고, 계좌2에만 개장 전 컷오프를 둔다**(T17). 기한 뒤에는 확정 전 값으로 진행해 `prices_final=false`를 남기고(`PROCEED_UNCONFIRMED`),
    지금이 E 09:00 ET 뒤면 그 세션의 계좌2 결정만 `SKIPPED`(사유 '개장 전 컷오프')다. 계좌1은 그대로 진행한다.
12. **1분봉이 'T 뒤 거래 없음'을 보인 주문은 체결하지 않는다**(T18). E 마감 + 15분 뒤 저장본에서도 거래 봉이 없으면 `EXPIRED`(`NO_TRADE_AFTER_T` '거래 정지·무거래 가능'), 그 사이 재개되면 첫 거래 봉(R2b)이다.
    멈춘 가격(`paper.quotes`의 그날 값)으로 채우지 않는다. 1분봉 자체를 받지 못했을 때만 R3·`QUOTES_CLOSE`(`fallback: true`, 따로 셈)이고, E 주문은 E 가격 밖으로 체결하지 않는다.
13. **판정은 주문 단위 반사실이고 문턱은 출발 전에 고정한다**(T15). 주 판정 M1 = 같은 주문을 `NEXT_OBSERVATION`(계좌1식)으로 체결했다면의 원가격 대비 bp(금액 가중, 결정일 묶음 부트스트랩 90% 구간, 대체 체결은 따로).
    N ≥ 30이고 평균 > +10bp이고 구간 하한 > 0이면 "도움이 됐다", 구간 상한 < 0이면 "손해였다", 그 밖은 "차이를 확인하지 못함(판단 보류)". "고르는 능력"이라고 말하려면 M2(메뉴 8개 평균 대비)도 같은 기준을 넘어야 한다.
    데이터 사건(대체 체결·수집 실패)이 세션의 5% 이상이면 판정하지 않는다. 같은 구간 순자산(S = 100)은 서술용이고 판정에 쓰지 않는다.

## 이유

- **결정 1·2**: 계좌1을 바꾸면 이미 돌고 있는 실험(ADR 0018)의 조건이 바뀐다. 같은 입력·같은 판으로 판단하면 두 계좌의 차이가 체결 시점 하나로 남고, 앞으로 체결 출발이면 계좌2의 모든 체결이 결정 뒤에 알 수 있던 가격이다.
- **결정 3**: 실제 증권 계좌가 고를 수 있는 시점(시가·정해 둔 시각·종가)만 메뉴에 두면 결과를 현실의 주문 방식으로 옮겨 읽을 수 있다. 선택지가 적을수록 8주 안에 시점마다 표본이 모인다.
  정해 둔 과거 시각 T의 봉을 나중에 읽으므로 1분봉이 늦게 들어와도 체결가는 바뀌지 않는다(장부 반영 시각만 늦음).
- **결정 4**: 시간별 수집 주기는 증권사에 없는 주문 방식이라, 고르게 하면 실험이 '수집 주기를 고르는 능력'을 재게 된다. 반사실 기준으로는 꼭 필요하다(M1).
- **결정 5**: 지금 출처로는 미국 개별 종목의 지연을 밝힌 값이 없다. 잰 지연과 '넓게 대 새로'는 지킬 수 있는 선택지이고, 출처 없는 '실시간'을 규칙으로 흉내 내면 없는 숫자를 만든다.
- **결정 6·7**: 1분봉 수집 범위는 대기 주문과 최근 주문에서만 정해진다. 표시 전용 장중 평가를 장부에 쓰면 '화면을 볼 때만'이라는 수집 조건이 실험 조건이 된다.
- **결정 8**: 반사실은 저장본이 최신 한 건만 남아 놓치면 다시 구할 수 없다 — 계좌1 장부 트랜잭션 밖에서 짧게 자주 적어야 한다. 장중 확인은 결정 작업의 잠금을 쥐면 리스크 점검이 줄 선다.
- **결정 9**: 예약이 그날 정기 작업의 최대 호출 수 이상이면 수동 호출이 정기 결정을 굶기지 못한다. KST 날로 세면 서머타임에 하루 확인 둘이 생겨 소상한이 두 번째 확인을 막는다.
- **결정 10·11·12**: 계좌1과 다른 부수 규칙은 그날의 결과를 체결 시점 말고 다른 것으로 가르게 된다 — 한도·기한 규칙은 같게 두고, 계좌2에만 꼭 필요한 컷오프(첫 메뉴 시각 09:30 전에 호출·검증이 끝나게)와
  'E 하루 · 거래가 있었던 가격만'을 더했다. 멈춘 가격으로 채우면 없던 체결을 만드는 셈이다.
- **결정 13**: 계좌 순자산 차이에는 판단 차이가 섞인다. 같은 주문의 다른 시점 가격과 비교하면 출발일·보유 차이의 영향을 받지 않는다. 문턱을 결과를 보기 전에 고정해야 결과에 맞춘 해석을 막는다.

## 대안과 버린 이유

- **장중 결정 회차(세션당 4회, 명세 §1 후보 B)**: 사용자 요구에 가장 가깝지만 정보 집합이 달라 계좌1과 판정할 수 없고, 결정 UNIQUE 변경·새 작업 둘·스레드 6·Yahoo 5분 폴링이 돌고 있는 계좌의 위험을 키운다(T9 ⓑ로 남김).
- **1분봉 재생 엔진·봉인·별도 커서(후보 A)**: 정확하지만 두 번째 처리 흐름과 멱등 키가 생긴다. 시간별 경로 안의 시각 지정 단계(2b)와 짧은 1분봉 기다림(상한 15분)으로 같은 순서를 얻는다.
- **모의 감시 지연(REALTIME 0분·DELAYED 15분, T7 ⓑ)**: 출처 없는 '실시간'을 규칙으로 흉내 낸다. **검증된 실시간 출처가 생길 때까지 데이터 선택 없음(T7 ⓒ)**: 단계 2에서 지킬 수 있는 선택이 있는데 미룬다.
- **시점만 고르는 쌍둥이(T2 ⓑ — 계좌1 주문을 받아 시점만)**: 인과는 가장 깨끗하지만 "스스로 판단해 매매"가 아니다.
- **10-23 종가 사후 체결 출발(T4 ⓒ)**: 지난 가격으로 사는 셈이고 겪지 않은 세션이 성과에 들어간다. **단계 1 배포 직후 출발(T4 ⓑ)**: 1분봉 의미(X1~X5)를 재기 전에 체결가를 쓴다.
- **`NEXT_OBSERVATION`을 메뉴에 넣음(T6 ⓑ)**: 위 결정 4의 이유.
- **계좌2만 따로 한도(예: 월 40, T12 ⓑ)**: 회전율 차이가 판정에 섞인다.
- **기한이 지나면 늘 `SKIPPED`(T17 ⓑ, 한국 방식)**: 서버가 늦게 켜진 날 계좌2만 하루를 잃어 두 계좌의 조건이 갈라진다.
- **거래 없는 주문을 시간별 관측가로 대체 체결(T18 ⓑ)**: 멈춘 가격으로 없는 체결을 만든다.
- **`paper_live_us`를 장부에 씀 · 백엔드가 장중 수집을 요청**: 표시 전용 원칙(ADR 0020)과 "정기 작업은 수집을 일으키지 않음"(ADR 0008)에 어긋난다.
- **시장별·계좌별 프레임 판 고정(T1 ⓑ)**: 새 기능이 필요하고, 한국에는 v3 구간이 없어 지킬 것이 없었다.

## 결과와 남은 위험

- **확정한 날의 운영 사실(2026-10-30)**: 프레임 v4를 03:18 KST 서버에 저장했다(수동 편집 F3, 렌더링 어림 11,723토큰 — 같은 때 설정 판 8에서 `frameworkTokenBudget` 8,000 → 12,000).
  사용자 선택으로 v3의 첫 결정 전에 올려 **v3로 낸 결정은 0건**이고, 미국 계좌1은 10-30 07:30 결정(거래일 10-29)부터, 한국 Claude 계좌는 10-30 22:30 출발부터 v4다. 판은 세 Claude 계좌 공용이다(T1 ⓐ).
  v4 본문(원칙·엔진·지침)에 `NEXT_OBSERVATION`·`NEXT_CLOSE`·`NEXT_OPEN`·'시가'·'장중'·'종가'·'시장가'는 0번, '실시간'은 P5(실물 데이터 우선 — 체결 지시 아님) 1번, '분할 진입'은 E7-R4·E8-R6 2번이다 —
  한 결정에서 한 종목에 주문은 하나(`DUPLICATE_TICKER`)라 분할 진입은 결정 여러 번에 걸쳐 일어나고, 계좌2 고정 문단의 우선순위 줄이 덮지 못하는 시각 지시 규칙은 없다(명세 §3-4).
  한국 출발 밤(10-30 21:55~22:30)에 `calendar.consensus`를 계획대로 켜 미국 `packetVersion`은 10-31 07:30 결정(거래일 10-30)부터 6이다(v4의 첫 결정과 다른 결정).
  `claude.schemaV3`·`claude.figureCheck`는 읽는 코드가 생길 때까지 끈 채 둔다(사용자 결정 2026-10-30 — ADR 0021 결정 6의 '세 스위치를 같은 저장으로'에서 바뀜).
  그래서 계좌2의 예약·소상한 저장 값은 단계 1 9·2, 단계 2 10·3이다(명세 §5-3).
- 배포·출발 기록(채울 자리): 단계 0 `main` 병합·배포 — · X1~X5 측정(3세션) — · 단계 1 배포·`POST /api/paper/init` — · 설정 저장(`settings_version` —, 예약 9·소상한 2·`claude2.enabled`) — · 계좌2 출발 S — · 단계 2 — .
- **단계 1 구현(2026-10-30, 배포 전)**: 계좌 프로필·입력 동결·검증기 순위(이동 — 바이트 그대로), 시각 지정 체결 2b·1분봉 기다림·대체 체결, 계좌2 정의·`claude2.*` 설정·스키마·고정 문단·
  `13_execution`·결정 작업 몫·앞으로 체결 출발·관측치 사슬, 계좌1 화면 이름 "Claude 계좌1"과 옛 이름 목록, 화면(출발 카드·색 `#a438a0`·시점 이름표·실행 표·'체결 시점 실험'·
  'S = 100 같은 구간'·계좌2 한계 문구). 구현이 명세를 좁힌 곳: E 확정 종가 대체(`QUOTES_CLOSE`)는 그 관측치의 그 종목 봉이 E의 확정 종가(봉 날짜 = E)일 때만이라
  E+1 장중에 켜진 서버에서 1분봉이 없는 E 주문은 `NO_BARS` 만료(3개월 수정주가 이력의 E 값은 쓰지 않음 — 명세 §10-1 3a 고쳐 적음). 만료 사유에 `NO_BARS`·`HOLDING_UNVERIFIED`·
  `RECHECK_FAILED`를 더했습니다(명세 §10-4).
- **늦게 푼 주문의 현금 순서(알려진 한계)**: 한 처리 회차에 풀린 시각 지정 주문만 T 순으로 적용하므로, 앞 T 주문이 다음 회차에 늦게 풀리면 그 사이 적용된 더 늦은 T 매도 대금을
  쓸 수 있습니다(가격은 T 봉 그대로, 현금 순서만). 뒤 주문까지 기다리게 하면 정지 종목 하나가 그날 나머지 체결을 마감까지 막아 그대로 둡니다(명세 §17).
- **공용 장부 경로**: 시각 지정 체결(2b)·`fillable` 제외는 계좌1과 같은 코드 경로에 들어간다. 다른 계좌에는 시각 지정 주문이 없어 아무 일도 하지 않는다는 것을 `G/ledger-us-week.txt` 바이트와 달력 대조(2025~2027)로 지킨다.
- **Yahoo 거부 래치 공유**: 1분봉 태스크의 429가 `paper_quotes`를 5분 닫으면 계좌1 관측치가 밀린다. 등록 순서(관측치 바로 뒤)·회차당 배치 1건·빈 범위 0회로 줄이고 단계 0에서 사건 수를 잰다(X5).
- **1분봉의 뜻을 아직 모른다**: 봉 라벨(X1)·첫 봉 시가와 공식 개장가(X2 — 끝까지 모를 수 있음)·마감 뒤 완전성(X3)·되짚을 수 있는 기간(X9). 크게 어긋나면 그 시점을 메뉴에서 빼고 판을 올린다.
- **슬리피지 5bp 고정**: 개장·장중 호가 차이를 반영하지 못해 시가 체결이 실제보다 유리하게 보일 수 있다[추정]. 계좌1과 같은 조건을 위해 유지한다.
- **정보 차이**: `13_execution.record`(T14)는 계좌1에 없는 되먹임이라 계좌 단위 순자산 비교는 판정에 쓰지 않는다.
- **검정력**: 8주 ≈ 37~38세션, N ≈ 30~60이면 30~40bp를 넘는 효과만 가려진다 — '판단 보류'가 정직한 결과일 가능성이 높다(명세 §14-4).
- **스키마 다시 실행**: `make db-test`는 파일마다 다시 돌린다. V14를 다시 돌리면 timing CHECK가 옛 다섯 값으로 돌아갔다가 V17이 다시 넓히므로, 테스트 DB에 `AT_*` 주문 행이 남아 있으면 V14의 CHECK가 실패한다 —
  계좌2 주문을 DB에 쓰는 시험(단계 1)은 시작·끝에 그 행을 지운다(`ApiIntegrationTest`·`PaperLedgerDbTest`의 계좌 코드 목록에 `claude2`). 운영 DB는 대기 중인 파일만 적용하므로 해당 없다.
- **되돌리기**: 단계 2는 `claude2.checkpoints=false`, 계좌2는 `claude2.enabled=false` 뒤 PAUSED(체결 전 주문 취소). 코드를 옛 판으로 되돌리려면 **먼저 계좌2를 PAUSED로 두고 대기 주문을 취소한다** —
  옛 `fillable`은 `AT_*`를 시간별 관측치로 체결하기 때문이다. V17·V18은 더하기만이라 되돌리지 않는다. 다시 시작은 리셋 뒤 앞으로 체결 출발만이고 사후 체결로 메우지 않는다(명세 §16-3).
