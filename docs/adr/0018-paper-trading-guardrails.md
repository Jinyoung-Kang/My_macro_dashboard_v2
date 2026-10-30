# 0018. 모의 알고리즘 매매의 가드레일: 제안은 모델·집행은 코드, 체결은 결정 뒤 첫 관측치, 신호 기관은 공시일 기준 복제 성과로 분기마다, 별도 Private 저장소

- 상태: 채택 (2026-10-24 결정, 2026-10-25 구현 반영). 2026-10-25부터 My_macro_dashboard_v1(Private) 저장소의 main에서 진행합니다(명세 D0).
  2026-10-26 사용자 확인: 이 저장소는 GitHub 공개 저장소입니다 — 아래의 'Private'·'공개하지 않음'은 그때의 기록입니다.
  Local_macro_dashboard_v3 저장소에는 넣지 않습니다. AWS 개인용 배포는 [ADR 0019](0019-aws-personal-deployment.md)가 정합니다. 처음 D0은 push하지 않는 로컬 브랜치
  `claude/paper-trading-2026-10`이었고, 그 브랜치를 그대로 이 저장소의 main으로 옮겼습니다.
- 근거: [명세](../specs/2026-10-24-paper-trading-spec.md)(결정 D0~D27) · [설계 계획서](../specs/2026-10-24-paper-trading-design-plan.md)(구현 결과 §9-1) · [단계 0](../specs/2026-10-24-paper-trading-step0.md)
- 지키는 방법(결정 번호별, 백엔드는 클래스·메서드 이름):
  1. 제안·집행 분리
     - `OrderValidatorTest`: 규칙마다 거절 사유(`staleInputRejectsEverything`·`malformed`·`duplicateTicker`·`outOfUniverse`·`notHeld`·`lockedOut`·
       `noPrice`·`minHold`·`weightCap`·`minNotional`·`monthlyCap`·`maxPositions`·`belowOneShare`·`overAllocatedBiggestFirst`),
       시점별 셈(`maxPositionsIsTimingAware`·`lateSellDoesNotFundEarlyBuy`), 노출 0%·100% 통과(`exposureZeroAndHundredBothPass`),
       같은 입력 같은 결과(`deterministic`)
     - `StructuredSchemaTest`: API용 스키마에 범위·길이·개수 키 없음(`forApiStripsUnsupportedKeysEverywhere`), 걷어 낸 제약은 검사기가 지킴
       (`detectsNumericRange`·`detectsMaxLengthInCodePoints`·`detectsMaxItems`·`enforcesTheOtherStrippedKeywords`)
     - `ClaudeBookServiceTest`: 통과 주문만 대기(`normalResponsePlacesOnlyAcceptedOrders`), 노출 0%·100%(`zeroAndFullExposureAreBothAccepted`),
       새 결정이 앞선 대기 주문을 대신(`laterDecisionSupersedesPendingOrders`)
     - `PacketBuilderTest`: 게이트 지표의 '구속하지 않음'(`gateSection`), '현금 비중 상·하한은 없다'(`hardRulesAndNotes`)
  2. 체결
     - `PaperLedgerServiceTest` 체결 조건: `observationOlderThanOrderDoesNotFill`·`weekendResaveDoesNotFill`·`nextCloseWaitsForFinalClose`·
       `staleBarDoesNotFill`·`sameObservationTwiceIsOnce`. 처리 순서: `sellsBeforeBuys`·`cashLikeBuysFillLast`·`stopRunsBeforeBuysInSameObservation`·
       `twoForOneBeforeStop`. 한 계좌 오류는 그 계좌만(`oneBookFailureIsIsolated`)
     - `PaperLedgerTest`(슬리피지·정수 주식 내림), `PaperStoreDbTest.oneFillPerOrder`·`duplicateFillInsideTransactionRollsBackEverything`,
       `PaperLedgerDbTest.ledgerFlowOnRealTables`(실제 테스트 DB)
  3. 출발
     - `PaperAdminServiceTest`: `initBackfillsBenchmarks`·`initBeforeFinalCloseSkips`·`initFreezesStartPricesForWholeUniverse`·`resetUsesFrozenStartPrice`
     - `PaperStoreDbTest.startPriceIsFrozenPerTradingDate`, `PaperLedgerDbTest.resetReusesFrozenStartPrice`
     - `RuleBookServiceTest.startBackfillsWithEvidence`·`startRefusesWhileCollecting`,
       `ClaudeBookServiceTest.startBackfillsAcceptedOrdersAtFrozenStartPrices`·`previewDoesNotTouchLedgerOrDecisions`·`initialUniverseFollowsPacket`
     - `PacketBuilderTest.initialPacketHasNothingAfterAsOf`(10-23 뒤 값 없음 — 카드만 `asOfMismatch`)
     - `PaperDecisionJobTest.rulesSkipsScheduledOnStartDay`·`claudeDecidesAfterRulesWhenActive`(출발일 이하 정기 결정 없음)
  4. 신호 기관
     - `TrackRecord13FTest`: 손계산(`twoFilingsThreeTickersByHand`), 공시 다음 거래일 매수·기준일 뒤 자료 미사용(`buysOnNextTradingDayAndIgnoresFuture`),
       `coverageRenormalizes`·`windowClipsFirstPeriod`·`ineligibleReasons`, 단계 0 원형과 대조(`matchesStepZeroPrototype`)
     - `PaperSelectionServiceTest`: `collectingCandidateIsExcluded`·`missingLatestQuarterIsExcluded`(R5)·`cutsAtAsOf`·`readsQuietly`·
       `rerankDoesNotChangeSelection`, 그룹 B(`groupBUsesQ30ElseQ8OverTwoYears`·`groupBEligibilityUsesCoverageAndR5`·`groupBCutsAtAsOf`),
       신호 풀(`selectionPoolUnionWithOverlap`·`noGroupBOnlySelectionWhileCollecting`)
     - `Signal13FTest`: `blendsTwoGroupsWithOverlap`·`scoresHandComputed`·`convictionProportional`·`splitIsNotAnAdd`
     - `RuleBookServiceTest`: `nonReselectionDayOnlySells`·`signalsIgnoreFilingsAfterSelectionAsOf`·`signalsUseOneQuarterForAllFilers`
     - `PaperDecisionJobTest`: `reselectionDaySelectsThenRebalances`·`missedReselectionDayCatchesUp`·`skippedReselectionIsRetriedNextDay`
     - `UsMarketCalendarTest.thirteenFDeadlines`·`reselectionDays`, `TrackRecordCandidatesParityTest`(후보 CIK = 수집기 `TRACK_RECORD_FILERS`),
       수집기 `test_filings_track_record.py`
  5. CUSIP 매핑: 수집기 `test_equities.py`(`test_CUSIP_매핑표는_이름이_달라도_같은_증권에_티커를_붙인다`·`test_CUSIP_매핑표에_있어도_채권_우선주는_붙이지_않는다`·
     `test_CUSIP_매핑표가_없으면_예전과_똑같이_붙인다`), `test_filings_track_record.py::test_기존_sec_13f_q8_저장본_모양은_그대로다`
  6. 가격 저장: 수집기 `test_paper_tasks.py`, `DatasetsParityTest`(`SNAP_PAPER_QUOTES`·`TS_EQUITY_CLOSE`·`TRACK_RECORD_QUARTERS`),
     `PaperStoreDbTest.readTimeseriesColumnsLongSeries`
  7. 프레임
     - `FrameworkServiceTest`: `seedsInterimVersionZeroOnce`(v0)·`manualSaveCreatesNextVersion`(v1 USER)·`proposeSendsFrameAndWrappedNote`(PENDING, 자동 반영 없음)·
       `approveAppliesOperations`·`approveRequiresSameBaseAndRejectWorks`·`approveRollsBackWhenProposalChanged`·`manualSaveRequiresCurrentBase`·
       `newIdsNeverReuseDeletedIds`·`renderIsDeterministic`·`systemPromptUsesCurrentSettings`·`stripsLookalikeDelimiters`
     - `ClaudeBookServiceTest.decisionUsesCurrentFrameworkRenderedWithCurrentSettings`·`packetUsesDecisionSettingsRow`, `PacketBuilderTest.usesGivenSettingsRow`·`deterministic`
     - `PaperStoreDbTest.packetTextKeepsSentBytes`(V10), `NoteServiceTest.packetNotes`·`bodyKeepsParagraphs`
  8. 규칙 계좌 동결: `PaperSettingsServiceTest.updatesKnownKeysAndBumpsVersion`(규칙 계좌 영향 키는 경고). `RuleBookService`는 프레임·메모를 받지 않습니다(생성자).
  9. 실패 처리
     - `ClaudeBookServiceTest`: `formatErrorLeavesLedgerUntouched`·`refusalLeavesLedgerUntouched`·`apiErrorIsRetriedOnceOnTheSameRow`·`secondApiErrorEndsRetries`·
       `missingKeyDoesNotCountACall`·`failureAfterPaidResponseIsNotRetried`·`pauseDuringCallLeavesNoPendingOrders`·`resetAndRestartDuringCallLeavesNothing`·`notStartedAndPaused`
     - `AiServiceStructuredTest`: `sendsSchemaEffortAndCachedSystem`(temperature·thinking·fallbacks 없음)·`refusalIsReportedWithCategory`·`rateLimitIsNotRetried`·
       `httpErrorsAreClassified`·`maxTokensIsFailureEvenWithText`
     - `PaperDecisionJobTest`: `givesUpAfterRepeatedErrors`·`rulesErrorDoesNotBlockClaude`·`claudeRetryOnReselectionDayDoesNotAddRulesDecision`·
       `scheduledRunDoesNotWaitForManualRun`·`schedulerHasMoreThanOneThread`, `PaperRiskJobTest.errorsAreRecorded`
  10. 비용: `PaperApiCallsTest`(`reserveWithinCap`·`estimateFormula`·`pricingFromSettings`·`recordUsage`·`pricingKeys`),
      `ClaudeBookServiceTest.dailyCapSkipsWithoutCalling`·`previewRespectsDailyCap`, `FrameworkServiceTest.proposeFailures`(하루 상한은 400),
      `PaperStoreDbTest.apiUsageReservesWithinCap`·`apiUsageEstimatedCost`·`readyRequiresV11`
  11. 경계·접근: `AccessPolicyTest.everyRouteIsClassified`, `ApiIntegrationTest.paperRoutesAreOwnerOnly`,
      `RouteInventoryTest`(`routesMatchInventory`·`apiDocumentMatchesRoutes`·`qaRouteListMatchesRoutes`·`controllersStaySmall`),
      `ArchitectureRulesTest`(`analyticsIsPure`·`jdbcOnlyInStore`·`backendDoesNotWriteCollectorTables`·`controllersGoThroughTheirOwnServices`),
      화면 `access.test.ts`·`endpoints.test.ts`. 저장소 분리(D0)는 시험이 아니라 절차입니다 — v3 저장소에 올리지 않는 것은 CLAUDE.md의 전달 방식이 정합니다(운영 절차는 [설계 §12-3](../specs/2026-10-24-paper-trading-design-plan.md)).

