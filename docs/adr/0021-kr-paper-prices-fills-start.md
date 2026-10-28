# 0021. 한국 모의 매매 책: 잠정가는 토스·확정가는 금융위(체결 행은 고치지 않고 확정 조정 행), 체결은 다음 거래일 시가, 슬리피지는 비용 칸, 네 계좌는 출발일 밤 결정 → 다음 날 시가에 함께 출발, 캘린더 컨센서스는 출발일에 두 책 함께

- 상태: 채택 (2026-10-27, 사용자 지시 '권장안대로 진행'으로 명세 확정 — 아래 여섯 결정은 모두 그 권장안). 미국 책(ADR 0018)의 원칙은 그대로이고,
  이 문서는 한국 시장 자료의 사정 때문에 미국과 달라진 것 중 **출발 뒤에는 되돌리기 어려운 것**만 적습니다.
  묶음 A·B(시장 추상화·V14·`KrxCosts`·`paper.kr.quotes` 계약)는 main에 있고, 나머지는 묶음 C·E에서 만듭니다. 출발(K25) 전까지 미국 책 동작은 바뀌지 않습니다.
- 근거: [한국 책 명세](../specs/2026-10-26-v2-kr-paper-spec.md) §4-1·§4-2·§4-3·§4-8·§4-12·§5·§8 **K4·K13·K22·K28·K29·K31**·§9 ·
  [ADR 0018](0018-paper-trading-guardrails.md)(미국 책 가드레일) · [ADR 0020](0020-v2-program.md)(v2 프로그램, 결정 5) · [decisions.md](../decisions.md) 2026-10-27 '캘린더 컨센서스'
