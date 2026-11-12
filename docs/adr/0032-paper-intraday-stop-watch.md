# 0032. 모의 장중 스탑 감시(미국·한국): 정규장 5분마다 보유 종목을 보고 트레일링 스탑선 아래가 두 번 이어지면 감지 2분 뒤 시장가 매도, 개장 10분 전에는 팔지 않음, 기업행위 갭 가드, 세 단계 스위치(OFF·SHADOW·ON), 기존 시간별·밤 스탑은 대체 경로로 남김

- 상태: 채택 (2026-11-06 밤 사용자 요청과 결정 — "한국에도 미국처럼 장중 감시(스탑 매매)를 켜고 토스·ISA에도 적용", 질문 답 "5분 감시 · 두 번 연속 · 감지 다음 분 시장가 ·
  개장 10분 전에는 팔지 않음", 계획 승인). **구현 끝, 배포 전**(브랜치 `claude/intraday-timing-2026-11`, 2026-11-07 — 설정 키 `e5ebaeee`, 수집기·판정기·작업·장부·대체 경로·매수 거절
  `0ddc66d8`~`05b1c302`, 스탑 설명 글 `135ddba7`). 2026-11-07 21:05 KST에 Vultr에 배포(main@`231efe95`)하고 21:09에 설정을 저장(미국 v16 → 한국 달력 v17 → 한국 장중 판단 v18 → 한국 규칙·감시 v19, 시장마다 사용자 재확인)했습니다. 스위치 기본값은 `OFF`라 배포만으로는 수집·판정·주문이 없고, 저장으로 미국·한국 모두 `ON`입니다(첫 판정 11-09 09:10 KST 한국, 23:40 KST 미국). 배포 커밋과 스위치를 저장한 설정 판은
  배포 뒤 이 줄에 적습니다.
- 바꾸는 결정: 모의매매 명세 D10(트레일링 스탑 감지 시점 — 미국 시간별 관측치, 한국 밤 잠정 평가가 → 다음 거래일 시가)과 [ADR 0021](0021-kr-paper-prices-fills-start.md) 결정 2의 한국 스탑 체결 시점(스위치를 켠 시장에 한해).
  스탑 비율(`trailingStopPct`·`kr.trailingStopPct`)·재진입 금지·현금성 제외는 그대로다.
- 함께 보는 결정: [ADR 0031](0031-open-offset-window-intraday-budget.md)(개장 10분 뒤 창, 사건 판정이 이 저장본을 읽음), [ADR 0033](0033-real-isa-open-offset-and-stops.md)(실제 토스 계좌·ISA가 이 스탑을 따름),
  [ADR 0008](0008-backend-owned-tables-and-scheduled-jobs.md)(수집기는 백엔드 표를 읽기만), [ADR 0018](0018-paper-trading-guardrails.md)(실험 조건 경계 기록).