## 배경

가상 자본 10만 달러로 네 계좌를 같은 날 출발시켜 비교합니다([명세](../specs/2026-10-24-paper-trading-spec.md)).

| 계좌 | 역할 |
|---|---|
| 규칙 계좌 `rules` | 13F 신호만 따르는 대조군 |
| Claude 계좌 `claude` | Claude가 매일 한 번 판단하는 실험군 |
| SPY 계좌 `bench_spy`·60/40 계좌 `bench_mix` | 벤치마크 — SPY 100%, SPY 60% · SHY 40% |

어떤 주문도 밖으로 나가지 않습니다. 그래도 숫자가 조용히 좋아 보이게 틀리기 쉬운 자리가 많습니다.

- **LLM 판단**: 같은 입력에도 답이 달라집니다. 하드 제약(비중 상한·유니버스)을 어길 수 있습니다. 과거 결과를 학습으로 알고 있어 과거 재현은 성과를 말해 주지 않습니다.
- **13F**: 공시 시차가 45일이고 종목코드가 없습니다. 공시 이름은 기관마다 다르게 적힙니다([0015](0015-13f-security-identity.md)).
- **가격**: 저장된 종목 가격은 일봉 종가와 날짜뿐이고 시가가 없습니다. 장중에는 마지막 봉이 지연 시세입니다.
- **수집 시각**: 수집기는 주말·휴장일에도 직전 종가를 매시간 다시 저장합니다. 수집 시각만 보면 결정이 이미 본 가격으로 체결됩니다.
- **호출**: Claude 호출 한 번이 수십 초에서 몇 분 걸리고 돈이 듭니다(10-23 초기 결정 미리보기 24.8초, 약 $0.09).