- 지키는 방법(결정 번호별 — 지금 있는 시험, 그리고 명세 §9가 그 묶음에 둔 시험):
  1. 가격 역할(K4)
     - 있음: 수집기 `test_kr_paper_quotes.py::test_저장본은_계약_1의_모양이다`(봉 출처 `TOSS_DAILY`·`TOSS_INTEGRATED`, 1분봉 개장 봉 `TOSS_1M_OPEN`·라벨 `09:01`·`10:01`)·
       `test_1분봉_확정_결과는_다시_묻지_않고_실패는_다시_묻는다`, `test_fsc.py::test_시가_고가_저가가_없으면_None이다`·`test_거래가_없던_날의_시가_0은_None이다`,
       `test_fsc_etf.py::test_403_코드_30이면_호출_1회로_멈추고_활용신청_필요로_남긴다`·`test_거래가_없던_ETF의_시가_0은_None이고_영문_섞인_코드를_받는다`
     - 있음(C2b): `KrLedgerTest.Ladder` — `minuteOpenWins`(1분봉 '개장 + 1분' 봉 시가가 있으면 반드시 `TOSS_1M_OPEN`)·`dailyOpenOnlyWithoutMinuteBar`(없을 때만 토스 일봉 시가 —
       NXT 종목 `TOSS_INTEGRATED`, KRX 단독 봉 `TOSS_DAILY`)·`nextCloseIsNeverFilledFromTheDailyClose`·`openTimeOverrideMovesTheLabel`, `KrLedgerTest.FailedMinute`(1분봉 `FAILED`는 기다림, 결정 기한 뒤 수집본에도 남으면 사다리 — 결정 d11),
       `KrQuotesTest`(계약 1 파서)
     - 있음(C2c): `KrLedgerTest.Stops.watermarkRisesOnlyOnConfirmedCloses`(최고가가 `TOSS_INTEGRATED`·`TOSS_DAILY` 종가로 오르지 않고 금융위 종가로만). 있음(C3): `KrConfirmationsTest.provisionalNeverOverwritesConfirmed`(확정값이 토스 재수집의 잠정값으로 덮이지 않음 — `upsertNav`)
  2. 체결 시점(K13)
     - 있음: `DecisionTimingsLockTest.schemaMarketAndPromptAgree`(운영 결정 문맥마다 스키마 timing enum = 시장 체결 시점 = 고정 문단 — E2b부터 운영 목록이 미국·한국이라 한국도 봄)·
       `krSchemaMarketAndPromptAgree`(한국 스키마·고정 문단·하드 규칙 줄은 받는 시점 `NEXT_OPEN`만),
       `OrderValidatorMarketTest.timingsAreTheMarkets`·`singleTimingMarket`, `PaperStoreDbTest.v14TimingFillCostsAndCorpActionHold`(`paper_orders.timing`의 `NEXT_OPEN`),
       미국 쪽 그대로 `UsPaperMarketTest.timings`·`PaperLedgerServiceTest.nextCloseWaitsForFinalClose`
     - 있음(C1): `KrPaperMarketTest.values`(`KrPaperMarket` 값 고정 — `ALLOW_NEXT_CLOSE = false`이면 시점은 `NEXT_OPEN` 하나). 있음(C2b): `KrLedgerTest.Conditions`(`fillableBar` 한국판 — 봉 날짜 > 기준 거래일·
       그 종목 수집 시각 > 주문 생성·거래량 0 봉과 이어받은 항목 아님·하룻밤 빠져도 기준일 다음 거래일 시가), `KrStartTest.benchmarksFillAtTheNextOpen`(벤치마크 두 계좌가 S+1 시가에 체결).
       있음(C2c): `KrLedgerTest.Stops.detectionPlacesTheNextOpenStopOrder`(스탑 → 다음 거래일 시가 `STOP` 주문)·`notConfirmedCancelsWithoutLockout`(확정 D 종가로 다시 판정해
       `STOP_NOT_CONFIRMED`, 재진입 금지 없음), `KrConfirmationsTest.rejudgeUsesTheConfirmedWatermark`·`rejudgeWatermarkStopsAtTheDetectionDate`(재판정 최고가 = 확정 조정이 낮춘
       감지일까지의 확정값)
  3. 확정 조정(K29)
     - 있음: `KrxCostsTest.confirmBuy`·`confirmSell`(명세 §5 손계산 현금 +1,000·+999)·`confirmNoChangeAndNegative`·`cashFlowFromStoredColumns`,
       `PaperStoreDbTest.fillConfirmationsOnePerFill`(체결마다 한 행, 추가만)·`v14TimingFillCostsAndCorpActionHold`
     - 있음(C3): `KrConfirmationsTest.buyConfirmation`·`kospiSellConfirmation`(확정 조정 손계산 두 건을 장부 경로로 — 현금 +1,000·+999, 체결 행 불변)·`idempotentAcrossRestarts`·
       `fillTimeSettingsVersion`(체결 때 설정 판)·`averageAcrossLaterBuys`(평단은 가격 차이만큼)·`etfUncorrectedOnlyWhenTheRowIsMissing`·`navLineIsConfirmed`·`navWaitsForEveryHolding`·
       `cashOnlyLineWaitsForTheSale`(그날까지 모든 체결·보유가 확정된 날만 `prices_final=true`)·`heldValuationStaysBound`·`provisionalNeverOverwritesConfirmed`(확정값 불가침)·
       `riskJobConfirmsWithoutANewObservation`, `PaperStoreDbTest.fillConfirmationReadWrite`·`settingsInForceAt`
  4. 슬리피지(K31)
     - 있음: `KrxCostsTest.kospiBuy`·`kospiSell`·`kosdaqSell`·`etfBuy`·`etfSell`(§5 비용 다섯 건)·`affordableQuantity`·`costBpDoesNotJumpAtBandEdges`·`formerJumpPointsAreFlat`
       (호가 경계에서 실효 bp가 뛰지 않음)·`decimalNotDouble`
     - 있음(C2b): `KrLedgerTest.Costs`(§5 손계산 여섯 건을 장부 경로로 — 체결 행 `price` = 관측가, 비용은 `fee`·`tax`·`slippage_cost` 칸, 현금, 매수 가능 수량),
       `PaperStoreDbTest.fillCostColumnsRoundTrip`(비용 칸 저장), `PaperMarketIsolationTest.costColumnsAreStored`
  5. 출발(K28)
     - 있음(미국 출발 경로가 그대로임): `PaperAdminServiceTest.initBackfillsBenchmarks`·`initBeforeFinalCloseSkips`, `PaperMarketIsolationTest.backfillIsUsOnly`
     - 있음(C1): `PaperConfigTest.emptyKrStartKeepsUsBoot`(`kr.start-date`가 비어도 미국 기동), `PaperAdminKrInitTest.nonTradingStartDateIsRefused`·`unknownYearIsRefused`(한국 초기화의
       `KrxCalendar` 거래일 검사 — 공휴일 저장본은 `StoreReader.quietly`), `KrStartTest.startsRulesAndBenchmarksAtS2230`(벤치마크 두 계좌의 S+1 `NEXT_OPEN` 주문 — D1에서 규칙 계좌도 함께라 이름이 바뀜).
       점검(§9) — QA 스택에서 벤치마크 두 계좌가 S+1 시가 출발부터 끝까지 돎(수용 기준 1)은 F1(한국 초기화 경로) 뒤로 옮김(명세 §4-1 'C3' '수용 기준 1'). 있음(C3): `KrBenchmarkLifecycleTest.benchmarksFromInitToConfirmedNav`(초기화 → S 22:30 출발 → 봉 ≤ S로는
       체결 안 함 → S+1 시가 → S+2 밤 확정 조정 → 순자산 = 출발가 대비 ETF 가격 변화 − 비용, 결정적 시험 — QA 스택 점검은 F1 뒤).
     - 있음(D1): `KrStartTest.startsRulesAndBenchmarksAtS2230`(규칙 계좌 `INITIAL` — S 재선정과 같은 계산·입력 동결, 벤치마크와 한 트랜잭션, S+1 `NEXT_OPEN`)·
       `startInputsHaveNothingAfterTheDecision`(출발 입력 ≤ 결정 시각 — `PacketBuilderTest.initialPacketHasNothingAfterAsOf`의 규칙 계좌판)·
       `rulesLegFailurePostponesTheStart`(규칙 몫 실패 → 어느 계좌에도 쓰지 않고 다음 KR 거래일로 미룸)·`claudeNotYetStaysNotStarted`(Claude 몫이 아직 없으면
       규칙·벤치마크 셋만 출발하고 Claude는 뒤따라 출발하지 않음)
     - 있음(E2b — 네 계좌 함께 출발, 실제 한국 Claude 경로 `KrClaudeFixtures`): `KrStartTest.fourBooksStartTogether`(S 22:30 네 계좌 `INITIAL`·S+1 `NEXT_OPEN` 주문·운용 전환·
       S 순자산 1억을 한 트랜잭션으로 — Claude 결정 행 동결본 = 보낸 패킷, 카드 `asOfMismatch=false`, 읽은 순간 = 그 실행의 지금, 정기 작업 몫으로 부름)·
       `claudeStartPacketLeavesOutSnapshotsAfterTheReadInstant`(출발 결정의 입력 ≤ 결정 시각 — 읽은 순간 뒤 수집본은 빠짐, 패킷 자체는
       `KrPacketBuilderTest.initialPacketHasNothingAfterTheReadInstant` — `PacketBuilderTest.initialPacketHasNothingAfterAsOf`의 한국판)·
       `claudeCapPostponesAllFourBooks`(Claude 상한 → 네 계좌 모두 쓰지 않고 다음 KR 거래일에 넷이 함께)·`claudeErrorAfterOneRetryPostponesAndIsNotReplanned`(API 오류 재시도 1회 뒤 실패 →
       미룸, 같은 창에서 재기동해도 다시 부르지 않음 — E0 저장된 미룸, 거절은 다시 부르지 않음)·`claudeStartCallIsBoundedByTheDeadline`(호출 대기 한도 = 기한 − 지금, 기한을 넘겨 끝난
       호출은 쓰기 트랜잭션이 막음, 1초도 없으면 부르지 않음). 가짜 몫으로 보는 파이프라인 규칙은 그대로 `failedLegPostponesAllBooks`·`slowPlanPastTheDeadlineWritesNothing`·
       `claudeNotYetStaysNotStarted`(몫이 없는 파이프라인 — 시험).
     - 있음(묶음 E 리뷰 — 과금 호출을 버리거나 되풀이하지 않게): `KrStartTest.claudeStartRetrySendsTheFirstPacket`(API 오류 재시도는 첫 호출의 패킷 그대로)·
       `claudeIsNotCalledWhenAnotherLegFails`(과금 몫은 규칙·벤치마크 몫이 하나도 실패하지 않았을 때만 부름)·`startRecordsCountTheChargedClaudeCalls`(결정 행 없이 끝난 출발의
       과금 호출을 미룸 기록 `calls`에), 2차 리뷰 `chargedStartWriteFailurePostponesTheSession`(과금된 Claude 계획 뒤 쓰기 오류 → 그 세션 미룸, 같은 창·재기동 뒤에도 다시 부르지
       않음 — 호출 1회)·`startErrorCountSurvivesARestart`(과금 몫 없는 쓰기 오류 세 번이면 기한까지 쉼 — 저장된 오류 기록 수라 재기동해도 같음)
  6. 캘린더 컨센서스(K22)
     - 있음: `PacketBuilderTest.goldenUsPackets`(꺼짐 — 미국 `packetVersion` 5 패킷 고정본·해시 그대로), 수집기 `test_us_consensus.py::test_백엔드와_화면은_컨센서스_저장본을_읽지_않는다`
       (읽는 곳은 미국 패킷 `PacketBuilder` 하나 — 이름 상수 `Datasets` 말고, E1b)
     - 있음(E1b): `PacketBuilderTest.goldenUsPacketsWithConsensus`(켜짐 = 판 6 고정본 — 1b 컨센서스 층만 다름)·`consensusSwitchIsRecordedInTheSettingsHistory`(스위치 저장 한 번이
       설정 판 +1·`changed_keys`, 끄면 다시 5)·`goldenUsPacketsIgnoreStage2SharedKeys`, `FrameworkServiceTest.goldenRenderIgnoresStage2SharedKeys`(컨센서스를 끈 채 2단계 공유 키 —
       예약·3단계 스위치 `claude.schemaV3`·`claude.figureCheck` — 를 켜도 미국 패킷·시스템 프롬프트가 바이트 그대로, K37), `KrPacketBuilderTest.krPacketIsVersion6RegardlessOfTheConsensusSwitch`
       (한국 패킷은 스위치와 상관없이 판 6 — 1b 컨센서스 null + '한국 컨센서스 출처 없음')