- 지키는 방법:
  - 수집기: `test_paper_stopwatch.py`(OFF·키 없음이면 호출 0회, 창 밖·주말·보유 없음·slow 군·래치면 묻지 않음, spark 줄 해석, 거부 뒤 두 회차 쉼, 휴장·조기 폐장 배우기, 한국 호출 상한·403·토스 키 없음,
    범위는 운용 중이고 벤치마크가 아닌 책의 보유를 읽기만), `test_task_registry.py`(44), `test_yahoo_budget.py`, `test_toss_call_budget.py`(한국 감시 상한·시각 지정 1분봉 240과 문서 대조),
    `test_table_ownership.py`(백엔드 표는 읽기만), 데이터셋 이름 대조 `DatasetsParityTest`.
  - 판정·작업: `StopWatchTest`(두 번 이어짐·한국 봉 끝 라벨·묵은·다른 세션 항목·0.2주 무상증자형 갭·원시와 수정 종가 불일치·미국 분할 갭·창·한국 밤), `PaperStopWatchJobTest`
    (`onPlacesOneStop`·`shadowAndOff`·`exclusionsAndGuard`·`windowAndLateSnapshot`·`missedGridsAreJudgedFromTheNextSnapshot`·`koreaGapGuardAndUnknownCalendar`·`koreaWatermarkAndHolds`), `PaperDecisionJobTest.schedulerPoolIsEight`.
  - 장부·대체 경로: `StopWatchLedgerTest`(장중 시장가·종가 STOP 체결과 재진입 금지, 한국 장중 STOP은 금융위 재판정 없음, 늦은 주문 가드 ⑤), `StopWatchFallbackTest`(미국 — 덮인 종목은 감시에 맡김·덮이지 않은
    종목은 시간별 스탑·OFF와 SHADOW는 옛 경로·대기 STOP을 겹쳐 내지 않음, 한국 — 덮이지 않은 종목은 다음 세션 첫 분·장 시간 변경일·SHADOW는 시가 스탑).
  - 마지막 격자 판정 기록(QA-384 — 아래 덧붙임): `StopWatchFallbackTest`(미국 `lastGridNeverJudgedKeepsTheCloseFallback`·`summaryShortOfTheLastGridKeepsTheCloseFallback`·
    `shadowJudgedLastGridKeepsTheCloseFallback`·`judgedLastGridIsLeftToTheWatchAtTheClose`·`hourlyObservationBeforeTheGridEndDoesNotAskForTheRecord`·
    `pendingWatchStopIsNotDoubledWhenTheLastGridWasNotJudged`, 한국 `lastGridNeverJudgedKeepsTheNightFallback`·`judgedLastGridIsLeftToTheWatchAtNight`·
    `lateProcessingAfterTheGridEndNeedsTheRecord`), `PaperStopWatchJobTest`(`judgedLastGridLeavesTheCloseToTheWatch`·`lastGridStopIsFilledOnceAtTheClose`·
    `unjudgedLastGridKeepsTheCloseFallback`·`lastGridRecordOncePerSession`·`lastGridRecordModeAndSummaryEvidence`·`lastGridRecordIsRetried`·`earlyCloseLastGrid`·
    `koreaShiftedDayLastGrid`).
  - 새 매수 거절: `KrClaudeValidationTest.pendingWatchStopBlocksNewBuys`, `KrRuleBookServiceTest.pendingWatchStopKeepsTheCandidateOut`.
  - 스탑 설명 글(켰을 때만): `PacketBuilderTest.stopWatchOnPackets`, `KrPacketBuilderTest.stopWatchOnPacket`, `FrameworkServiceTest.krStopWatchOnRender`, `CheckpointPacketTest.stopWatchOnIntradayPacket`,
    고정본 `packet-us-ft-claude2-stopwatch-scheduled.json`·`packet-kr-ft-stopwatch-scheduled.json`·`render-kr-ft-claude-v0-stopwatch.txt` — 기본 설정(OFF)의 고정본은 모두 그대로.
  - 설정·화면: `PaperSettingsServiceTest.stopWatchAndIntradayPolicyKeys`(기본 OFF, 세 값만 받음, 규칙 계좌 영향 키), `KrRuleBookServiceTest.affectsRulesMatchesTheKeysRead`, 화면 `paperStopWatch.test.ts`.

## 배경
트레일링 스탑은 지금 미국은 시간별 관측치(매시)로, 한국은 밤 잠정 평가가로 감지해 다음 거래일 시가에 판다. 장중에 스탑선을 깊이 뚫어도 한국은 다음 날 아침까지, 미국은 다음 관측치까지 기다린다.
사용자는 미국·한국 모의 책과 이를 따라 하는 실제 계좌·ISA에 장중 감시를 켜기로 했다.

## 결정
1. **대상**: 미국·한국 모의 책의 규칙·Claude 계좌1·Claude 계좌2(벤치마크 제외). 현금성 종목은 지금처럼 스탑을 보지 않는다.
2. **감시**: 정규장 동안 5분마다 보유 종목의 1분봉을 받는다 — 미국은 Yahoo spark 배치, 한국은 토스 1분봉. 수집기 새 태스크 둘이 `paper_positions`·`paper_settings`를 읽기만 한다(ADR 0008 범위 안).
   미국 감시는 수집기 slow 군이 Yahoo를 쓰는 동안 쉰다(공용 Yahoo 래치 경합 — 다음 회차가 빠진 격자를 저장본으로 메움).
3. **판정**: 스탑선(최고가 × (1 − 스탑 비율)) 아래가 5분 감시 두 번 이어지면 건다. 개장 10분 뒤 전에는 팔지 않는다. 감지 시각 G의 주문은 T = G + 2분 시장가 STOP이다
   (늦은 주문 가드 '생성 + 60초 뒤 첫 분'을 지킴). 한국 종가 단일가 시간(15:20 뒤)의 감지는 종가 주문이다.