## 결정

1. **제안은 모델, 검증·집행은 코드.** Claude는 구조화 출력(`decision.schema.json`)으로 주문 목록과 목표 주식 노출(`targetEquityExposurePct`)을 냅니다.
   장부를 바꾸는 것은 코드뿐입니다.
   - 검증기(`OrderValidator`)의 하드 규칙은 (수치는 설정 기본값) 집중도(종목 10%·ETF 20%·최대 20종목·합 100%), 회전율(월 20건·재량 매도는 5거래일 뒤·최소 $500),
     재진입 금지, 신선도, 유니버스입니다. 주문마다 정해진 순서의 첫 사유 하나로 거절합니다.
   - **현금 비중·매크로 판단은 모델의 재량입니다**(D7). 노출 0%도 100%도 거절 사유가 아닙니다. 사용자 OS가 쓰던 게이트(10Y 4.80/4.75, 브렌트 95, WTI 90,
     USD/JPY 155)는 `GateIndicator`로 계산해 화면과 패킷에 "참고 — 구속하지 않음"으로만 보입니다. 규칙 계좌·검증기 어느 쪽도 읽지 않습니다.
   - 노출 숫자와 주문이 어긋나면 주문대로 집행하고 `exposureMismatch`를 남깁니다. 숫자를 맞춰 고치지 않습니다.
   - 현금·자리는 체결 순서로 셉니다. `NEXT_CLOSE` 매도는 먼저 체결되는 `NEXT_OBSERVATION` 매수의 현금(`OVER_ALLOCATED`)과 종목 자리(`MAX_POSITIONS`)를
     만들지 못합니다. 장부가 전량으로 집행할 1주 미만 부분 매도는 `BELOW_ONE_SHARE`로 거절합니다. 월 상한은 그달 체결된 정기·수동 주문만 셉니다(초기 배분 제외).
   - 응답 스키마는 두 벌로 씁니다(D26). API는 숫자 범위·길이·개수 제약을 받지 않아 보낼 때 걷어 내고(`StructuredSchema.forApi`), 받은 응답은 전체 스키마로
     코드가 검사합니다(`validate`). 어기면 형식 오류입니다.
   - 새 결정이 형식 검사를 통과하면 앞선 결정의 대기 주문은 모두 취소합니다. 유지하려면 다시 내야 하고, 패킷·프롬프트에 그렇게 적습니다.
