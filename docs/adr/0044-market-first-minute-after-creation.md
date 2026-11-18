# 0044. 장중 시장가(`MARKET`) 기준 시각을 '주문 생성 뒤 처음 시작하는 분'으로: 여섯 계좌의 장중 판단·장중 감시 STOP·밤 대체 장중 STOP, 늦은 주문 가드 ⑤(60초)는 그 밖의 시점에 그대로, 한국 사다리 라벨 재검사, 스위치 없음(배포가 경계), 끈 판 글은 바이트 그대로(알려진 차이), 실제 계좌 스탑 창도 함께 1분 앞당김

- 상태: 채택 (2026-11-18 사용자 결정 — 한국 스탑 체결 알림을 본 뒤 "1분 이내로 매도", 모든 장중 시장가에 적용, 계획 2판 작업 2의 권장안 전부 승인: D1 정각 생성도 다음 분·여유 0,
  D2 끈 판 글 바이트 그대로, D3 판 이름 올리지 않음, D4 실제 토스 계좌 스탑 창도 함께 1분 앞당김, D5 상수 이름, D6 한국 사다리 아래쪽 라벨 재검사, D7 스위치 없음, D8 ADR 0044 + ADR 0018 배포
  경계 절, D14 작업 3과 나눠 배포, D15 화면은 lib 네 곳만). **구현 끝, 배포 전**(브랜치 `claude/paper-fill-timing-2026-11`). 스위치가 없으므로 `main` 병합 → push → CI → `deploy.sh`를 한 창
  (권장 2026-11-21 토 07:00 ~ 11-22 일 20:30 KST, 두 시장이 닫혀 있고 대기 `MARKET`이 0일 때) 안에서 잇달아 한다. 배포 커밋·시각은 배포 뒤 이 줄과 [ADR 0018](0018-paper-trading-guardrails.md)의 절에 적는다.
- 바꾸는 결정:
  - [ADR 0032](0032-paper-intraday-stop-watch.md) 결정 3(감지 시각 G의 주문 T = G + 2분)과 제목·이유·'구현에서 정한 것'의 '감지 + 60초 뒤 첫 분' — T = 감지 뒤 처음 시작하는 분(1분 안).
    0032에는 사용자 원답('감지 다음 분'), 결정 문장('G + 2분'), 구현('60초 뒤 첫 분') 세 정의가 함께 있었다. 이 문서의 정의 하나로 정리한다.
  - [ADR 0022](0022-us-claude-book2-timing.md) 단계 2 구현의 `MARKET` 기준 시각 식(명세 2026-10-30 §16-4 '엄격한 식' — '(생성 + 60초)를 분으로 내린 뒤 + 1분').
  - [ADR 0033](0033-real-isa-open-offset-and-stops.md) 결정 2 덧붙임 — 문장('기준 시각 T부터 T + 3분')은 그대로 맞지만 모의 T가 1분 앞당겨져 실제 계좌 스탑 매도 창이 함께 옮겨 간다(사용자 확인 D4).
- 함께 보는 결정(문장이 그대로 맞아 개정 표지는 달지 않음): [ADR 0027](0027-free-fill-timing.md) 결정 1의 룩어헤드 문장('T가 주문 생성 + 60초보다 뒤')은 분 단위 지정 시각(`AT_MINUTE`) 몫이라
  그대로다(0027은 `MARKET` 식을 정의하지 않음). [ADR 0031](0031-open-offset-window-intraday-budget.md) 결정 1의 'MARKET도 기준 시각이 개장 + 10분 앞이면 받지 않는다'도 그대로다 — 받는 창 경계가
  60초 늦어지는 결과만 아래 '결과'에 적는다. [ADR 0021](0021-kr-paper-prices-fills-start.md)(한국 체결 — 날짜 단 글머리로 가리킴), [ADR 0008](0008-backend-owned-tables-and-scheduled-jobs.md)(수집기는
  `paper_orders`를 읽기만 — 바뀌지 않음).