4. **갭 가드**(기업행위 오인 방지): 그날 첫 봉 시가가 전일 원시 종가 × 0.85 이하이거나, 수정주가와 원시 종가의 전일 값이 다르면 그 종목은 그날 감시에서 빼고 밤 경로(기업행위 판정 뒤 스탑)에 맡긴다.
   무상증자·권리락처럼 가격만 내려간 날에 실제 매도가 나가지 않게 한다.
5. **세 단계 스위치**: `stopWatch.mode`(미국)·`kr.stopWatch.mode`(한국) = `OFF`·`SHADOW`·`ON`, 기본 `OFF`(키가 없는 설정 행도 꺼짐). `OFF`면 수집기 외부 호출이 0이다.
   `SHADOW`면 '걸렸을 것'을 작업 기록에만 남기고 주문을 내지 않는다. `ON`이면 STOP 주문을 낸다. 규칙 계좌가 읽는 키라 바꾸면 그 시장 규칙 계좌 경고가 뜬다.
6. **체결**: 기존 1분봉 사다리로 체결한다(미국은 다음 관측치 처리, 한국은 그날 밤 장부). 장중 STOP에도 재진입 금지를 건다. 한국 장중 STOP은 금융위 확정가 재판정을 하지 않는다(토스 1분봉 체결가가 확정가).
7. **대체 경로를 남긴다**: 감시가 덮지 못한 종목(수집 실패·가드 제외·감시 꺼짐)은 기존 경로가 판다 — 미국은 시간별 관측치, 한국은 밤 감지 뒤 다음 세션 개장 10분 뒤 `AT_MINUTE`.
8. **대기 STOP 종목에는 새 매수를 거절한다**(Claude 검증기·규칙 계좌 후보).
9. **스키마 변경 없음**: STOP + MARKET·AT_MINUTE·NEXT_CLOSE 조합은 기존 CHECK(V8·V22)가 받는다. 판정 근거는 `paper_orders.reason` JSON과 `paper_job_runs`에 남긴다.
10. **운영 값**: 백엔드 정기 작업 스레드 6 → 8, 한국 시각 지정 1분봉 호출 예산 180 → 240. 감시가 `ON`인 시장의 Claude 결정 패킷은 스탑 설명 글과 `1_basis.stopWatch`를 싣는다
    (기본 설정 `OFF`의 고정본은 그대로 — 아래 '구현에서 정한 것').
11. **배포 뒤 저장**: 미국 `stopWatch.mode=ON`, 한국 `kr.stopWatch.mode=ON`(사용자 결정 — 하루 SHADOW 권장 대신 바로 켬, ADR 0033). 시장별로 따로, 그때 사용자에게 다시 확인받는다.

## 이유
- 5분 두 번 이어짐은 한 봉의 튐(호가 공백·잘못된 체결)에 걸리지 않으면서 10분 안에 반응한다.
- 감지 2분 뒤 시장가는 기존 늦은 주문 가드와 1분봉 사다리를 그대로 쓰게 한다.
- 기업행위 판정은 밤 경로에만 있어(원시가 1분봉으로는 권리락을 모름) 장중에는 큰 갭을 아예 맡기지 않는 쪽이 안전하다.

## 대안과 버린 이유
- **켜고 끄기 두 단계**: 로컬 스택(복원 데이터)도 미국 장중에 외부를 부르고, 실제 계좌에 닿기 전 하루 관찰(SHADOW)을 할 수 없다.
- **기준 종가 × 0.69 가드만**: 0.2주 무상증자(약 −17%)를 못 잡아 −8% 스탑이 걸린다.
- **미국 감시를 종목별 요청으로**: 세션당 요청 수가 spark 배치의 약 20배라 429 위험이 크다.
- **미국 대체 경로도 대기 STOP으로**: 시간별 관측치에서 즉시 파는 지금 경로가 이미 시험되어 있고, 덮이지 않은 종목만 남으므로 그대로 둔다.