2. **체결은 "결정 뒤 처음 관측된 가격"입니다.** 관측치 저장본(`paper.quotes`)의 수집 시각 > 주문 시각 **그리고** 봉 날짜 > 결정 기준 거래일이어야 합니다.
   두 번째 조건이 주말 재저장 룩어헤드를 막습니다.
   - `NEXT_CLOSE`는 마감 + 15분 뒤 저장본만 씁니다. 이어 쓴(`isStale`) 봉으로는 체결하지 않습니다. 시가가 없어 `NEXT_OPEN`은 두지 않습니다(2단계).
   - 체결가는 관측가 × (1 ± 슬리피지, 기본 5bp), 수량은 정수 내림입니다.
   - 관측치 하나는 계좌마다 한 트랜잭션입니다. 순서는 분할 감지 → 매도 → 스탑 → 매수(현금성 마지막)이고, 같은 관측치는 한 번만 처리합니다.
3. **출발은 2026-10-23 종가 사후 체결(`is_backfill`)입니다.** 네 계좌가 같은 날 출발하고, 그 뒤 체결은 모두 관측치입니다.
   - 출발일 종가는 확정 종가가 들어오는 대로(30분마다 정기 작업, 초기화 때도) 유니버스 전체로 한 번 얼립니다(`paper_start_prices`).
     리셋과 뒤늦은 "시작"도 이 값을 씁니다.
   - 벤치마크는 초기화 때 체결합니다. 규칙·Claude 계좌는 사용자가 "시작"을 눌러야 출발합니다(L2). Claude 계좌는 장부를 바꾸지 않는 미리보기가 먼저 있습니다.
   - 초기 결정의 입력은 10-23 이전 값만입니다(C6). 이력이 없는 매크로 카드만 현재 수집본이고 `asOfMismatch`로 표시합니다.
   - 두 계좌 모두 출발일 이하 거래일에는 정기 결정을 내지 않습니다. 출발일의 결정은 초기 결정(INITIAL) 하나입니다.
4. **신호 기관은 고정하지 않고, 두 그룹을 섞습니다**(D6·D27).

   | 그룹 | 후보 | 순위 |
   |---|---|---|
   | A | 액티브 운용사 27곳(`TRACK_RECORD_FILERS`) | 공시일 다음 거래일부터 복제한 7년 CAGR 상위 5 |
   | B | 기존 13F 메뉴 12곳 | 같은 방법의 2년 CAGR 상위 4 |

   - 두 그룹 모두 커버리지 기준(구간 최소 50%·평균 70%)과 최신 분기 공시(R5)를 통과해야 순위에 듭니다. 덮인 대형주만 보이는 인덱스·연기금은 이 기준으로 빠집니다.
   - 재선정은 분기 13F 공시 기한 다음 거래일에, 그날까지 공시된 자료와 가격만으로 합니다. 수집 중인 후보는 자격에서 빼고
     선정하고, 그룹 A 자격 기관이 0곳인데 수집 중인 후보가 있으면(처음 30분기를 채우는 동안) 선정을 남기지 않습니다 — 그룹 B만으로도 선정하지 않습니다.
     규칙 계좌 "시작"은 수집 중인 후보가 있으면 거절합니다. 그날 결정을 놓쳤거나 선정을 건너뛰었으면, 다음 결정 날에 같은 재선정일 기준으로 한 번 따라잡습니다. 수동 재계산은 기록만 하고 선정을 바꾸지 않습니다.
   - 신호는 선정 기준일까지 낸 공시만 쓰고, 모든 기관을 같은 분기로 대조합니다. 후보 점수 = Σ(기관 가중 × 확신도)이고, 목표 비중은 점수에 비례합니다.
   - 규칙 계좌는 재선정일에만 삽니다. 그 밖의 날은 매도 신호·스탑과 남는 현금의 SHY 관리뿐입니다.