- 지키는 방법:
  - 식과 두 쪽 대조: `ExecutionAuditTest.marketTargetMatchesTheCollectorTable`(수집기 `MARKET_TARGETS` 7줄 — 정각·+1µs·:30초·−1µs·:59.999초·서머타임·13:10:42 KST)·
    `marketTargetIsTheFirstMinuteAfterCreation`(무작위 생성 시각에서 생성 < T ≤ 생성 + 60초)·`afterCreatedIsZeroOnlyForMarket`·`marketAfterCreatedMatchesTheCollector`(수집기 두 상수와 Java 상수가 모두 0),
    수집기 `test_paper_bars.py`(`MARKET_TARGETS`·`test_장중_시장가의_기준_시각은_생성_뒤_처음_시작하는_분`·이름 대조 `timedelta(0)`)·`test_kr_paper_timed.py`(`KR_MARKET_KEYS`·
    `test_장중_시장가_기준_분과_R1_라벨은_백엔드와_같은_표`·`test_장중_시장가의_기준_분은_생성을_분으로_내린_뒤_1분_뒤`), `KrTimedLadderTest.marketKeyMatchesTheCollectorTable`·`barLabelMatchesTheCollector`.
  - 미리 보기 금지(체결가는 생성 뒤 거래로만): `UsTimedFillsTest.marketNeverFillsBeforeTargetOrCreation`·`marketTargetIsTheFirstMinuteAfterCreation`(정각 생성의 생성 분 봉은 쓰지 않음),
    `KrTimedLadderTest.marketNeverFillsWithABarStartingBeforeCreation`(무작위 + 라벨 T·T+6 봉을 넣은 틀린 저장본은 재검사로 체결하지 않음), `PaperLedgerDbTest.timedFillsOnRealTables`(실제 표, 생성 분 봉이 있는 픽스처).
  - 가드 분리: `UsTimedFillsTest.marketWithinSixtySecondsIsNotLate`(T − 생성 60초·1µs인 MARKET은 체결, 같은 생성 시각의 AT_MINUTE은 LATE_FOR_TIMING)·`lateForTimingAtExactlySixtySeconds`(메뉴 가드 그대로).
  - 생성 시각 정밀도(결정 5): `PaperStopWatchJobTest.stopCreatedAtIsTruncatedToMicros`·`StopWatchFallbackTest$Kr.lateMarketFallbackCreatedAtIsTruncatedToMicros`(분 경계 직전 ns 시계 —
    생성 시각이 µs로 잘리고, pgjdbc 반올림을 흉내 낸 `PaperFixtures.dbRounded` 값으로 다시 센 T가 근거의 시각과 같음).
  - 갈래·받는 창·순위: `StopWatchTest$Targets`(`us`·`kr`·`atMinuteBranchAlwaysPassesTheLateGuard`), `FreeTimingTest.intradayMarketHasTheOpenOffsetFloor`·`intradayTableStartsAtTheMarketMinute`·
    `marketRanksBeforeTheFirstMinute`, `UsTimedFillsTest.earlyCloseMarketAfter1255Rejected`, `CheckpointPacketTest.remainingTimingsDropPassedAndEarlyClose`·`freeRemainingOptions`·
    `freeMinutesFirstIsAcceptedByTheValidator`, `KrIntradayPacketTest.remainingTimings`·`freeMinutesFirstIsAcceptedByTheValidator`.
  - 예상 장부·알림: `ExpectedStateTest.pendingMarketPricedFromItsNewTarget`, `PaperNotifyJobTest.qa312WatchStopTimingIsSameSession`, `StopWatchFallbackTest$Kr.lateMarketFallbackCountsFromTheProcessingTime`.
  - 실제 계좌·ISA: `PaperMirrorServiceTest.marketStopMirrorAtIsTheFirstMinuteAfterCreation`·`dueOrdersWindowAndRoots`·`ladderPrices`, `RealTradePlannerTest.stopWindow`·`stopWindowNearTheCloseIsThirtySeconds`.
    **고치지 않고 통과해야 하는 경계 시험**: 수집기 `test_toss_trade.py`, `ArchitectureRulesTest.realtradeIsIsolated`, 화면 `isaBoundary.test.ts`·`realtradeBoundary.test.ts`.
  - 글: 켠 판 고정본 12개와 한국 켠 판 장중 판단 고정본(`packet-kr-ft-intraday-stopwatch.json` — `KrStartTest.goldenKrFreeIntradayPacketWithStopWatch`), '문장만 바뀜' 시험
    `CheckpointPacketTest.onlyTheMarketSentenceChangedForFirstMinute`·`onlyTheEstimateNoteChangedForCosts`, `FreeTimingDecisionTest.onlyTheMarketSentenceChanged`,
    `PacketBuilderTest.onlyTheStopTimingSentenceChanged`, `KrPacketBuilderTest.onlyTheStopTimingSentenceChanged`, `KrStartTest.onlyTheMarketAndStopSentencesChangedInTheKrIntradayPacket`
    (새 글을 옛 글로 되돌리면 바꾸기 전 고정본의 sha256과 같음), 끈 판 고정본 4개(`render-us-claude2-c2-v0-default.txt`·`render-kr-claude2-v0-default.txt`·`packet-us-claude2-checkpoint-minute.json`·
    `packet-us-claude2-checkpoint-hourly.json`)는 바이트 그대로, 화면 `marketTimingText.test.ts`(옛 정의 글이 허용 목록 밖에서 나오지 않음).