## 구현에서 정한 것 (2026-11-07 — 위 결정과 다르면 이쪽이 맞음)
- **수집**(`collector/app/tasks/paper_stopwatch.py`, session 군 — 매 5분 :20초, 저장본 `paper.stopwatch.us`·`paper.stopwatch.kr` contract 1): 창은 그 세션 개장 + 4분 ~ 장 끝 여유 앞 + 1분
  (미국 09:34~15:56 ET, 한국 09:04~15:21 KST, 수능일 같은 장 시간 변경일은 `kr.calendar.openTimeOverrides`의 그날 개장·마감 — 10:04~16:21). 범위는 운용 중이고 벤치마크가 아닌 책의 보유 + 기준 종목
  (미국 SPY·한국 069500 — 지연과 지수 사건의 입력). 미국은 Yahoo spark(`range=1d`·`interval=1m`, 20종목 한 요청)이고, 2026-11-06 장중 실측으로 응답은 종가와 봉 시작 시각뿐(거래량 없음)이며
  진행 중인 봉은 분에 맞지 않는 시각으로 온다 — 그래서 미국의 '거래 봉'은 종가가 있는 봉이고 갭 가드의 '첫 봉 시가'는 첫 분 종가로 대신한다. 미국 휴장·조기 폐장은 첫 응답의 SPY로 배운다.
  거부(403·429)를 받으면 다음 두 회차를 쉰다(spark 호스트 래치는 yfinance 래치를 닫지 않음). 한국은 토스 1분봉(원시가, 200개 한 쪽)과, 그 세션에 처음 보는 종목만 토스 일봉 원시·수정 각 한 쪽
  (전일 종가 — 같은 세션 안에서는 직전 항목에서 이어 씀). 실행당 상한 120회·40초. 받지 못한 종목은 같은 세션의 직전 항목을 잇고 `isStale`(다른 세션 항목은 잇지 않음).
- **판정**(`StopWatch` — 저장본 한 장만 보는 순수 함수, `PaperStopWatchJob` — 20초 주기, 판정 창 개장 10분 뒤 ~ 마감 5분 뒤, 장부 잠금 안, Claude 호출 없음): 격자 G = 개장 + 5분 × k, 끝은
  마감 − 장 끝 여유(미국 15:55 ET, 한국 15:20). 격자의 가격은 그 5분의 마지막 거래 봉 종가(미국 봉 시작 [G − 5분, G − 1분], 한국 봉 끝 (G − 5분, G]). 첫 격자는 앞 격자가 없어 가장 이른 판정이
  개장 + 10분이다. 주문 시점 T는 감지(주문 생성) + 60초 뒤 첫 분(`ExecutionAudit.marketTarget`)이고, T가 그 세션 첫 분 앞이면 첫 분의 `AT_MINUTE`, 장 끝 여유 안이면 그날 `NEXT_CLOSE`, 그 밖은
  `MARKET`이다. 만료는 그 세션이다. 감시 회차를 쉬었어도(slow 군·래치) 다음 저장본의 40분 봉으로 빠진 격자를 판정한다 — 세션 첫 판정 전 회차를 놓쳤어도 첫 판정 격자부터(QA-306). 재기동·세션 중 켬 직후(그 세션의 작업 상태를
  첫 판정 격자 뒤에 연 경우)에만 이 프로세스가 앞 격자를 봤는지 몰라 가장 최근 격자만 본다. 새 저장본이 없으면 판정하지 않고,
  첫 판정 격자 + 15분이 지났고 저장본이 15분 넘게 늦으면(없음·지난 세션 것 포함) 그 세션에 한 번 '늦음'을 작업 기록에 남긴다(그동안은 대체 경로가 지킴 — 7분 신선도는 판정할지에만,
  미국 :15:20 회차 쉼의 7~10분은 늦음이 아님, QA-319). 판정 때 만료일이 지난 대기 주문은 세지 않고, 목표 세션이 지난 STOP은 오늘 감시 STOP을 막지 않는다(QA-318). 판정 중 예외가 나면
  본 저장본 표시를 남기지 않아 같은 저장본을 다시 보고, 달력이 그 해를 모르면 오류 없이 건너뛴다. 한국 최고가는 금융위 확정 종가를 반영한 유효 최고가다.
- **갭 가드 수치**: 첫 봉 ≤ 전일 원시 종가 × 0.85, 한국 토스 일봉 전일 원시·수정 종가 차이 > 0.5%, 미국 Yahoo `previousClose`와 장부 전일 종가(`fill_ref_close` — 기준일이 직전 거래일일 때) 차이 > 2%.
  장부의 덮음 판정도 그 관측치 처리 시작 때 저장돼 있던 기준일·기준 종가로 가드를 본다(감시 작업과 같은 입력 — 마감 뒤 관측치가 기준일을 그날로 옮긴 뒤에도, QA-305).
  가드를 판단할 자료(첫 봉·전일 종가)가 없으면 그 종목은 판정하지 않는다. 저장본에 전일 종가가 아직 없으면 장부 종가로 0.85 검사만 한다(원시·수정 대조는 빠짐).