5. **후보 기관 보유의 티커는 CUSIP으로 붙입니다**(D25). OpenFIGI·SEC·야후로 대조한 498개 표(`equities_cusip.TRACK_RECORD_CUSIPS`)를 `q30` 저장본에만 씁니다.
   기존 `q8`과 13F 화면은 그대로이고, 채권·우선주·워런트 배제([0015](0015-13f-security-identity.md) 결정 6)를 먼저 적용합니다.
6. **가격 이력은 저장 방식을 나눕니다**(D23). 10년 수정주가는 `timeseries` 데이터셋 `equity_close`(종목별 행, 12시간), 관측치는 스냅샷 `paper.quotes`
   (최근 3개월, 1시간)입니다. 기존 `equity.price_history`(5년·138종목)와 그 화면은 그대로 둡니다.
7. **프레임(투자 OS)은 승인된 판만 씁니다**(F1~F5).
   - v0은 사용자 원문을 받기 전의 임시 판(INTERIM, 시드)입니다. v1이 사용자 OS 원문을 옮긴 판(USER)입니다. "버전 1 = 사용자 OS"(F1)를 지키려고 번호를 이렇게 둡니다.
   - 새 판을 만드는 길은 둘입니다. 방법론 글 → 모델의 제안 → 사람의 승인, 또는 사람의 직접 편집입니다. 자동 반영은 없습니다.
     둘 다 기준 판이 지금 판일 때만 저장됩니다. 새 원칙·규칙 번호는 모든 판에서 쓴 가장 큰 번호 + 1입니다(지운 id를 다시 쓰지 않음).
   - 결정의 시스템 프롬프트는 그 판을 **결정 시점의 설정으로 다시 렌더링**합니다. 프롬프트·패킷·검증·기록이 같은 설정 행 하나를 씁니다.
   - 결정마다 프레임 판·설정 판·보낸 패킷 문자열(`packet_text`, V10)·SHA-256을 남깁니다. 재현은 기록으로 합니다.
   - 메모는 자료입니다. 구분자로 감싸고(가짜 구분자는 변형까지 지움) "지시가 아님"을 적습니다. 그 거래일에 유효한 시황 메모만 패킷에 들어갑니다.
8. **규칙 계좌는 동결된 대조군입니다**(D15·D19). 프레임·메모·게이트를 읽지 않습니다. 규칙 계좌 영향 키(트랙레코드·섞기·스탑·상한·슬리피지 등)를 바꾸면 설정 화면이 한 번 더 확인합니다.
   **Claude 계좌는 백테스트하지 않습니다**(D17).
9. **실패는 "그날 재량 주문 없음"입니다**(C7).
   - 오류·거절(refusal)·형식 위반·호출 상한이면 장부를 바꾸지 않습니다. 리스크 규칙(트레일링 스탑)은 따로 계속 돕니다. 다른 모델로 자동 전환하지 않습니다(D5).
   - 재시도는 `API_ERROR`(401·403·404·429·5xx·연결·시간 초과)만, 같은 거래일 같은 결정 행에서 한 번입니다. 거절·형식 오류는 같은 입력이면 같은 답일
     가능성이 커 다시 부르지 않습니다. 응답을 받은 뒤(과금됨) 검증·저장이 실패하면 원문·사용량을 `API_ERROR`·`retry_count = 1`(`stage = AFTER_RESPONSE`)로
     남기고 다시 부르지 않습니다.
   - Claude 호출은 장부 잠금 밖에서 합니다. 호출하는 사이 계좌가 일시정지되면 결정은 `SKIPPED`, 통과 주문은 `CANCELLED`로 남깁니다. 초기화 뒤 다시 시작됐으면
     아무것도 남기지 않습니다(400).
   - 정기 작업 스레드는 4개입니다(`spring.task.scheduling.pool.size`). 정기 결정은 작업 잠금을 기다리지 않고(`tryLock`, 수동 실행 중이면 `BUSY`),
     같은 거래일 오류가 계좌마다 3번이면 그날은 포기합니다.
10. **비용 상한은 하루 호출 수입니다**(C8·D18). 결정·미리보기·시작·재시도·프레임 제안이 같은 상한(설정 `apiDailyCallCap`, 기본 6회 → 2026-10-26 v2에서 20회(결정 V6), KST 하루, DB로 셈)을 씁니다.
    추정 비용은 설정 키 `pricing.sonnet.*`·`pricing.haiku.*`(USD/MTok) 단가로 호출 때 계산해 `paper_api_usage.est_cost_usd`·`est_cost_calls`(V11)에 더합니다.
    화면은 `isEstimated`와 함께 보이고, 단가나 토큰을 모르는 호출은 0달러로 채우지 않습니다.
