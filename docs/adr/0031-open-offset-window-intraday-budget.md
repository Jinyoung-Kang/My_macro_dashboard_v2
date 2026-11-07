# 0031. ADR 0027 개정: 모든 계좌의 장중 체결 창을 정규장 개장 10분 뒤 ~ 마감 전으로, 켠 판 결정 메뉴에서 시가(`NEXT_OPEN`)를 빼고 종가는 남김, 규칙 계좌는 개장 10분 뒤 고정, 장중 판단은 세션당 1~3회(보장·사건), 호출 예산 70·30·5, 장중 판단만 effort medium

- 상태: 채택 (2026-11-06 밤 사용자 요청과 결정 — "모든 계좌의 체결을 정규장 개장 10분 뒤 ~ 마감 전 자유 시점으로", 질문 답 "종가 단일가는 남기고 시가 단일가는 뺌 ·
  규칙 계좌는 개장 10분 뒤 고정(미국 09:40 ET, 한국 09:10) · 결정·복기는 high, 장중 판단만 medium · Haiku는 쓰지 않음 · 장중 판단 최소 1~최대 3회 · 호출 상한 70", 계획 승인).
  **구현 끝, 배포 전**(브랜치 `claude/intraday-timing-2026-11`, 2026-11-07 — 공용 상수·설정 키·V27 `f6e0b7b0`~`3c2ec1ec`, 체결 창·규칙 계좌·장중 판단 창 `b918c1e0`~`7b2c4605`,
  장중 판단 실행·보장·effort `b1863373`~`78c5179f`, 패킷·사건 `877eb151`·`10e18675`). 배포는 2026-11-08 23:30 KST 예정이고, 배포 커밋과 저장한 설정 판은 배포 뒤 이 줄에 적습니다.
  배포만으로 바뀌는 것은 결정 1·2와 결정 4의 창·간격이고(켠 판 결정과 장중 판단부터), 결정 3·5·6과 결정 4의 횟수·보장·사건은 설정을 저장해야 바뀝니다(결정 7).
- 바꾸는 결정: [ADR 0027](0027-free-fill-timing.md) 결정 1(지정 시각 범위 개장 + 1분 → 개장 + 10분), 결정 2(켠 판 메뉴의 시가), 결정 3(장중 판단 최대 2회·간격 30분·창 개장 + 5분),
  결정 4(스키마 — V27로 더함), 결정 5(규칙 계좌 체결 시각 — 기본값은 그대로 두고 배포 뒤 설정으로 개장 + 10분), 결정 9(호출 예산 60·20). 나머지 0027 결정(스위치는 계좌별·끄면 바이트까지 같음·
  검증은 결정마다 만든 표·정규장만)은 그대로다.
- 함께 보는 결정: [ADR 0032](0032-paper-intraday-stop-watch.md)(모의 장중 스탑 감시 — 사건 판정의 자료), [ADR 0033](0033-real-isa-open-offset-and-stops.md)(실제 토스 계좌·ISA가 같은 창을 따름),
  [ADR 0018](0018-paper-trading-guardrails.md)(실험 조건 경계 기록). 숫자·단계는 [명세](../specs/2026-11-05-free-fill-timing.md) §17.
- 지키는 방법:
  - 창·메뉴(결정 1·2): `SessionWindowsTest`(상수·보통 날·조기 폐장·장 시간 변경일), `FreeTimingTest`(범위·`intradayMarketHasTheOpenOffsetFloor`), `DecisionTimingsLockTest`(스키마·프로필·고정 문단의 시점 목록,
    프롬프트의 '09:40~15:30 ET'·'09:10~14:50 KST'·'20분 이상'·보장 시각·지수 종목을 상수와 대조), 켠 판 고정본(`render-*-ft-*`·`packet-*-ft-*`·`decision-schema-forapi-us-ft.json`)과
    **끈 판 고정본이 바이트 그대로인 것**(같은 시험들이 함께 대조), 전환 회귀 `UsTimedFillsTest.ordersMadeUnderTheOldWindowFillAsMade`·`KrLedgerTest.ordersMadeUnderTheOldWindowFillAsMade`.
  - 규칙 계좌(결정 3): `RuleTimingTest`(`movesToTheFirstMinuteOnShiftedKrDays` 포함), `KrLedgerTest.unfilledRuleOrderIsReissuedAtTheNextFirstMinute`, `PaperSettingsServiceTest`(범위 글 09:40~15:54 ET·09:10~15:19 KST).
  - 장중 판단(결정 4): `IntradayRequestTest`(창·간격·횟수), `PaperStoreDbTest`(`v27IntradayThreeAndOrigin`·`v27BackfillsOriginOnce`·`readyRequiresV27`·`rollbackClosesSlotThreePlans`),
    `IntradayKindsLockTest`·화면 `intradayKinds.test.ts`(종류를 글자로 박은 곳 없음), `PaperIntradayJobTest`(`claude2CycleCapCountsTheThirdJudgment`·`packetCarriesTheCallReason`·`guaranteesOneJudgmentByMidSession`·
    `guaranteeSkipsWhatTheCallWouldRefuse`·`eventsAddAJudgment`), `KrStartTest.krGuaranteesOneJudgmentByMidSession`·`krEventsAddAJudgment`, `IntradaySchedulerTest`(보장 시각·한 번·놓친 뒤 다시·조건),
    `IntradayEventsTest`(문턱·자료 조건·당김·붙임·덧붙임·버림·한국), `CheckpointPacketTest.goldenFreeEventMinute`(고정본 `packet-us-ft-intraday-minute-event.json`), `PaperExecutionViewTest.thirdIntradayJudgmentOrdersLeaveMenuRows`,
    화면 `paperIntraday.test.ts`.
  - effort·설정(결정 6·7): `PaperIntradayJobTest.intradayJudgmentsUseTheIntradayEffort`, `PaperSettingsServiceTest.stopWatchAndIntradayPolicyKeys`(기본은 지금 동작).

## 배경
ADR 0027은 네 Claude 계좌가 정규장 안의 분 단위 시각(`AT_MINUTE`, 개장 + 1분부터)과 시가·종가를 고르게 했고, 규칙 계좌는 기본 시점(미국 다음 시간별 관측치, 한국 다음 거래일 시가)으로
두었다. 개장 직후 몇 분은 호가가 얇고 Yahoo 1분봉 첫 봉 시가가 일봉 시가와 다른 날이 많다(86칸 중 50칸만 같음 — DATA_SOURCES). 사용자는 모든 계좌의 장중 체결을 개장 10분 뒤부터로 맞추고,
장중 판단을 더 능동적으로(최소 1회, 사건이 나면 앞당김) 쓰기로 했다.

## 결정
1. **장중 체결 창은 정규장 개장 10분 뒤 ~ 마감 전이다.** 미국 지정 시각은 보통 날 09:40~15:54 ET(마감 5분 전 앞까지), 한국은 09:10~15:19 KST(종가 단일가 앞까지)다. 조기 폐장·장 시간 변경일은
   그날 개장·마감에서 같은 간격이다(수능일 10:00~16:30이면 10:10~16:19). 간격 값은 `analytics.SessionWindows.OPEN_OFFSET` 하나에 두고, 모의·실제 매매·스탑 감시가 같은 값을 읽는다.
   켠 판의 장중 시장가(`MARKET`)도 기준 시각이 개장 + 10분 앞이면 받지 않는다.
2. **켠 판 결정 메뉴에서 시가(`NEXT_OPEN`)를 빼고 종가(`NEXT_CLOSE`)는 남긴다.** 결정이 받는 시점은 `AT_MINUTE`·`NEXT_CLOSE` 둘이다. 판은 `ft-2`·`kr-ft-2`, 메뉴 판 4다.
   끈 판의 프롬프트·스키마·패킷·고정본은 바이트까지 그대로다.
3. **규칙 계좌는 개장 10분 뒤에 체결한다.** 배포 뒤 설정 `rules.timing=AT_MINUTE`·`rules.timingAtEt=09:40`, `kr.rules.timing=AT_MINUTE`·`kr.rules.timingAtKst=09:10`을 저장한다(코드 기본값은 그대로).
   개장이 늦춰진 날은 그날 첫 분(수능일 10:10)으로 옮긴다. 한국 규칙 주문의 대체 시점과 그날 체결되지 못한 주문의 다시 내기도 시가가 아니라 다음 세션 첫 분의 `AT_MINUTE`이다.
   미국 다시 내기(다음 시간별 관측치)는 그대로 둔다 — 수집기 slow 군을 매시 :15에 고정하면 첫 장중 관측치가 10:15 ET다.
4. **장중 판단은 세션당 최소 1회 ~ 최대 3회다.** 창은 개장 + 10분 ~ 마감 − 30분(한국 끝은 종가 단일가 15:20 − 30분 = 14:50), 간격은 20분이다. 켠 판 응답 스키마의 예약 상한은 3이다.
   - 보장: 세션 중간(개장 기준 — 미국 + 180분 = 보통 날 12:30 ET, 한국 + 150분 = 11:30 KST)까지 예약이 없으면 코드가 1회를 만든다. 정기 몫으로 세고, 같은 세션에 두 번 만들지 않는다.
   - 사건(단순판): 보유 종목 전일 대비 ±4%, 지수(SPY·069500) ±1.5%, 트레일링 스탑 2% 안. 가장 이른 예약을 그 시각으로 당기고, 예약이 없으면 최대 횟수 안에서 하나 덧붙이고, 그 밖은
     남기지 않는다(기록만). 사건 하나에 한 번이다. 자료는 ADR 0032의 5분 감시 저장본이고, 자료가 없거나 묵으면 사건을 만들지 않는다.
   - 패킷에 호출 이유(예약·다음 예약·운영자·보장·사건과 사건 내용)와 남은 횟수를 싣는다.
   - 스키마는 더하기만이다(V27 — 결정 종류 `INTRADAY_3`, 순번 1~3, 계획 행의 `origin`·`trigger` 칸).
5. **호출 예산은 하루 상한 70·정기 작업 몫 예약 30·계좌2 소상한 5다**(결정 1 + 재시도 1 + 장중 판단 3). 정기 호출의 하루(KST) 최악은 EST 22회·EDT 26회로 예약 30 안이다
   (한국 결정 2 + 재시도 2 + 장중 판단 6, 미국 결정 2 + 재시도 2, 미국 장중 판단은 자정을 걸친 두 세션 몫 — EST 8·EDT 12).
6. **effort는 호출 종류별이다.** 결정·재시도·주간 복기·프레임 제안은 `effort`(high), 장중 판단만 새 키 `intradayEffort`(medium)로 부른다. 키가 없으면 `effort`를 따른다. 모델은 그대로이고 Haiku는 쓰지 않는다
   (Claude 호출은 결정·장중 판단, 주간 복기, 프레임 제안 셋뿐이라 가벼운 작업이 없다).
7. **설정 키는 배포만으로 동작을 바꾸지 않는다.** 새 키 `intradayMinPerSession`·`kr.intradayMinPerSession`(0~1, 기본 0), `intradayEvents`·`kr.intradayEvents`(기본 꺼짐), `intradayEffort`(없음 = `effort`),
   `intradayMaxPerSession`·`kr.intradayMaxPerSession`의 범위는 0~3(키가 없으면 2 그대로). 켜는 저장은 시장별로 따로, 그때 사용자에게 다시 확인받는다(ADR 0027 결정 12).
8. **적용 시점**: 배포는 2026-11-08 23:30 KST. 11-09 세션 주문은 배포 전 결정이 낸 옛 시점대로 체결된다. 새 체결 창은 11-10 세션부터, 장중 판단 변경은 11-09부터다.

## 이유
- 개장 직후 체결가는 출처마다 다르고(첫 봉 시가와 일봉 시가 불일치), 실제 계좌가 같은 시각에 따라 하기도 어렵다. 한 시각(개장 + 10분)으로 맞추면 모의·실제·감시가 같은 가격 창을 본다.
- 종가 단일가는 공식 종가와 같은 가격이라 남긴다. 시가 단일가는 위 불일치 때문에 뺀다.
- 장중 판단을 Claude 예약에만 맡기면 아무 일도 없는 날과 급변하는 날이 같은 횟수다. 보장 1회와 사건 당김은 최대 3회 안에서만 움직여 예산 최악값을 늘리지 않는다.

## 대안과 버린 이유
- **개장 간격을 설정 키로**: 켠 판 고정 문단에 범위 숫자가 들어 있어 키로 두면 문단을 다시 써야 하고, 바꾸는 것 자체가 실험 조건 변경이라 배포가 필요한 상수와 비용 차이가 작다.
- **사건 때 예약 행을 위 순번으로 옮겨 끼워 넣기**: 순번·감시 신원이 얽혀 주말 작업으로 위험하다. 가장 이른 예약을 당기는 단순판으로 한다.
- **장중 판단도 high**: 호출이 가장 많은 종류라 비용이 커진다. 사용자가 medium으로 정했다.
- **보장 행도 감시 1분봉(보유 상위 + SPY)으로**: 그 행의 신원을 미국 감시 수집(`paper.watch.us`)이 T 뒤 5분 안에 받는지 확인하지 못했다. 이미 시험된 운영자 새 행과 같은 시간별 관측치로 둔다.

## 구현에서 정한 것 (2026-11-07 — 위 결정과 다르면 이쪽이 맞음)
- **켠 판 경계**: 개장 10분 하한은 켠 판 경로에만 넣었다(`FreeTiming.validation` — 하한 앞 `MARKET`은 `MALFORMED`, `CheckpointPacket`·`KrCheckpointPacket`의 남은 시점). 끈 판과 함께 쓰는
  `UsTimedFills`·`KrTimedLadder`의 닫힘 표는 그대로다. 장부는 받는 범위 시작을 다시 보지 않으므로 배포 전 `ft-1` 결정이 낸 대기 주문(`NEXT_OPEN`, `AT_MINUTE` 09:31~09:39 ET·09:01~09:09 KST)은 낸 그대로
  체결된다. `ft-1` 결정이 예약한 장중 판단 09:35 ET·09:05 KST는 새 창 밖이라 장중 판단 작업이 `SKIPPED OUT_OF_RANGE`로 닫는다(계획 행의 판 이름은 `ft-1`로 남고 호출은 `ft-2` 프롬프트).
- **한국 켠 판 문단**: 끈 판과 함께 쓰는 문장(`KR_CLAUDE2_TIMING_READING`, 한국 스탑 줄)은 그대로 두고 켠 판 전용 문장(`KR_FT_TIMING_READING`, `KR_FT_UNFILLABLE_SELL`)을 새로 두었다. 켠 판 `12_hardRules`에서
  '`NEXT_OPEN` 주문은 시가로 체결된다' 줄을 뺐다.
- **규칙 계좌**: 개장이 늦은 날의 첫 분 옮김은 `RuleTiming.choose` 안에서 두 시장에 함께 적용한다(미국 달력에는 개장이 늦은 날이 없어 실제로 바뀌는 것은 없음). 목표 세션 E의 첫 분이
  이미 지났으면(세션 도중의 수동 결정) 한국 대체 시점은 예전처럼 `NEXT_OPEN`이다 — E 장중에 낸 `AT_MINUTE`은 장부가 E+1로 넘기지만 수집기는 E가 `NO_BARS`일 때만 E+1 1분봉을 받아 만료까지
  기다리기만 하기 때문이다. 다시 내기는 실패한 주문의 시점이 아니라 지금 설정을 따른다(`kr.rules.timing`을 `NEXT_OPEN`으로 되돌리면 시가로 다시 냄). 다음 거래일을 달력에서 셀 수 없으면 작업 기록을
  남기고 시가로 낸다. 다시 낸 주문의 근거에는 `reissuedFrom`·`reissuedTiming`이 붙는다.
- **스키마 상한**: 켠 판 결정 스키마의 `checkpoints.maxItems`는 3이다. API용 스키마는 `maxItems`를 싣지 않아 `decision-schema-forapi-us-ft.json`은 이 값으로 바뀌지 않았고,
  `DecisionTimingsLockTest`가 `RuleBookService.INTRADAY_MAX`와 대조한다. 설정 `intradayMaxPerSession`은 0~3을 받되 읽은 값을 `INTRADAY_MAX`로 자른다.
- **보장**(`IntradayScheduler.guarantee`, 두 장중 판단 작업이 주기마다 계획 행을 읽기 전에): 보장 시각 G = 개장 + 180분(미국)·150분(한국)을 받는 범위 끝 − 10분으로 자른다(미국 조기 폐장일
  13:00이면 12:20 — 창 끝으로만 자르면 넣을 시각 '지금 + 1분'이 범위 밖이라 보장이 생기지 않고, 끝 − 1분(12:29)이면 그 1분에 시작한 주기 하나뿐이라 장중 판단 작업의 긴 호출 하나에 밀리면 보장이 생기지 않음 — QA-310). G가 지났고, 그 계좌의 `*.freeTiming`이 켜져 있고, 그 세션의 자유 시점 판 결정이 있고,
  계좌가 운용 중이고, 남은 예약이 없고, 부른 판단이 최소 횟수보다 적고, 순번이 남았을 때 시각 max(G, 지금 + 1분, 끝난 판단 + 20분)이 받는 범위 안이면 한 행을 넣는다(출처 `GUARANTEE`,
  수동 아님 — 정기 문턱). 부를 때 막힐 것(파이프라인 없음·계좌2 꺼짐·계좌2 소상한·하루 정기 문턱)은 넣기 전에 본다 — 막힐 행을 넣으면 순번만 쓴다. 넣은 행이 놓침·건너뜀으로 끝나면 순번이 남는 동안
  다시 넣는다(재시도 없음 규칙과 상한 때문에 '최소 1'은 절대 보장이 아님). 피드는 미국 시간별 관측치(12:31 판단은 12:15 ET 관측치를 읽음), 한국 감시 1분봉(감시 목록 없음 — 수집기가
  보유·대기·기준 종목을 받음)이다.
- **사건**(`IntradayScheduler.events`): 입력은 그 시장 장중 스탑 감시 저장본이라 **사건은 그 시장 `stopWatch.mode`·`kr.stopWatch.mode`가 SHADOW·ON일 때만 생긴다**(감시가 OFF면 사건 스위치를 켜도
  아무 일도 없음). 전일 종가는 갭 가드와 같은 기준(미국 장부 값 → Yahoo, 한국 토스 원시 → 장부 값)이고, 갭 가드(`StopWatch.guard`)가 통과한 종목만 본다(기업행위 의심 날의 거짓 ±4% 방지).
  한국 스탑 근접은 장중 스탑 감시와 같은 유효 최고가(금융위 확정 종가 반영)로 센다. 저장본이 10분보다 오래됐거나 그 세션 항목이 아니거나 이어받은 항목이면 만들지 않는다.
  사건 시각 t = max(지금 + 1분, 받는 범위 시작, 끝난 판단 + 20분). 한 주기에 사건 하나를 이렇게 다룬다 — 당김(가장 이른 예약이 t 뒤면 t로, 출처 `EVENT`·`trigger.originalAt`, 미국 시간별 피드는 감시
  1분봉으로 바꾸고 감시 목록에 사건 종목을 더함 — 최대 10), 붙임(가장 이른 예약이 t 이전이거나 당김이 막히면 사건만 붙임), 덧붙임(남은 예약이 없고 순번이 남았으면 t에 사건 행 — 감시 1분봉, 정기 문턱),
  버림(`NO_SLOT`·`NO_TIME`·`NO_DECISION`·`BOOK_NOT_ACTIVE`·막힌 사유 — 작업 기록에만), 기다림(창이 끝났는데 아직 닫히지 않은 예약이 있으면 다음 주기에 같은 저장본을 다시 봄). 사건 열쇠(종류·종목·방향)는
  그 세션 행들의 `trigger`와 작업 메모리로 세션에 한 번만 쓴다(운영자 당김·다음 예약이 행의 `trigger`를 덮어도 다시 쏘지 않게). 지수 ±1.5% 날에는 켠 판 계좌마다 하나씩 최대 4회가 더해질 수 있다.
- **패킷**: 장중 판단 패킷 `1_basis.origin`·`remainingJudgments`(= min(최대, `INTRADAY_MAX`) − 순번), 요청 `trigger`(null 또는 원래 시각·사건 목록·규칙), `nextCheckpoint.replaces`(대신할 예약의 시각·출처)·`laterReserved`(그대로 남는 뒤 예약 — 다음 순번 뒤의 `PLANNED` 행이 있으면 `nextCheckpoint`는 그 시각보다 20분 이상 앞이어야 하고(계획 쓰기가 어기면 버림) 패킷의 끝 시각도 그 시각 − 20분, QA-309 — 세션당 3에서 순번 순 = 시각 순과 간격을 지킴).
  결정 패킷은 미국 `13_execution.intraday`·한국 `1_basis.intraday`에 `minPerSession`·`guarantee`(그 세션 보장 시각 — 0이면 null)·`events`(문턱·지수 종목·규칙 — 사건이 실제로 당길 수 있을 때만, 아니면 null).
  켠 판 시스템 프롬프트의 장중 판단 절에 보장·사건 규칙 한 줄을 더했다(그 값은 패킷 칸을 가리켜 프롬프트에 설정값이 없음). 같은 배포라 판 이름은 `ft-2`·`kr-ft-2` 그대로다.
- **응답·화면**: 장중 판단 결정 응답의 `checkpoint` 칸에 그 행의 `origin`(사건이면 `trigger`)이 남는다. 알림 머리줄은 보장이면 '(코드 보장)', 사건이면 '(사건)'을 붙인다.
  상태 응답 `intraday`에 `minPerSession`·`events`(시장 묶음 칸)와 행마다 `origin`·`trigger`가 있다.
- **계좌2 소상한**: `ClaudeBookService.claude2CallsInCycle`이 장중 판단 종류 목록(`RuleBookService.INTRADAY_KINDS`)을 모두 센다 — 3회차를 빠뜨리면 소상한이 적게 센다.

## 결과와 남은 위험
- 실험 조건이 바뀐다(대조군 체결 시각, Claude 계좌 메뉴·장중 판단 횟수·effort). ADR 0018에 경계(첫 `ft-2`·`kr-ft-2` 결정, 11-09~11-10)를 적었다.
- 보장 때문에 켠 판 계좌 넷이면 거래일마다 호출이 최소 4회 늘 수 있다. EDT 최악 26회는 예약 30 안이지만 여유가 4다(2027-03 서머타임 전에 다시 본다).
- medium의 판단 질 차이는 재지 않았다.
- 보장 행의 미국 피드는 시간별 관측치라, 그 판단이 보는 가격은 최대 15분 넘게 늦다(12:31 판단은 12:15 ET 관측치).
- 되돌리기: 1단계는 설정만(장중 판단 최소 0·최대 2·사건 꺼짐·`intradayEffort`는 `effort`와 같은 값으로 — 설정 API는 키를 지우지 않음, 예산 60·20·4, 규칙 계좌 기본 시점).
  2단계는 1단계 → 순번 3 예약을 닫는 SQL(`scripts/rollback/intraday-slot3.sql` — 옛 코드는 순번 3을 부르지 못함, 시험 `PaperStoreDbTest.rollbackClosesSlotThreePlans`) → `git revert` → 거래 창 밖 배포.
  V27은 남겨도 된다(더하기만 — 옛 upsert는 새 칸을 몰라 넣는 행은 기본 `RESERVED`).