- **덮음과 대체 경로**(`ON`일 때만 — `SHADOW`의 장부 동작은 `OFF`와 같음): 그 세션 항목이 이어받지 않은 새 값이고 가드가 판단되어 통과했고 그 시각 − 10분 뒤의 거래 표본이 있으면
  감시가 그 종목을 '덮었다'고 본다. 격자 끝 뒤의 판정(미국 마감 뒤 관측치·한국 밤)은 마지막 격자(15:55 ET·15:20 KST)의 가격이 있을 때만 덮음이다 — 마지막 감시 회차를 놓친 날
  (session 군의 앞 태스크가 길어 창 끝을 넘김·거부 뒤 쉼·래치)은 대체 경로가 종가·밤 스탑을 맡는다(QA-307). 미국 시간별 스탑은 덮인 종목을 건너뛰고, 덮이지 않은 종목은 예전처럼 즉시 스탑을 내되 근거에 `stopMode HOURLY_FALLBACK`을 붙인다. 한국 밤 감지는 덮인 종목을
  다음 세션 감시에 맡기고(밤 잠정 종가 한 번으로 내지 않음), 덮이지 않은 종목은 다음 세션 첫 분(09:10, 수능일 10:10 — `RuleTiming.reissueAt`)의 `AT_MINUTE` STOP(`stopMode NIGHT_FALLBACK`, 기준일 D,
  만료 D + 3거래일, 체결 때 금융위 재판정)을 낸다. 덮음은 책마다다 — 한국은 그 세션에 이 책이 연 보유를 감시가 본 적이 없어 덮지 않음으로 본다(QA-316). 감시를 켠 시장에서는
  이번 처리 시작 때 since가 이미 그 봉까지 온 보유를 다시 판정하지 않고(다음 세션 장중의 다시 저장), 그 첫 분이 이미 지났으면 시가로 내지 않고 다음 세션 장이 끝났으면 내지 않음·감시가
  지금 세션을 지켜보면 감시에 맡김·아니면 감시 STOP과 같은 시점(장중 시장가·그날 종가)으로 낸다(QA-317). 이 첫 분·마감·덮음 판정과 대체 STOP의 생성 시각은 관측치의 수집 시각이
  아니라 처리 시각(둘 중 늦은 쪽)으로 센다(QA-327 — 밤새 꺼졌던 백엔드가 다음 세션 장중에 처음 처리한 밤 관측치, 5분 주기 처리의 늦은 장중 시장가). 감시 기능 STOP이 그 목표 세션 자료로 체결하지 않음이면 그 밤에 만료로 닫고
  덮음을 다시 본다(QA-318). 대기 STOP이 있는 종목은 스위치와 상관없이 다시 내지 않는다.