11. **별도 Private 저장소입니다**(D0, 2026-10-25 변경). 처음에는 push하지 않는 로컬 브랜치였고, 지금은 My_macro_dashboard_v1 저장소의 main에서
    보통 절차(브랜치 → main → push → CI)로 진행합니다. Local_macro_dashboard_v3 저장소에는 넣지 않고, AWS 개인용 배포(배포 덧붙임 파일)는 별도 ADR로
    정합니다([설계 §12-3](../specs/2026-10-24-paper-trading-design-plan.md)) → [ADR 0019](0019-aws-personal-deployment.md)(2026-10-26): v3에서 옮겨 온 공개 데모용 `compose.aws.yml`은 개인용으로 다시 썼습니다. 새 경로 29개는 모두 운영자(`OWNER`) 전용이고, `/paper`는 운영자 메뉴입니다.

## 이유

- **집행을 코드에 두면** 모델의 답이 흔들려도 장부 규칙은 흔들리지 않습니다. 같은 응답이면 같은 통과·거절이고, 기록만으로 다시 따져 볼 수 있습니다.
- **현금 비중을 하드 규칙으로 두면** Claude 계좌가 OS 문자 그대로의 기계가 됩니다. 사용자는 "무조건 따를 필요 없음, 유동적으로"를 골랐습니다(D7). 규칙 계좌에도
  게이트를 걸지 않아(D19), 두 계좌의 차이가 "Claude의 매크로·현금 판단 + 종목 선택"으로 읽힙니다.
- **수집 시각만으로 체결하면** 금요일 기준 결정이 주말에 다시 저장된 같은 금요일 종가로 체결됩니다. 결정이 이미 본 가격입니다. 봉 날짜 조건이 이를 막습니다.
- **출발일 종가를 얼린 이유**: 수정주가 이력은 배당락 뒤 과거 종가를 낮게 다시 씁니다. 리셋할 때마다 다시 읽으면 처음과 수량·현금이 달라지고 배당이 장부에 섞입니다.
- **신호 기관을 고정하면** 오늘 잘 알려진 승자를 고르는 사후 선택이 됩니다. 공시일 다음 거래일부터 복제해야 45일 시차를 실제로 겪은 성과가 됩니다
  ([0009](0009-regime-track-record-point-in-time.md)와 같은 시점 기준). 커버리지가 낮은 복제 수익률은 그 기관이 아니라 덮인 대형주의 수익률입니다.
- **두 그룹을 섞은 것은** 사용자 요청입니다(D27). 이미 지켜보던 12곳도 같은 자격 기준을 통과해야 들어오므로, 인덱스형이 부푼 수익률로 섞이지 않습니다.
- **CUSIP으로 붙인 이유**: 같은 증권의 이름 표기가 제각각이고 'ISHARES TR' 한 이름 아래 ETF가 수백 개입니다. 단계 0에서 지금 매핑표로는 자격 기관이 1곳,
  CUSIP 498개를 더하면 23곳이었습니다.
- **저장 방식을 나눈 이유**: 단계 0에서 138종목 10년을 한 스냅샷에 넣으니 4.49MB·백엔드 메모리 +130MiB였습니다. 550여 종목이면 약 18MB로 힙을
  넘을 것으로 봤습니다. 따로 두면 기존 화면의 결과도 바뀌지 않습니다.
- **프레임을 승인으로만 바꾸는 이유**: 모델이 자기 규칙을 바꾸면 성과를 잴 기준이 움직입니다. 판 번호와 설정 판을 결정마다 남기면 어느 규칙으로 낸 결정인지 압니다.
  결정 시점 설정으로 다시 렌더링해야 프롬프트의 하드 규칙 수치가 검증기와 어긋나지 않습니다.
- **실패를 "주문 없음"으로 두는 이유**: 다른 모델로 넘어가면 그날 결정이 어느 모델의 것인지 섞입니다. 재시도를 한 번으로 묶으면 비용과 같은 날 결정 두 벌을 막습니다.
  과금된 응답 뒤 실패를 다시 부르면 두 번 내고 다른 답을 받습니다.
- **Claude 호출을 장부 잠금 밖에 둔 이유**: 호출이 몇 분 걸리는 동안 리스크 점검(스탑)이 멈추면 안 됩니다. 스케줄러 스레드가 1개(Spring Boot 기본)여도 같은 일이 생깁니다.
- **단가를 설정에 둔 이유**: 가격표가 바뀌어도 코드를 고치지 않습니다. 2026-10-25 공식 가격표 확인값이 기본값입니다(설계 §5-9).
- **저장소를 나눈 것은 사용자 결정입니다**(D0). 실험 기능과 개인 포트폴리오 맥락이 담긴 프롬프트·투자 OS 원문이 공개 저장소인 v3와 AWS 공개 데모에
  섞이지 않습니다. 이 저장소는 공개하지 않습니다.

## 대안과 버린 이유

- **모델이 도구 호출로 장부를 직접 바꾸기**: 하드 규칙을 프롬프트에 맡기게 됩니다.
- **Claude 계좌에 OS 게이트(L0/L1/L2)를 하드 규칙으로**: D7로 버렸습니다. 지표로만 남깁니다. 규칙 계좌에 게이트를 건 다섯 번째 계좌(`rules_gated`)는 필요해지면 더합니다
  (명세 §9, 설계 §14-7).