## 배경

v2 2단계는 한국 증시 책이다 — 1억 원씩 네 계좌(수급 규칙 `kr_rules`·Claude `kr_claude`·KODEX 200 `kr_bench_k200`·60/40 `kr_bench_mix`, ADR 0020 결정 5).
미국 책의 원칙(제안은 모델·집행은 코드, 결정 뒤 첫 실제 체결 가능가, 실패는 그날 주문 없음)을 그대로 쓰지만 한국 자료는 사정이 다르다.

- 서버는 KST 21:55~08:00에만 켜져(ADR 0019) 장중 관측치가 없다. 그날 D의 자료는 D 밤(토스)과 D+1 밤(금융위)에 들어온다.
- [확인] 토스 일봉은 NXT 거래 종목에서 KRX+NXT 통합가다(시가 = 08:00 첫 체결, 종가 = 19:59:59 마지막 체결 — 금융위와 시가 4/4일·종가 2/3일 다름).
  1분봉 `09:01` 라벨 봉의 시가는 금융위 시가와 같았다(표본 1 — G1은 아직 판정하지 않음).
- 공식가(금융위 주식시세·증권상품시세)는 '다음 영업일 13시 이후' 공개라 서버 창에서는 D+1 밤 첫 slow에 들어온다.
- 미국 책은 체결 행을 쓴 뒤 고치지 않는다. 확정가를 체결 행에 다시 쓰면 그 규칙이 깨진다.
- 미국 책은 슬리피지를 체결가에 얹는다. 한국 호가 단위로 반올림해 같은 일을 하면 실효 비용이 가격대마다 다르다.
- 미국 책 출발은 '출발일 종가 동결 + 사후 체결'이었다(일요일 결정 → 금요일 종가, 사이에 세션이 없었음). 한국은 S 종가가 S+1 밤에야 들어온다.
- 미국 `1b_calendar`에 컨센서스를 더하면 미국 책 패킷, 곧 ADR 0018의 실험 조건이 바뀐다.