## 배경
사용자가 한국 봇의 '모의매매 체결' 알림이 장 마감 뒤에 오는 것을 보고 스탑 매도가 종가로 처리되는지 물었다. 스탑은 장중 가격으로 체결되지만, 체결 기준 시각 T가
'(생성 + 60초)를 분으로 내린 뒤 + 1분'이라 감지 뒤 60~120초 뒤의 1분봉이었다(2026-11-17 한국 Claude 계좌2 NAVER — 13:10:42 감지, 13:12 가격). 한국 장중 감시 스탑 18건 가운데 11건이
개장 직후 갭 하락(09:05·09:10 두 번 확인, 09:12 체결)이었다. 사용자는 판정 규칙(5분 감시·두 번 연속·개장 10분 전에는 팔지 않음·스탑 비율·재진입 금지)은 그대로 두고 체결 시점만
'주문 생성 뒤 처음 시작하는 분'(1분 이내)으로 바꾸기로 했고, 스탑만이 아니라 여섯 계좌의 모든 장중 시장가 주문에 같은 식을 쓰기로 했다.

60초 여유는 원래 늦은 주문 가드 ⑤('T > 생성 + 60초 — 봉 라벨이 시작이든 끝이든 생성 뒤에 시작한 봉')를 장중 시장가에도 그대로 지키려고 둔 것이다. 한 상수
(`ExecutionAudit.AFTER_CREATED`)가 시장가의 T 계산과 메뉴·지정 시각·종가의 가드를 함께 맡고 있어, 식만 바꾸면 미국 장부·실행 감사·예상 장부가 모든 MARKET을 늦은 주문으로 취소하게 된다.

## 결정
1. **정의**: 장중 시장가의 기준 시각 T(c) = 생성 시각 c를 분 단위로 내린 값 + 1분. 곧 c보다 **엄격히 뒤**인 첫 분 경계이고 c < T ≤ c + 60초다. 정각 생성(13:10:00.000)도
   다음 분(13:11)이다(D1 — '분으로 올림'은 T = c가 되어 한국 장부 ⑤ `KrFills.opensAfterOrder`의 T > 생성에 걸리고, ⑤를 보지 않는 실제 계좌 `dueOrders`는 팔아 실제·모의가 어긋남).
   시계 여유 ε는 0이다(ε = 1초면 매분 마지막 1초 안의 생성이 '1분 이내'를 어김). 대상은 미국·한국 규칙·Claude 계좌1·Claude 계좌2의 Claude 장중 판단·장중 확인 MARKET, 장중 감시 STOP,
   밤 대체 STOP 가운데 장중 시장가로 내는 것이다.