- **덧붙임(2026-11-12, QA-384) — 격자 끝 뒤의 덮음은 감시 작업이 그 세션의 마지막 격자를 `ON`으로 실제 판정한 DB 기록이 있을 때만이다.**
  - 무엇이 왜: 위 '덮음'은 수집기의 감시 저장본만 봤다(마지막 격자 가격이 있으면 덮음 — QA-307, 저장본을 받은 때의 `mode`가 `ON` — QA-360). 저장본은 수집기가 쓰고
    판정은 백엔드의 감시 작업이 하므로, 마지막 격자 시각에 백엔드가 재기동 중·죽어 있던 날은 저장본에 가격이 있어도 아무도 그 격자를 판정하지 않았는데 미국 마감 뒤
    관측치·한국 밤 감지가 '감시에 맡김'으로 읽어 그날의 종가·밤 스탑이 빠졌다.
  - 고침: ① 감시 작업은 그 세션의 마지막 격자(격자 끝 — 그날 달력: 보통 날 15:55 ET·15:20 KST, 조기 폐장일 12:55 ET, 장 시간 변경일은 그날 마감 − 10분)를 판정한
    회차에, 판정과 같은 장부 잠금 안에서 작업 기록 `stopwatch.lastgrid`·`kr.stopwatch.lastgrid` 한 줄(상세 `{market, mode(판정 때), tradingDate, lastJudgedGrid,
    judgedAt, since, partial}`)을 남긴다 — `SHADOW`·`ON` 모두, 세션마다 한 줄(같은 줄이 있으면 다시 남기지 않음), 기록에 실패하면 다음 회차에 다시. ② 장부
    (`PaperLedgerService.watchCovers`)는 판정 시각이 그 세션 격자 끝 이후이면 저장본의 덮음에 더해 그 세션의 이 기록(`mode ON`·`lastJudgedGrid` = 격자 끝, 시각으로 대조)이나
    같은 사실을 적은 세션 요약(`stopwatch.summary`의 `lastJudgedGrid`·`mode`)을 요구한다(`PaperStopWatchJob.lastGridJudged` — 한 처리에 세션마다 한 번 읽음). 없으면 대체 경로가
    맡고(미국 `HOURLY_FALLBACK` 종가 스탑, 한국 `NIGHT_FALLBACK`) 리스크 작업 기록의 메모에 까닭을 남긴다. 격자 끝 전의 판정(미국 시간별 — 그 시각 − 10분 뒤의 거래 표본)은 그대로다.
    스키마 변경 없음(`paper_job_runs.detail` JSON).
  - 평소 날은 그대로다: 마지막 격자를 판정하면 기록이 같은 잠금 안에서 먼저 생기므로 장부가 '판정했는데 기록은 아직'을 볼 틈이 없다. 운영 기록(2026-11-09~11-12의 세션 요약
    7건 — 한국 4·미국 3, `partial` 둘 포함)은 모두 `lastJudgedGrid`가 그 세션의 마지막 격자였다. 감시가 이미 낸 대기 STOP은 두 경로 모두 이 판정 앞에서 건너뛰어 겹쳐 내지 않는다.
  - 기록 시점을 판정 직후로 둔 까닭(요약과 밤 판정의 선후): 세션 요약은 판정 창 끝(마감 + 5분) 뒤 첫 회차에야 남고, 창 끝 뒤에 뜬 프로세스는 남기지 않는다. 평소 일정에서는
    요약이 격자 끝 뒤 판정보다 앞서지만(미국 16:05 ET 요약 → 16:15 ET 관측치, 한국 15:35 요약 → 20:30 뒤 밤 관측치), 요약만 근거로 삼으면 (가) 판정 뒤·요약 전에 재기동된
    날(미국 15:56~16:05 ET, 한국 15:21~15:35 KST)은 감시가 끝까지 봤는데도 덮지 않음이 되고 (나) 요약보다 먼저 도는 격자 끝 뒤 판정(미국 정시 밖 관측치 — 수집기 재기동·수동 수집,
    한국 D 밤 관측치를 D+1 15:20~15:30에 처음 처리하는 QA-317 경로)이 평소에도 덮지 않음이 된다. 세션 요약은 이 기록이 없던 판의 프로세스가 판정한 세션(배포 당일 — 옛 프로세스가
    요약을 남긴 뒤의 배포)과 기록을 끝내 남기지 못한 세션의 근거로 함께 읽는다.
  - 재기동 시각별: 마지막 격자 **전**에 내려갔다가 그 저장본이 아직 신선할 때(수집 뒤 7분 안, 판정 창 안 — 감시 작업의 첫 회차는 기동 195초 뒤) 돌아오면 새 프로세스가 가장 최근
    격자(= 마지막 격자)를 판정하고 기록을 남겨 덮음이다. 그보다 늦게 돌아오면 기록이 없어 대체 경로가 맡는다 — **이 수정으로 달라지는 날**. 판정 **직후**나 요약 **뒤**의 재기동은
    기록이 DB에 있어 전과 같이 덮음이다.
  - 검토한 대안: 프로세스 메모리의 세션 상태(재기동하면 사라져 저녁 배포 뒤 덮음이 전부 거짓), 세션 요약만(위 (가)·(나)), 감시 작업의 일반 기록 `stopwatch`에 싣기(주문·가드 기록과
    최근 200건 한도를 나눠 쓰고 상세에 `tradingDate`가 없음), 새 표(스키마 변경), 수집기가 저장본에 적기(수집기는 백엔드의 판정을 모른다 — ADR 0008).
  - 감수한 단점: 재기동·장애가 마지막 격자와 겹친 날은 '5분 두 번 이어짐' 대신 종가·밤 잠정 종가 표본 한 번으로 스탑이 나갈 수 있다(감시를 켜기 전의 규칙 — 스탑이 빠지는 쪽보다
    낫다고 봤다). 마지막 저장본이 들어온 뒤 감시 작업이 판정하기 전(20초 안팎)에 격자 끝 뒤 판정이 돌면(정시 밖 관측치) 그 판정도 대체 경로로 간다(전에는 덮음). 판정 뒤·요약 전에
    이 판으로 배포한 세션(옛 프로세스가 판정)은 기록이 없어 그 세션만 대체 경로다(신선한 저장본을 새 프로세스가 다시 판정하면 덮음). 작업 기록이 세션마다 한 줄 늘고 화면의 작업 기록
    목록에 이름 그대로 보인다.