## 결정

1. **가격 역할(K4)** — 잠정 = 토스, 확정 = 금융위.
   잠정 체결가는 토스 1분봉 '개장 + 1분' 라벨 봉의 시가(`TOSS_1M_OPEN`, KRX 시가 단일가), 잠정 평가·거래정지·거래량은 토스 일봉.
   **시가 사다리**: 1분봉 시가가 있으면 반드시 그 값, 없을 때만 토스 일봉 시가(`TOSS_INTEGRATED`, 잠정 배지).
   확정가는 금융위(주식 `mkp`·`clpr`, ETF 증권상품시세)이고 **들어오면 언제나** 그 값으로 확정한다(불일치할 때만이 아님).
   장부 관측치는 `adjusted=false`(금융위와 같은 판), 이력·통계는 `adjusted=true`. 고가·저가는 체결·스탑에 쓰지 않는다.
2. **체결 시점(K13)** — `NEXT_OPEN`(다음 거래일 시가)이 기본이다. 규칙·벤치마크 계좌는 늘, Claude는 기본. `NEXT_CLOSE`는 G2(1분봉 15:30 단일가 봉 = 금융위 종가)를
   통과할 때만 Claude에게 허용하고, 허용 여부는 설정이 아니라 코드 상수 `KrPaperMarket.ALLOW_NEXT_CLOSE`(지금 `false` — G1·G2 미판정)로 스키마 enum·프롬프트 문장과 함께 잠근다.
   `NEXT_OBSERVATION`은 두지 않는다. 체결 조건은 미국 `fillableBar`와 같다(봉 날짜 > 기준 거래일, 관측 수집 시각 > 주문 생성, 그 시점의 잠정가가 있음, 거래량 0 봉이 아님).
   트레일링 스탑은 밤 잠정 평가가로 감지해 **다음 거래일 `NEXT_OPEN` 매도 주문**(출처 `STOP`)을 내고, 체결 처리 때 확정 D 종가로 다시 판정해 스탑가에 닿지 않았으면
   `STOP_NOT_CONFIRMED`로 취소한다(K30). 최고가는 KRX 기준가로만 올린다.