2. **상수 분리**(D5): `ExecutionAudit.AFTER_CREATED`(60초)는 이름 그대로 늦은 주문 가드 ⑤에만 남긴다(메뉴·`AT_*`·`AT_MINUTE`·종가·`RuleTiming`·밤 대체 첫 분). 새 `MARKET_AFTER_CREATED = 0`이
   T를 정하고(수집기 `paper_bars.MARKET_AFTER_CREATED`·`kr_paper_timed.KR_MARKET_DELAY`와 같은 값), `afterCreated(timing)`(MARKET이면 0, 그 밖 60초)가 가드와 T가 섞인 세 자리
   (`ExecutionAudit.fromBars`, `UsTimedFills.look`·`recheck`)를 맡는다. 장중 판단 패킷의 '지정 시각으로 고를 수 있는 첫 분'은 `earliestTimed(now)`(옛 식 — 지금 + 60초보다 뒤인 첫 분)로
   두어 검증기의 가드와 어긋나지 않는다. `KrTimedLadder.LATE_MARGIN`은 `AFTER_CREATED` 참조로 모은다(같은 60초).
3. **시장별 봉과 미리 보기 금지**: 미국(Yahoo, 봉 시작 라벨)은 시작 = T인 봉, 한국(토스, 봉 끝 라벨)은 라벨 T + 1분 봉이라 두 시장 모두 고르는 봉의 구간이 [T, T + 1분)이고 T > c다.
   13:10:42 생성은 T 13:11, 한국 장부가 읽는 봉은 라벨 13:12(13:11~13:12)다. 미국 장부 재검사(`UsTimedFills.recheck`)는 floor = max(T, 생성 + 여유)로 그대로 보고,
   **한국 1분봉 사다리에 아래쪽 라벨 재검사를 더한다**(D6 — `KrTimedLadder.recheck`: 창 봉은 라벨 T+1 ~ T+5, 창 뒤 첫 거래 봉은 라벨 ≥ T+1이어야 체결, 어기면 체결하지 않고 기다림 — 미국과 다른 처리는 아래 '결과와 남은 위험').
   여유가 (0, 60초]로 줄어 라벨 해석 하나가 불변식을 직접 떠받치기 때문이다. 수집기 `summarize_windows`의 'T → 라벨 T+1~T+5' 매핑은 그대로다.
4. **감시 STOP 갈래는 유지**: T가 그 세션 첫 분(개장 + 10분) 앞이면 첫 분 `AT_MINUTE`, 장 끝 여유 안(미국 15:55·한국 15:20부터)이면 그날 `NEXT_CLOSE`, 그 밖은 `MARKET`. 조건을 T로 적으므로
   경계만 옮겨 간다(감지 < 첫 분 − 1분이면 첫 분, 감지 ≥ 장 끝 − 1분이면 종가). 첫 분 갈래의 첫 분은 늘 감지 + 60초보다 뒤라 가드 ⑤를 통과한다.
5. **생성 시각 정밀도**: 감시 STOP(`PaperStopWatchJob`)과 밤 대체 STOP(`PaperLedgerService.detectStops`)의 생성·감지 시각을 µs로 잘라 T 계산과 `created_at`에 같이 쓴다. DB는 µs까지만 담고
   pgjdbc 42.7.14(`TimestampUtils.toString(Calendar, Timestamp, boolean)` — 바이트코드로 확인)는 µs 아래를 반올림하므로(500ns 이상 올림, 999,999,500ns 이상이면 다음 초), 자르지 않으면 분 경계 직전
   (:59.9999995초 이후) 생성이 다음 분으로 저장되어 근거의 `targetAt`과 장부가 다시 센 T가 1분 갈린다.
6. **스위치 없음**(D7): T는 체결 때 생성 시각에서 다시 세므로 스위치도 배포와 같은 시각 조건이 필요하고, STOP에는 설정 판이 남지 않는다. 배포 시각이 실험 조건 경계다(ADR 0018 절).
   그래서 `main` 병합을 배포 창에 묶는다 — `deploy.sh`는 `origin/main` 전체를 받으므로 `main`에 들어간 것은 누가 하든 다음 배포에 실린다.