- **결정한 날 종가로 체결**: 결정이 본 가격이라 룩어헤드입니다.
- **`NEXT_OPEN` 체결**: 저장된 시가가 없습니다. 수집기 OHLC가 생기면 2단계입니다.
- **신호 기관 고정(기존 12곳 또는 유명 5곳)**: 사후 선택 편향입니다. 기존 12곳은 그룹 B로, 같은 자격 기준을 통과할 때만 씁니다.
- **분기 말 보유로 복제**: 공시보다 45일 먼저 아는 셈입니다.
- **이름 매핑표를 늘리기**: 표기 변형이 끝이 없고 'ISHARES TR' 문제가 남습니다([0015](0015-13f-security-identity.md) 대안과 같은 이유).
- **기존 `equity.price_history`를 10년·550여 종목으로 키우기**: 약 18MB로 힙을 넘을 것으로 봤고(단계 0), 기존 화면의 결과가 바뀝니다.
- **프레임 제안 자동 반영**: 비교 기준이 모델 손에서 움직입니다(D15).
- **실패하면 Haiku로 자동 전환**: D5로 버렸습니다.
- **스키마를 그대로 보내기**: API가 숫자 `minimum`·`maximum`을 400으로 거절합니다(단계 0, D26).
- **SDK 재시도 또는 무제한 재시도**: 같은 거래일 결정이 둘이 되고 비용이 늡니다. 재시도는 부른 쪽이 한 번만 합니다.
- **Claude 계좌 백테스트**: 모델이 과거를 알고 있어 성과가 아닙니다(D17).
- **Claude 호출을 장부 잠금 안에서**: 호출하는 몇 분 동안 스탑 점검이 멈춥니다.
- **v3 main에 기능 스위치로 넣기**: 사용자가 처음엔 로컬 브랜치를, 2026-10-25부터는 별도 Private 저장소를 골랐습니다(D0).

## 결과와 남은 위험

- 백엔드 기능 모듈 `feature/paper`, 순수 함수 `analytics` 10개, 테이블 `paper_*`(V8~V12), 수집 태스크 3개(`paper_quotes`·`paper_price_history`·
  `sec_13f_track_record`), 경로 29개, `/paper` 일곱 탭을 더했습니다. 단계별 결과·운영 상태는 [설계 §9-1](../specs/2026-10-24-paper-trading-design-plan.md)입니다.
- **[확인 필요]** 장중 저장본의 마지막 봉이 그날 지연 시세인지 아직 재지 않았습니다. 10-26(월) KST 22:30 뒤 `paper_job_runs`(job `risk`)의 `detail`로 확인합니다
  (설계 §13 첫 행). 장중 봉이 없어도 체결 조건 2 때문에 `NEXT_OBSERVATION`이 다음 확정 종가 체결이 될 뿐, 룩어헤드는 생기지 않습니다.
- 재무제표는 D28(2026-10-25)로 Claude 계좌 패킷 `8b_fundamentals`에 들어갔습니다(SEC XBRL Company Facts, 공시일 ≤ 기준일 — 설계 §4-5).
  사용자 OS 엔진 E3·E4·E5·E8-R4가 묻는 TTM·마진·FCF·ROE를 싣습니다. 재무로 거는 **필터**(검증기·규칙 계좌)는 동결 대조군을 바꾸지 않으려고 하지
  않습니다(설계 §14-1).
- ~~`AI_ENGINES` 허용 목록([0014](0014-aws-demo-ai-report.md))은 `AiService.structured`를 거르지 않습니다.~~ → 2026-10-26 고침: 목록이 있으면
  목록 안 Anthropic 엔진의 모델만 부르고, 아니면 나가지 않고 `NOT_ALLOWED`(잡은 호출은 되돌림 — `AiServiceStructuredTest.allowListLimitsModels`·
  `PaperApiCallsTest.notAllowedReleasesCall`). 목록이 비면 제한 없음(로컬·개인 배포 기본).
- 트랙레코드는 복제 수익률이지 기관의 실제 수익률이 아닙니다. 후보 목록에는 생존 편향이 있고, 순위는 커버리지에 민감합니다(매핑 445개 → 498개에서
  3위·6위가 자리를 바꿈, 설계 §13).
- 몇 달치 결과로는 통계적 결론을 낼 수 없습니다. Claude 계좌는 같은 입력에도 답이 달라지며, 재현은 기록으로만 합니다(명세 §6).
- 2026-10-30 [ADR 0022](0022-us-claude-book2-timing.md)가 이 문서의 '네 계좌'(결정 3의 같은 날 출발, 결정 2의 `NEXT_OPEN` 없음)를 미국 Claude 계좌2(`claude2` — 체결
  시점 실험, 늦게 앞으로 체결로 출발, 시가·매시·종가 메뉴)에 한해 고쳤습니다. 네 계좌의 결정·패킷·시스템 프롬프트·스키마·장부 순서·체결 조건은 그대로이고(고정본 바이트), 계좌1의
  화면 이름만 "Claude 계좌1"입니다(코드 `claude`·ROLE 그대로).