3. **확정 조정(K29)** — 체결 행은 쓴 뒤 고치지 않는다. 금융위 확정가가 들어오면 체결마다 `paper_fill_confirmations` 한 행(추가만)을 쓴다:
   확정가, 그 값으로 다시 계산한 수수료·세금·슬리피지, `cash_delta` = 확정 기준 현금 흐름 − 잠정 기준 현금 흐름. 같은 트랜잭션에서 계좌 현금을 `cash_delta`만큼,
   보유 평단을 가격 차이만큼 옮긴다(평단은 체결가로만 세고 비용은 비용 칸에 둔다). 다시 계산하는 비용은 지금 설정이 아니라 **그 체결 때 유효했던 설정 판**
   (`paper_settings_history`)으로 센다 — 요율 변경이 현금 차이에 섞이지 않게(명세 §4-3 'B6 구현에서 정한 것', 묶음 C 착수 때 정함).
   그날까지 모든 체결이 확정되고 모든 보유가 확정 종가로 평가된 날만 순자산 `prices_final=true`이고, 확정값은 잠정값으로 덮지 않는다. G1이 실패해도 같은 길이다.
4. **슬리피지(K31)** — 체결가 = 관측가 그대로(KRX 단일가는 늘 호가 위). 슬리피지 `kr.slippageBp`(기본 5bp)는 수수료처럼 따로 계산하는 비용 칸
   `slippage_cost` = 체결 금액 × bp(원 미만 절사)로 현금에서 뺀다. 미국 책은 지금처럼 체결가에 얹는다(미국 행의 `slippage_cost`는 0).