7. **AI 입력 글**: 켠 판 시스템 프롬프트(미국·한국 장중 판단 절)·장중 판단 패킷의 MARKET 문장과 감시 ON 스탑 문장(`StopWatch.rule` — 결정 패킷 `12_hardRules`·`1_basis.stopWatch.rule`,
   장중 판단 패킷 `1_basis.stopWatch.rule`)을 새 정의로 고친다. 판 이름 `ft-2`·`kr-ft-2`는 올리지 않는다(D3 — ADR 0030·0031·0038 선례, 판은 메뉴를 바꿀 때만 올림, 경계는 ADR 0018 절이 끊음).
   **자유 시점 끈 판의 MARKET 글**(미국 계좌2 c2 장중 확인·한국 계좌2 장중 확인 — `ClaudePrompts`의 두 장중 확인 절, `CheckpointPacket` 끈 판 하드 규칙)은 바이트 그대로 두고 체결 시점만 새 식을
   따른다(D2 (가) — 알려진 차이, 그 자리에 주석). 끈 판 하드 규칙 줄의 받는 조건 문장('기준 시각이 지금 + 60초보다 뒤인 것(1_basis.remainingTimings)만 받는다')도 MARKET에는 맞지 않게 된다 —
   새 T는 지금 + 60초 이하인데 MARKET은 `remainingTimings`에 실리고 검증을 통과한다. 지금 네 Claude 계좌가 모두 자유 시점 켠 판이라 끈 판 글은 쓰이지 않는다(배포 직전 설정 확인 Q0).
8. **실제 토스 계좌·ISA**(D4): 실제 계좌 스탑 매도 창 [max(T, 장중 시작, 개장 + 10분), min(시작 + 3분, 장중 끝)]의 T가 모의 T라(`PaperMirrorService.mirrorAt` → `KrTimedLadder.targetOn`) 함께
   1분 앞당겨진다. 창 길이·쓰기 경로(수집기 `toss_trade.py`의 주문 경로)·한도는 그대로이고 realtrade 코드는 바꾸지 않는다. ISA 스탑 지시 로직은 T를 쓰지 않으므로(30초 주기 `dueOrders(now + 5분)`)
   그대로이고, `manual_stop_instructions.target_at`에 남는 값과 그 값을 보이는 화면 칸이 1분 이르다. 15:18:xx 감지는 모의 STOP 시점이 종가(`NEXT_CLOSE`)에서 15:19 장중 시장가(`MARKET`)로 바뀌므로
   ISA 지시 글도 '종가 단일가(15:20~15:30)에 시장가로 매도'에서 '지금 시장가로 매도'로 바뀐다(`ManualAccountNotices.stop`이 시점으로 글을 고름 — 실제 계좌 쪽 15:18 문장과 짝, 아래 '결과').
9. **화면**(D15 (나′)): lib 네 곳(미국·한국 스탑 설명, MARKET 시점 주석 둘)만 고치고 `HoldingsSection.tsx`의 한 줄은 작업대 P6이 그 둘레를 재배치하는 중이라 P6이 `main`에 합쳐진 뒤 한 줄 후속으로 고친다.
   그동안 옛 정의 글이 그 한 줄에 남는 것은 알려진 차이다. `marketTimingText.test.ts`가 그 한 파일 1회만 허용해 옛 글이 다른 곳에서 되살아나지 않게 지킨다.
10. **배포**(D14): 작업 3(한국 스탑 체결의 장중 기록)과 나눠, 두 시장이 모두 닫혀 있고 대기 `MARKET`이 0인 주말 창에 낸다. `deploy.sh`의 실제 매매 가드(평일 08:45~15:35 KST)를 지키고
    `REALTRADE_DEPLOY_OK=1`은 쓰지 않는다. 배포 직전 설정(Q0)·대기 MARKET(Q1 = 0)·남은 장중 판단 계획·장부 따라잡음·다른 DB 연결·끝난 실행·실행 감사 빈칸(Q5)과 서버 시계(`NTPSynchronized=yes`)를 본다.