- **체결**: 대기 STOP 체결은 장부 결과에서 즉시 스탑과 같은 칸(`stopped`)으로 센다. 감시 STOP의 근거는 `stopMode INTRADAY_WATCH`와 감지 격자·가격이다.
- **새 매수 거절**: Claude 검증기는 감시 기능이 낸 대기 STOP(`INTRADAY_WATCH`·`NIGHT_FALLBACK`)의 종목만 재진입 금지처럼 거절한다 — 감시를 켜기 전부터 있던 한국 밤 감지 STOP(`stopMode` 없음)은
  넣지 않아 끈 판 검증 결과가 그대로다. 규칙 계좌 두 곳은 이미 대기 매도가 있는 종목을 매수 후보에서 뺀다(QA-196 — 시험으로만 고정).
- **스탑 설명 글**(`ON`일 때): 그 시장의 모든 Claude 결정 패킷(끈 판 계좌1·한국 비 자유 시점 판 포함 — 스탑 동작이 시장 단위라서)에 스탑 문장과 `1_basis.stopWatch`를 싣고, 대기 감시 STOP 종목을
  `12_hardRules.lockedOut`에 넣는다(검증기의 거절과 같음). 한국 시스템 프롬프트의 하드 규칙 스탑 줄(`FrameworkService.krHardRules` — 주간 복기 프롬프트도 씀)은 `kr.stopWatch.mode`가 `ON`일 때만 바뀐다
  (켜는 저장 뒤 프롬프트 캐시가 한 번 새로 쓰임). 미국 시스템 프롬프트의 '(코드가 집행)' 줄은 여전히 맞아 바꾸지 않았다. 장중 판단 패킷은 켠 판 쪽만 `1_basis.stopWatch`(미국은 `6_hardRules` 감시 줄도)를 싣는다.
- **운영 값**: 한국 감시 수집 실행당 120회·40초는 시각 지정 1분봉(`kr_paper_timed`, 240)과 따로 센다.

## 결과와 남은 위험
- 대조군(규칙 계좌)의 스탑 시점이 바뀐다 — 실험 조건 변경으로 ADR 0018에 적었다. 켠 시장의 Claude 패킷·한국 시스템 프롬프트도 바뀐다.
- 미국 Yahoo 1분봉 지연 때문에 감지가 몇 분 늦을 수 있다(저장본의 지연 값으로만 앎). 첫 주에 spark 429 횟수를 잰다. 미국 :15:20 회차는 slow 군 때문에 쉬는 것이 정상이다.
- 감시와 장중 판단(사건 '스탑 2% 안')이 같은 종목을 함께 팔려 할 수 있다 — 대기 STOP 종목은 새 매수만 막고, 매도 쪽은 장부가 남은 수량으로 처리한다.
- 화면의 '장중 감시 스탑 대기' 표시는 아직 없다(뒤 작업). 텔레그램 주문·체결 알림과 화면 주문 표의 시점 이름은 감시 STOP을 감지한 그 세션의 이름으로 적고(종가 '그날 종가', 시장가는
  기준 시각 — QA-312 · 첫 분이 지난 처리의 밤 대체 STOP 장중 시장가·종가도 같음 — QA-327), 계좌 설명·주문 안내·설정 설명 `kr.trailingStopPct`의 스탑 문장은 스위치의 두 경우를 함께 적으며 계좌 상세 '지금 설정'에 스위치 행이 있다(QA-313 — 설정 값으로 문장을 고르지는 않음).
- 되돌리기: `stopWatch.mode`·`kr.stopWatch.mode`를 `OFF`로(몇 초 — 수집 호출도 그다음 회차부터 0). 남은 대기 STOP(MARKET·AT_MINUTE)은 그대로 체결된다. 코드를 되돌리면 옛 사다리로 체결되고
  재진입 금지가 걸리지 않는다 — 받아들이고 기록한다.