5. **출발(K28)** — 출발일 S의 22:30 한국 결정 작업이 출발을 낸다. 입력은 그때 수집된 S 밤 판(결정 행에 동결), 네 계좌 주문은 모두 `NEXT_OPEN`·기준 거래일 S → **S+1 시가 체결**.
   규칙 계획과 Claude 응답이 모두 준비된 뒤 네 계좌의 결정·주문을 **한 트랜잭션**으로 쓰고, Claude가 상한·오류(재시도 1회 뒤)·기한(S+1 01:00)으로 실패하면 어느 계좌에도 쓰지 않고
   출발을 다음 KR 거래일로 미룬다(Claude 응답을 받은 뒤 그 쓰기가 실패해도 같음 — 같은 창에서 다시 계획하면 과금 호출을 되풀이하므로, 묶음 E 2차 리뷰). 사후 체결·출발일 종가 동결·`paper_start_prices`·`backfill`은 한국에 없다. 수익률의 기준은 S 마감 순자산 1억 원(전액 현금).
   벤치마크는 069500 100% · 069500 60% + 153130 40%, 출발 뒤 리밸런싱 없음. 묶음 C에서는 벤치마크 두 계좌만 주문을 내고 규칙 계획(D1)·Claude 계획(E2)이 들어갈 자리를 두었다.
   D1부터 규칙 계좌 몫은 S 재선정과 같은 계산(입력 동결 K26)으로 `INITIAL`을 낸다. Claude 몫이 아직 없으면(E2 전) 규칙·벤치마크 셋만 한 트랜잭션으로 출발하고 Claude는
   시작 전 그대로 뒤따라 출발하지 않는다(출발 판정 = 넷 모두 시작 전 — 그 몫이 생긴 뒤 넷을 리셋해 다시 출발). 서버는 E2 뒤에만 출발하므로 운영에서는 넷이 함께 출발한다.
6. **캘린더 컨센서스(K22)** — 미국 `1b_calendar.macro`에 `forecast`·`previous`·`unit`·`consensusSource`를 더하고 출처는 Nasdaq(비공식 참고, ADR 0017식)이다.
   수집은 먼저 넣어 저장만 하고(`calendar.us_consensus`), 패킷 스위치 `calendar.consensus`(기본 false)는 **한국 출발일 S 21:55~22:30에** 3단계 스위치
   `claude.schemaV3`·`claude.figureCheck`와 같은 설정 저장 한 번으로 켠다 — 미국 `packetVersion` 5 → 6(S+1 07:30 결정부터), 한국은 처음부터 6, 프레임 판은 그대로.

## 이유

- **K4**: NXT 종목의 토스 일봉은 KRX 공식가가 아니고(08:00 프리마켓 첫 체결이 시가일 수 있음) 공식가는 하루 늦게 온다. 잠정·확정을 나누면 밤마다 체결·평가를 하면서도
  현금에는 결국 공식가만 남는다. '불일치할 때만 확정'은 우연히 같은 날과 확인한 날을 가르지 못한다.
- **K13**: 서버가 장중에 꺼져 있어 '결정 뒤 첫 실제 체결 가능가'(미국 `NEXT_OBSERVATION`의 뜻)는 다음 거래일 시가 단일가다. 단일가는 KRX가 공표하는 한 가격이라
  잠정가와 확정가를 맞대어 볼 수 있다. 밤에는 장이 닫혀 있어 스탑을 감지한 관측가로 팔 수 없다. `NEXT_CLOSE` 허용을 런타임 설정으로 두면 정적 스키마 enum·프롬프트를 맞출 방법이 없다(K38).