## 이유
- 사용자 표현 '1분 이내로 매도'를 그대로 식으로 옮기면 c < T ≤ c + 60초다. 늦은 주문 가드의 본래 목적(생성 뒤 거래로만 체결)은 봉 구간이 [T, T + 1분)이고 T > c인 것으로 이미 지켜진다.
  60초 여유는 라벨 해석이 틀릴 때를 막는 겹 안전이었고, 그 몫은 미국 재검사와 새 한국 재검사가 맡는다.
- 상수를 나누지 않고 식만 바꾸면 미국 장부·실행 감사·예상 장부가 MARKET을 모두 늦은 주문으로 취소한다. 섞인 자리 다섯만 고치면 나머지 호출부(`StopWatch.target`·`FreeTiming`·
  `KrTimedLadder`·`PaperNotifications`·`PaperMirrorService` 등)는 `marketTarget`을 따라 바뀐다.
- 실제 계좌 스탑 창을 따로 두면 `mirrorAt`에 옛 식을 남겨야 하고, 같은 STOP의 실제 창이 모의 T보다 1분 늦게 열려 실제·모의 체결 분이 어긋난다.

## 대안과 버린 이유
- **'분으로 올림'(정각 생성이면 T = 생성)**: 한국 장부 ⑤에 걸려 모의는 체결하지 않는데 실제 계좌는 판다.
- **여유 ε = 1초**: 매분 마지막 1초 안의 생성은 T − c가 60초를 넘어 '1분 이내'를 어긴다. 서버 시계는 배포 직전 확인으로 대신한다.
- **`AFTER_CREATED`를 `LATE_GUARD`로 이름 바꾸기**: 참조 약 10곳과 시험이 바뀌는데 동작상 이득이 없다.
- **끈 판 주문만 옛 식**: 주문별 표시와 수집기 변경이 필요하다. **끈 판 고정본도 고침**: CLAUDE.md의 끈 판 바이트 규칙의 예외라 명시 승인이 필요한데, 쓰이지 않는 판이라 이득이 없다.
- **스위치를 둠**: 저장도 배포와 같은 시각 조건(대기 MARKET 0)이 필요하고, STOP에는 설정 판이 남지 않아 경계를 끊지 못한다.
- **판 이름을 올림**: 고정본 5개·`packet-us-ft-meta.txt`·`BEFORE_COSTS_SHA256` ft 줄이 더 바뀌고, `ft3`(이어받기 스키마 파일 이름)과 헷갈린다.

## 결과와 남은 위험
- **받는 창 경계가 60초 늦어진다**(검증 시각 now 기준 — 검증 규칙의 경계): 미국 켠 판 MARKET [09:39, 15:54) ET(옛 [09:38, 15:53)), 조기 폐장일 상한 12:54(첫 해당일 2026-11-27), 한국 켠 판 MARKET
  [09:09, 15:19) KST(옛 [09:08, 15:18)). 장중 판단은 개장 + 10분 ~ 마감 − 30분(한국은 종가 단일가 시작 − 30분, `IntradayRequest.window`)에 계획되고 계획 시각 + 2~20분에 부르므로
  (`PaperCheckpointJob.WINDOW_START`·`WINDOW_END`) 하한에는 닿지 않는다. 상한에는 마지막 계획(미국 15:30·조기 폐장일 12:30 ET, 한국 14:50 KST)의 호출이 호출 창 끝(+ 20분)에서 시작해 검증까지
  미국 약 4분·한국 약 9분 넘게 걸릴 때만 닿는다(옛 식은 3분·8분). 장 시간 변경일(수능 10:00 개장)은 같은 폭으로 옮겨 간다. `AT_MINUTE`으로 고를 수 있는 첫 분은 바뀌지 않는다.