### 2단계 (2026-10-25, [2단계 명세](../specs/2026-10-25-paper-trading-phase2-spec.md))

새 ADR 없이 이 문서의 원칙을 그대로 적용했습니다 — 2단계 네 항목은 **Claude 계좌의 입력(패킷)과 프레임 갱신 통로에만** 닿고, 규칙 계좌·검증기·
벤치마크는 바꾸지 않았습니다(D35). 외부 글(헤드라인·복기 입력)은 구분자로 감싼 자료이고, 일정·사건은 주문을 막거나 강제하지 않습니다(D7과 같음).

- **A 발표·실적 일정** — 수집 `us_calendar`(FRED 릴리스별 발표일 + 연준 FOMC 연간 상수 + yfinance 실적일), 패킷 `1b_calendar`(기준일 뒤 10거래일).
  지키는 시험: `CalendarWindowTest`(창·휴장·미공개 구간·자료 없음 구분), `CalendarSectionTest`.
- **D 주간 복기 루프** — `paper_reviews`(V12, 백엔드만 씀), 코드가 만든 입력(체결 뒤 수익률·스탑·200일선·거절 주문 가정 수익률·같은 기간 계좌 수익률),
  토요일 정기 작업, 프레임 수정은 기존 제안 통로에 **PENDING**(자동 반영 없음 — 결정 7). 지키는 시험: `ReviewFactsTest`(손계산·룩어헤드 없음),
  `ReviewServiceTest.proposalBecomesPendingAndFrameworkUnchanged`(승인 전 프레임 판 불변)·같은 주 1건, `PaperReviewJobTest`.
- **B 사건 뉴스** — RSS만·제목·출처·시각만(D29, HTML·본문 없음, 야후는 robots.txt로 제외), 수집 `news_headlines`(feedparser 6.0.14, 7일 보존),
  패킷 `11b_events`(직전 결정 이후, 보유·후보 티커나 매크로 키워드에 걸린 것만 최대 10건 — 사건 감지형, D30). 지키는 시험: `NewsEventsTest`
  (티커 오탐·키워드·창·0건과 실패 구분), `EventsSectionTest`, `NewsFeedsParityTest`(수집기 피드 키 대조).
- **C 어닝 서프라이즈** — 수집 `earnings_surprise`(yfinance 내부 quoteSummary — 버전 고정·모양이 바뀌면 멈춤), 8b 행에 최근 4분기 EPS·서프라이즈
  (발표일 ≤ 기준일이면서 결정 시각 전 발표만). 지키는 시험: `EarningsHistoryTest`, `PacketBuilderTest.earningsInitialPacket`(10-23 재현).
- **측정** — 결정 응답 `measure{hasCalendar, calendarItems, hasEvents, eventIds, hasEarnings, earningsRows}`(명세 §6, 0건과 '없음'을 구분 —
  `DecisionMeasureTest`). 8주 뒤 결정 로그로 인용·과매매·제안 승인율을 봅니다(통계 결론은 내지 않음).
- 더한 것: 수집 태스크 4개(`sec_fundamentals`(D28)·`us_calendar`·`news_headlines`·`earnings_surprise`, 전체 27), 백엔드 경로 3개(복기), 패킷
  `PACKET_VERSION` 5·크기 목표 35,500(어림). Claude 계좌 운용 중에 시스템 프롬프트(`ClaudePrompts`의 기존 상수)는 바꾸지 않았습니다.
- 남은 위험: 인베스팅닷컴 RSS 이용 조건 `[확인 필요]`, yfinance 내부 호출(버전을 올리면 고정본 시험부터), FRED 일정은 그해 말까지만, 실적 보도자료
  (8-K)는 들어오지 않음, 복기 입력 토큰은 첫 실행으로 다시 잼.

### 프레임 v2 (2026-10-27)

- 사용자 원문 "프레임 v2"를 수동 편집(F3)으로 v2(USER)로 올렸습니다 — 원칙 7·규칙 52, v1의 규칙 29개는 문장 그대로입니다. 규칙 계좌·검증기·
  벤치마크·패킷·출력 스키마는 바꾸지 않았고 프레임 판만 올라갔습니다. 첫 정기 결정(거래일 10-26, 10-27 07:38 KST)부터 v2를 썼고, 성과 차트의
  판 경계는 10-26입니다(경계는 결정의 거래일). 기록은 [설계 §9-2](../specs/2026-10-24-paper-trading-design-plan.md)·
  [decisions.md](../decisions.md).