- **K29**: 체결 행 UPDATE는 '쓴 뒤 고치지 않음'을 깨고 잠정가와 그 근거를 지운다. 추가만 하는 조정 행이면 잠정·확정 차이가 기록과 화면에 남고, 다시 계산해도 같은 결과가 나온다.
  [확인] 예: 10주 매수 잠정 71,300 → 확정 71,200이면 현금 +1,000(수수료 106·슬리피지 356 그대로).
- **K31**: [확인, Decimal 재계산] 호가 반올림(`tickRound(관측가 × (1 ± bp))`)은 매수 실효 비용이 가격대에 따라 5.00~25.0bp로 뛰고(20,000원 → 20,050원은 25bp),
  단일가 체결에는 호가 스프레드가 없어([추정]) 한 호가를 더 얹으면 비용을 두 번 센다. 비용 칸이면 모든 가격대·종목에서 설정값 5bp(원 미만 절사 차이뿐)로 미국 책과 크기가 같다.
- **K28**: 금융위 S 종가는 S+1 밤에 들어온다. 그때 결정해 S 종가로 사면 S 15:30 뒤의 정보(S 수급 저녁판 20:2x·NXT 19:59 체결·야간선물·S+1 세션 전체)가 그 주문의 입력에 들어간다(명세 리뷰 blocker).
  S 밤에 결정해 S+1 시가에 사면 입력은 모두 결정 전에 알 수 있던 것이다. 네 계좌가 같은 시가로 함께 출발해야 출발가 출처가 계좌마다 달라지지 않는다.
- **K22**: 실험 조건(ADR 0018)을 배포일이 아니라 설정 저장일에 한 번만 바꾸면 `settings_version`·`changed_keys`가 결정마다 남고, 두 책이 같은 날 같은 판이 된다.

## 대안과 버린 이유

- **K4 — 토스만(확정 없음)**: NXT 종목의 통합가가 현금에 영구히 남는다. **금융위만**(NXT 종목 `NEXT_OPEN`을 `mkp`가 들어오는 체결일 다음 밤에 체결로 봄 — G1 실패 때의 다른 안이기도 함):
  확정 조정이 필요 없지만 체결이 하루 늦어 결정 게이트 ①('앞 결정의 주문이 정리됨')이 다음 결정을 매번 하루씩 막는다.
- **K13 — `NEXT_OBSERVATION` 그대로**: 한국 관측치는 D 밤의 하루치라 '관측가'가 어느 순간의 가격인지 정해지지 않는다. **종가 기본**: G2 미판정이고 15:30 단일가 봉은 아직 받지 않는다(계약 1).
  **스탑 즉시 체결(미국 `IMMEDIATE`)**: 밤에는 그 가격으로 팔 수 없다.
- **K29 — `paper_fills.confirmed_price` 열(초안)**: 체결 행 UPDATE라 뺐다.
- **K31 — 불리한 쪽 호가 반올림(초안)**: 위 5~25bp. 능동 계좌만 벤치마크·미국 책보다 구조적으로 불리해진다([추정] 월 회전율 50%면 연 약 0.6~1.8%p).
- **K28 — ⓐ S 22:30 결정 + S 종가 사후 체결**: S 15:30 뒤 공개된 수급 저녁판·NXT 체결·야간선물이 S 종가 주문의 입력에 남는다.
  **ⓑ 입력을 S 15:30 전에 알 수 있던 것으로 제한 + S 종가 사후 체결**: 수급(S−1까지)·`1_basis` 카드·토스 통합 종가를 모두 빼야 해 한국 패킷의 핵심이 비고, 미국 책과 다른 조립 경로가 하나 더 생긴다.
  **미국식 '한 계좌만 늦은 시작'**: 출발일·출발가가 계좌마다 달라진다.
- **K22 — 배포와 함께 켜기**: 판이 설정 기록에 남지 않고 두 책이 다른 날 다른 판이 된다. **TradingView 먼저**: [확인] 이 PC에서 403(G11).