- **검증 순위**: 같은 응답에서 MARKET(순위 0)이 첫 `AT_MINUTE`(순위 1)보다 앞선다. 그래서 첫 분 `AT_MINUTE` 매도가 MARKET 매수의 현금을 대지 못한다(옛 식에서는 같은 순위라 댈 수 있었다).
  켠 판 하드 규칙 'MARKET < AT_MINUTE(이른 순)'과는 더 잘 맞는다. 끈 판에서는 메뉴 `AT_hh00`과 MARKET이 같은 순위였다가 갈릴 수 있다(끈 판을 쓰지 않는 동안 영향 없음).
- **`REPLACE`가 취소할 수 있는 대기 MARKET**은 새 T가 지나기 전까지로 1분 줄어든다(생성 뒤 T까지가 1분 이하라 실제 영향은 거의 없음 — 추정).
- **AI 입력 값**: 장중 판단·확인 패킷 대기 표의 대기 MARKET·감시 STOP 기준 시각과 상태(`due`/`ahead`)가 1분 앞당겨지고, 예상 장부 `assumedFills`가 그 주문을 체결로 보는 시점과 가격 봉도 바뀐다
  (이번 고정본에는 대기 MARKET이 없어 바이트로 드러나지 않음).
- **실제 계좌 창이 쓸 수 있는 길이**: 옛 식은 T − 감지가 60~120초라 STOP이 창 시작 전에 보였지만, 새 식은 µs~60초라 감시 트랜잭션이 커밋되기 전에 T가 지날 수 있다. 시각 맞추기 날(09:10 `SYNC_AT`)에는
  실제 매매 주기가 묶음 전송을 마친 뒤에야 다음 목록을 읽으므로, 09:10 격자 STOP이 쓸 수 있는 창이 옛 식보다 최대 1분 짧을 수 있다(묶음 전송 시간은 운영 측정이 없음 — 모름). 첫 재선정일(12-08)이나
  시각 맞추기 묶음이 큰 날의 09:10 격자 스탑을 배포 뒤 확인 항목으로 둔다. 실제 매매가 `runMirror` 직전에 다시 읽게 고치는 것은 realtrade 코드 변경이라 이번 범위 밖이다(ADR 0033 덧붙임·사용자 승인 필요).
  15:18:xx 감지는 이제 종가 대신 15:19 장중 시장가가 되고, 실제 창은 [15:19:00, 15:19:30]으로 30초뿐이다(감시 격자로는 15:15 격자 처리가 약 3분 늦은 경우에만 생김). ISA에서는 같은 경우가
  '종가 단일가 안내' 대신 '지금 시장가로 매도'가 된다. 실제 계좌가 Claude 계좌를 따르도록 바뀌면 Claude 장중 시장가 따라 하기 창과 시각 맞추기 흡수 경계도 1분 옮겨 간다(지금 따라 하는 책은 규칙 계좌).
  그때는 시각 맞추기 시각(syncAt) 직전 1분 안에 생성되어 묶음 목표 읽기(`paper.targetsAt(syncAt)` — 커밋된 대기 주문만) 뒤에 커밋된 비STOP 장중 시장가가 그날 흡수도 따라 하기도 되지 않는다
  (`RealTradeJob`은 T ≤ syncAt인 비STOP 주문을 흡수 여부와 상관없이 따라 하지 않음 — 다음 날 맞추기가 메움). 옛 식은 커밋이 60초 넘게 늦어야 생겼고, 새 식은 syncAt 직전 생성분의 커밋이 묶음 읽기와
  겹치기만 해도 생긴다. 지금 일정으로는 그런 생성이 없다(Claude 계좌의 syncAt은 그 세션 첫 분이고 장중 판단 호출은 계획 시각(개장 + 10분 이후) + 2분 뒤부터) — 코드는 고치지 않는다.
- **서버 시계**: 서버 시계가 거래소보다 δ만큼 늦으면 T − c < δ인 주문(비율 약 δ/60초)의 T 봉에 생성 앞 최대 δ초의 거래가 섞인다. 저장소에는 NTP 측정이 없어 배포 직전 `timedatectl`로 본다.
- **라벨 해석 의존**: 미국 재검사와 한국 재검사는 같은 라벨 가정(미국 봉 시작, 한국 봉 끝) 위에서 센다. 근거는 미국 X1 측정(`docs/DATA_SOURCES.md` '봉 라벨')과 한국 토스 응답 확인이다.
  배포 뒤 첫 세션에 한국 개장 봉(라벨 09:01)의 시가가 그날 시가와 같은지 저장본으로 한 번 본다.