## 결과와 남은 위험

- 지금(2026-10-27, 묶음 A·B 뒤): V14(`NEXT_OPEN`·비용 칸·확정 조정 표·`corp_action_hold`), `analytics.KrxCosts`(비용·매수 가능 수량·확정 조정 금액), `paper.kr.quotes` 계약 1
  (봉 출처·1분봉 개장 봉), `calendar.us_consensus`는 저장만. 미국 고정본(`backend/src/test/resources/paper/golden/`)과 패킷 해시는 바이트 그대로다.
  남은 일은 C1(`KrPaperMarket`·`kr.*` 설정·초기화·벤치마크 출발 주문), C2(체결·사다리·스탑), C3(확정 조정), E1(컨센서스 패킷), E2(네 계좌 함께 출발).
- 묶음 C 뒤(2026-10-27, C3까지): 확정 조정은 장부가 관측치 처리 앞에서, 리스크 점검이 새 관측치가 없는 주기에도 돌린다. 요율은 그 체결 때 유효했던 설정 판, 평단은 가격 차이만큼,
  확정 순자산 줄은 장부 상태가 그날 마감일 때만 다시 쓴다 — 금융위 값이 다음 관측치 처리보다 늦으면 그날 줄은 잠정으로 남고, 끝내 확정할 수 없는 체결이 남으면 그 뒤 줄이 확정되지 않는다
  (명세 §4-1 'C3 구현에서 정한 것'·§6).
- 묶음 E 뒤(2026-10-28, E0~E3·리뷰 두 차례 — 이 브랜치 병합 전): 네 계좌 몫이 모두 있어 운영에서는 네 계좌가 함께 출발하고(E2b), 과금되는 Claude 몫은 다른 몫이 모두 계획된 뒤에만
  부르며 그 계획 뒤 쓰기가 실패해도 그 세션을 미뤄(같은 창·재기동 뒤에 다시 부르지 않음) 출발 한 세션의 과금 호출은 1~2회다. 미룸·출발 오류 횟수는 그 세션의 저장된 작업 기록으로 판정한다
  (사용자 결정 v3). `calendar.consensus`를 켜면 미국 패킷 판 6(E1b), 한국 패킷은 늘 판 6. 남은 일은 F(한국 HTTP 경로·화면·QA 스택 출발 점검).
- **G1·G2는 아직 판정하지 않았다**(1분봉 시가·종가 = 금융위, 표본 1). G1이 실패하면 NXT 종목의 잠정 체결가가 통합 시가로 내려가 확정 조정이 커진다(현금은 결국 금융위로 맞음).
  G2가 실패하면 `NEXT_CLOSE`가 없고 잠정 평가는 통합 종가다(최고가는 금융위 `clpr`로만, 스탑은 확정 재판정).
- 잠정 순자산은 하루 뒤 다시 쓰인다 — 화면이 잠정·확정·확정 조정 합계를 보여야 한다(F2). 금융위 자료가 빠진 구간(수집기가 7거래일 넘게 꺼짐)의 체결은 확정되지 않은 채 남는다.
- 한국 스탑은 다음 거래일 시가에 체결돼 갭 손실이 있고, 미국(관측치 즉시)과 스탑 성과를 비교할 수 없다(명세 §6).
- 출발이 Claude 호출 한 번의 성공에 묶여 있어 실패가 이어지면 출발이 계속 밀린다(사유는 작업 기록·화면에).
- Nasdaq은 비공식 엔드포인트라 모양·날짜 어긋남이 예고 없이 바뀔 수 있다(그때 EmptyResult로 직전 값 유지).
- **되돌리기**: 체결 행·확정 조정 행은 추가만이라, 출발 뒤 이 결정들을 바꾸면 그 전 기록은 옛 규칙으로 남는다 — 바꾸려면 한국 책을 초기화해 네 계좌를 다시 출발시킨다.
  K22는 설정 저장으로 끌 수 있지만 그 사이 결정은 v6 판으로 남는다.