- **재검사가 어긋날 때 두 시장의 처리가 다르다**(알려진 차이): 미국(`UsTimedFills.recheck`)은 체결하지 않고 운영 알림('장부 재검사 오류 — 체결하지 않음')을 남긴 뒤 마무리에서 `RECHECK_FAILED`로
  만료시킨다. 한국(`KrTimedLadder.recheck`)은 체결하지 않고 기다림으로 남아 작업 기록에 사유만 쓰고(운영 알림 없음), '그날 체결할 수 없음' 표시(`unfillable`)를 하지 않으므로 결정 게이트 ①이
  그 계좌의 밤 결정을 그 주문이 만료로 닫힐 때까지 막는다(1분봉 `FAILED`로 기다리는 주문과 같은 처리). 한국 재검사는 수집기 저장본의 라벨이 틀릴 때만 걸리는 방어 경로라 지금 빈도는 0에
  가깝다(추정). 한국도 운영 알림·만료로 바꾸는 것은 장부·게이트 동작 변경이라 따로 정한다.
- **검증 시각과 생성 시각의 ms 차이**: Claude 주문의 `created_at`(트랜잭션 시작)과 검증 now 사이 몇 ms가 분 경계를 넘으면 검증기가 본 T와 장부가 다시 센 T가 1분 다르다. 옛 식에도 같은 꼴로
  있던 경계이고, 장중 판단은 개장 + 10분 ~ 마감 − 30분 창에서만 돌아 하한 쪽은 지금 사실상 생기지 않는다(코드는 고치지 않음).
- **배포 뒤 수집기 따라잡기**: 배포로 수집기가 다시 뜨면 미국 1분봉 첫 회차가 `5d`로 따라잡아 최근 8일 MARKET 주문의 창 키를 새 T로 다시 만들고, 한국 실행 감사 몫이 새 키로 칸을 다시 받는다
  (토스 호출이 칸마다 최대 3쪽 늚 — 토스가 8일 전 세션을 주지 않으면 그 주문이 8일 창을 벗어날 때까지 slow 회차마다 되풀이할 수 있음, 모름). 이미 쓴 실행 감사 `target_at`·`late_resolved`는
  `COALESCE`로 처음 값이 남고 비어 있던 칸만 새 식으로 채워진다(그 수 Q5를 ADR 0018 절에 적음). 장부·현금·체결가에는 영향이 없다.
- **프롬프트 캐시**: 켠 판 시스템 프롬프트 문단이 바뀌어 배포 뒤 계좌마다 첫 호출에서 프롬프트 캐시가 한 번 다시 쓰인다(추정 — 비용이 한 번 더 듦).
- **알려진 차이**: 끈 판 MARKET 글(결정 7 — 체결 문장과 하드 규칙의 받는 조건 문장)과 보유 화면 한 줄(결정 9)이 옛 정의로 남는다. 자유 시점 끈 판 + 감시 ON 조합의 결정 패킷 고정본은 없다(지금 쓰이지 않음).
- **되돌리기**: 스키마 변경이 없어 코드 되돌림(`git revert` → `main` → `deploy.sh`)만으로 된다. 되돌리는 배포도 같은 시각 조건(주말 창·대기 MARKET 0)에서 한다 — 아니면 새 식으로 만든 대기 주문이
  옛 T로 다시 계산된다. 체결 행은 더하기만이고 실행 감사 `target_at`은 처음 값을 지켜 데이터 정리가 필요 없다. 되돌린 뒤에도 수집기 따라잡기와 한국 감사 몫 다시 받기가 옛 T 키로 일어나며,
  되돌림도 ADR 0018에 경계로 적는다. 배포 전 덤프 복원은 그 뒤 장부까지 되돌리므로 데이터를 망가뜨린 경우에만 쓴다.
