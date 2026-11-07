# 설계 — ISA 계좌: 연결되지 않은 다른 증권사 계좌를 규칙 계좌 메커니즘으로 '지시 + 직접 매매'

- 상태: **확정**(2026-11-06 사용자 승인). 결정 기록은 [ADR 0029](../adr/0029-isa-manual-account.md). 이 문서는 백엔드·화면이 함께 따르는 **계약**이다.
  개장 10분 뒤 지시와 장중 스탑 지시([ADR 0033](../adr/0033-real-isa-open-offset-and-stops.md), 2026-11-07 배포)는 §11 — 앞 절과 다르면 §11이 맞다.
- 사용자 요청: "이 프로젝트와 연동하지 않은 다른 증권계좌(현금 1,000만 원)를 한국 '규칙 계좌' 메커니즘으로 운용. [한국]-[실제 계좌] 옆에 'ISA 계좌'. 1,000만 원으로 시작해 지금 시장가에 매수.
  화면을 보거나 텔레그램 알림으로 내가 직접 매매. [미국]에는 넣지 않음."
- 사용자 결정(2026-11-06): ① 체결은 **지시대로 자동 기록 + 다르면 화면에서 고침** ② 텔레그램은 **ISA 지시에 한해 종목 코드·이름·수량 포함**(금액·평가액 없음)
  ③ 알림은 **밤 결정 직후 + 아침 08:00** ④ 장부는 **2026-11-06 14:55 안내 목록대로 산 것으로 시작**.
- 토스 실제 매매([ADR 0028](../adr/0028-real-trade-mirror.md))와 다른 점: 증권사 연결·주문·계좌 조회가 **없다**. 돈을 움직이는 것은 사용자이고, 시스템은 장부를 들고
  '다음 시가에 무엇을 몇 주'를 계산해 알려 줄 뿐이다. 그래서 세 스위치·비밀번호·멱등 같은 주문 안전 장치가 필요 없다.

## 1. 장부

- 계좌 하나(`code = "isa"`, 이름 'ISA 계좌', 시장 KR, 따라 하는 책 `kr_rules`). 시작 전에는 행이 없고 화면은 '시작' 창을 보인다.
- 장부 행(`manual_ledger`)이 정본이다: `kind` ∈ {`DEPOSIT`(시작 현금 포함), `WITHDRAW`, `BUY`, `SELL`, `ADJUST`(수량만 바꾸는 조정 — 분할 등)}.
  현금 = Σ입금 − Σ출금 − Σ매수(수량 × 체결가 + 수수료 + 세금) + Σ매도(수량 × 체결가 − 수수료 − 세금). 보유 = 종목별 Σ매수 수량 − Σ매도 수량 + Σ조정 수량.
  현금이 음수가 되거나 보유가 음수가 되는 행은 받지 않는다(400 `ledger-invalid`).
- 평가: 보유 × 마지막 가격(`PaperMirrorService.lastPrices` — 밤 관측치 종가(직전 종가), 없으면 null. 한국 감시 1분봉은 장중 판단 입력 전용이라 쓰지 않는다). 모르는 가격의 종목은 평가에서 빼고 `unpriced`로 알린다.
  손익 = 평가액 − 순입금(Σ입금 − Σ출금). 수수료·세금은 사용자가 고칠 때만 들어간다(자동 기록은 0 — 화면에 '비용 0으로 어림' 표시).

## 2. 지시 만들기 — 실제 매매와 같은 '목표 보유 맞추기'

- 정기 작업(10분, 전용 단일 스레드 — `RealTradeJob`과 같은 패턴, `dashboard.paper.enabled`·스케줄러가 켜져 있을 때만)이 KR 결정일 D마다 다음 세션 E(그 실행 달력의 다음 거래일)의 지시를 만든다.
  조건: 계좌 ACTIVE, 규칙 계좌의 D 정기 결정 행이 최종(OK·NO_TRADE·SKIPPED 또는 기한 지남), `PaperMirrorService.ledgerCaughtUp(kr_rules, E)`가 참, 그 E의 지시가 아직 없음.
- 목표 비중 = `PaperMirrorService.openTargets(kr_rules, E)`(보유 + E 시가 대기 주문 — STOP·RULE·153130 포함)의 `weightPct`, 기준가 = 그 `price`(책에 없는 ISA 보유는 `lastPrices`).
  ISA 평가액 = 장부 현금 + Σ보유 × 기준가. 목표 수량 = floor(비중 × 평가액 ÷ 기준가). 차이가 **1주 이상이고 평가액의 1% 이상**인 종목만(책에 없는 보유는 1% 조건 없이 전량 매도) —
  `RealTradePlanner.sync`를 그대로 쓴다(scope·sendable 없음, 1건 상한·하루 한도 없음).
- 현금 확인: 매도 먼저 — 매수 합(수량 × 기준가 × 1.02)이 '장부 현금 + 같은 지시의 매도 대금(수량 × 기준가)'을 넘으면 뒤 순서 매수부터 수량을 줄이고, 1주도 안 되면 뺀다(`deferred-cash`).
  순서는 매도 → 매수, 현금성(153130·`cashLikeTickers`)은 매수 마지막.
- 지시 행(`manual_instructions`): 세션 E, 종목, 방향, 수량, 기준가, 목표 비중, 근거(규칙 계좌 결정 번호·목표 비중·평가액), 상태 `PLANNED`. 같은 (계좌, 세션, 종목)은 한 행.
  지시가 하나도 없으면 그 세션은 '지시 없음'으로 기록하고 알리지 않는다.
- `openTargets`가 비거나 불완전(`complete()` 거짓)이면 지시를 만들지 않고 다음 주기에 다시 본다(빈 목표 = 전량 매도 방지). E 개장 뒤에도 못 만들었으면 그 세션은 '못 만듦'.

## 3. 자동 기록과 고침

- E 밤, 모의 장부가 E 관측치를 처리할 때 쓰는 같은 시가(`PaperMirrorService.openPrices(E, tickers)` — `KrFills`의 사다리: '개장+1분' 1분봉 시가(거래량 > 0) → 토스 일봉 시가)가
  있으면 `PLANNED` 지시를 그 시가로 장부에 체결 기록한다(`source = AUTO`, 수수료·세금 0, 상태 `RECORDED`). 시가를 못 구한 종목은 `PLANNED`로 남기고 '체결 기록 대기'.
- 사용자가 그 전에 그 지시의 체결을 입력했으면(`instruction_id`가 같은 `USER` 행) 자동 기록하지 않고 `RECORDED`로 둔다.
- 고침: 장부 행 수정(수량·체결가·수수료·세금·시각·메모)·삭제, 새 행 추가, 지시 `SKIPPED`(건너뜀 — 장부에 쓰지 않음). 다음 지시는 고친 장부로 계산한다.
- 시작(`POST /api/manual/isa/start`, 한 번만 — 이미 시작했으면 409 `already-started`): 시작 현금(DEPOSIT 행)과 시작 매수 목록(종목·수량·체결가 — BUY 행, `source = USER`)을 한 트랜잭션으로.

## 4. 알림(텔레그램 — 사용자 결정 ②③)

- 밤: 지시를 만든 직후 한 통. 아침: E 08:00(KST) 뒤 첫 주기에 `PLANNED` 지시를 한 통 더(밤에 못 보냈어도 보냄). 각각 `notified_night_at`·`notified_morning_at`으로 한 번씩.
- 글: `<b>[ISA 계좌] 11/09(월) 시가 매매 지시</b>` / 줄마다 `매도 307950 현대오토에버 3주` · `매수 153130 KODEX 단기채권 1주` / 끝에
  `장전 동시호가(08:30~09:00)에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다. 다르게 매매했으면 화면에서 고치세요.` **종목 코드·이름·수량만 — 금액·평가액·현금 없음.** 이모지 없음.
- 텔레그램이 설정되지 않았거나(`PaperTelegram.configured()` 거짓) 보내기에 실패하면 다음 주기에 다시(최대 그 세션 개장 전까지 — 개장 뒤에는 밤 알림을 버리고 아침 알림만).

## 5. API(모두 운영자 전용 — `AccessPolicy`, `AccessPolicyTest`)

- `GET /api/manual/isa` → `{available, started, account{code,label,market,sourceBook,sourceLabel,state,startedAt,startCash}, summary{cash, marketValue, equity, netDeposit, profitLoss, profitLossPct, unpriced[]},
  holdings[{symbol,name,quantity,avgPrice,lastPrice,marketValue,weightPct}], instructions{session, status, items[{id,symbol,name,side,quantity,refPrice,weightPct,status,notifiedNightAt,notifiedMorningAt}]}|null,
  recentInstructions[…](최근 30), ledger[{id,at,kind,symbol,name,quantity,price,amount,fee,tax,source,instructionId,note}](최근 200), notes[…]}` — 표가 없으면 `available:false`.
- `POST /api/manual/isa/start` 본문 `{cash, startedAt?, buys:[{symbol, quantity, price}]}` → `{ok}`.
- `POST /api/manual/isa/ledger` 본문 `{id?, kind, symbol?, quantity?, price?, amount?, fee?, tax?, at?, note?, instructionId?}` — `id`가 있으면 수정, 없으면 추가 → `{ok, id}`.
- `POST /api/manual/isa/ledger/{id}/delete` → `{ok}`. `POST /api/manual/isa/instructions/{id}/skip` → `{ok}`.
- 오류 본문 `{ok:false, error, message}`(400 `invalid-request`·`ledger-invalid`, 404 `not-found`, 409 `already-started`·`not-started`). 장부 작업이라 비밀번호는 없다(Origin 검사는 기존 `SessionFilter`).
- `docs/API.md`·`RouteInventoryTest`·`scripts/qa/routes.json`(쓰기 경로 `"fuzz": false`)을 같은 커밋에.

## 6. 저장 — `db/migrations/V25__manual_accounts.sql`(백엔드 소유, ADR 0008)

- `manual_accounts`(code TEXT PK CHECK(code ~ '^[a-z0-9_]{1,20}$'), label, market CHECK(KR), source_book, state CHECK(ACTIVE·PAUSED), started_at, start_cash NUMERIC(20,2), version, created_at, updated_at)
- `manual_ledger`(id BIGSERIAL, account REFERENCES manual_accounts, at, kind CHECK, symbol(BUY·SELL·ADJUST면 `^[0-9][0-9A-Z]{5}$` 필수), quantity NUMERIC(20,6), price NUMERIC(20,4), amount NUMERIC(20,2)(입출금),
  fee·tax NUMERIC(20,2) DEFAULT 0, instruction_id BIGINT NULL, source CHECK(AUTO·USER), note, created_at, updated_at)
- `manual_instructions`(id BIGSERIAL, account, session DATE, symbol, side CHECK(BUY·SELL), quantity INTEGER CHECK(>0), ref_price NUMERIC, weight_pct NUMERIC, reason JSONB, status CHECK(PLANNED·RECORDED·SKIPPED·SUPERSEDED),
  notified_night_at, notified_morning_at, created_at, updated_at, UNIQUE(account, session, symbol))
- `manual_sessions`(account, session DATE, state CHECK(NONE·PLANNED·UNAVAILABLE), decision_id, created_at, PK(account, session)) — '지시 없음'·'못 만듦'을 기록해 같은 세션을 되풀이하지 않게.
- 다른 증권사 실제 계좌 자료라 **저장소·문서·커밋·QA 기록에 값을 넣지 않는다**. 오늘 시작 장부는 배포 뒤 서버에서 `POST /api/manual/isa/start`로 기록한다(마이그레이션 시드 없음).
  매일 S3 백업에 들어간다. QA 복원은 이 표들을 비운다(`RESTORE_REAL_TRADE=clear`와 같은 자리).

## 7. 패키지와 분리

- 백엔드는 `feature.realtrade` 안에 둔다(`RealTradePlanner`·`PaperMirrorService`·`PaperTelegram` 허용 범위를 그대로 씀): `ManualAccountService`·`ManualAccountController`·`ManualAccountJob`·`store.ManualAccountStore`.
  `ArchitectureRulesTest.realtradeIsIsolated` 허용 목록에 `store.ManualAccountStore`를 더한다. 토스 수집기(`CollectorTradeClient`)는 쓰지 않는다 — ISA는 증권사 호출이 없다.
- `PaperMirrorService`에 읽기 도우미 둘: `openPrices(session, tickers)`(시가 사다리), `lastPrices(tickers)`(직전 종가). 쓰기 없음.
- ISA 자료는 모의 장부·패킷·프롬프트·주간 복기·토스 실제 매매로 가지 않는다(방향은 모의 → ISA 한쪽).

## 8. 화면

- 한국 탭 줄 '실제 계좌' 옆 'ISA 계좌'(`/paper/kr/isa`). `PAPER_TABS`에 시장 제한 칸(`markets: ["KR"]`)을 더해 미국 탭 줄에는 없다(미국 `/paper/us/isa`는 개요로).
- 칸: 배너 "연결되지 않은 다른 증권사 계좌 — 이 화면과 텔레그램의 지시를 보고 직접 매매합니다(주문 기능 없음)", 요약(시작 현금·평가액·손익(부호·색)·현금), 보유 표(마지막 가격 평가·비중),
  **다음 시가 매매 지시**(세션·종목·방향·수량·상태·알림 시각, 행마다 '체결 고치기'·'건너뜀'), 장부 표('고치기'·'지우기'), '행 추가' 창, 시작 전이면 '시작' 창(시작 현금·시작 매수 목록 붙여 넣기).
- 화면 경계: ISA 모듈(`components/screens/isa/*`, `lib/isa.ts`, `lib/types/isa.ts`)을 밖에서 가져오는 곳은 `PaperScreen` 하나. apiPost는 `endpoints.isa.*`에만.

## 9. 시험(층별)
- 백엔드: 장부 계산(현금·보유·평가·손익, 음수 거부), 지시(비중→수량·임계값·책에 없는 보유 전량 매도·현금 확인·순서·목표 불완전이면 안 만듦·세션 한 번), 자동 기록(시가 사다리·사용자 입력 우선·시가 없음 대기),
  고침 뒤 재계산, 시작 한 번만, 알림(종목·수량만 — 금액 글자 없음, 밤·아침 한 번씩, 실패 재시도), 접근(회원 403·운영자 200), 분리(ArchitectureRulesTest).
- 화면: 탭은 KR만, 지시·고치기·추가·시작 창, 경계 시험, 이모지.

## 10. 적대적 리뷰 뒤 확정한 세부(2026-11-06)

앞 절과 다르면 이 절이 맞다.

- **시가가 다시 오지 않을 지시**: 그 세션에 거래가 없던(거래량 0·정지 — `PaperMirrorService.openUnfillable`, 사유 `halted`) 종목의 지시는 AUTO `SKIPPED`, 그 날이 거래일이 아니면(늦은 휴장 지정)
  그 세션 `PLANNED` 지시 모두 AUTO `SKIPPED`(`not-trading`). 매수는 '기다리는' 매도에만 묶인다.
- **처리 안 된 지난 지시**: 최신 세션보다 앞 세션의 `PLANNED` 지시는 응답 최상위 `pendingInstructions`(항목 = `instructions.items` 칸 + `session`)로 내려 화면에서 체결 고치기·건너뜀을 할 수 있다.
  `instructions`에 `open`(그 세션 개장 시각)·`reason`(세션 행 사유 코드)·`ledgerChanged`를 싣는다. 표가 없으면 `message`.
- **이중 기록 방지**: id 없이 `instructionId`를 준 새 행은 그 지시에 AUTO 행만 있으면 같은 트랜잭션에서 그 행을 지우고 USER 행으로 바꾸고(사용자 입력 우선), USER 행이 이미 있으면 409 `already-recorded`.
- **장부를 고친 뒤 다시 계산**: 장부 쓰기(추가·고침·삭제, 자동 기록 행을 지우는 건너뜀)가 다음 세션 S의 지시가 이미 있고 지금이 S 08:00(그 전에 개장하면 개장) 전이면 S의 묶인 행 없는 `PLANNED` 지시와
  세션 행을 지운다 → 정기 작업이 고친 장부로 다시 만들고 '…시가 매매 지시(다시 계산)' 알림을 보낸다(다시 계산했더니 지시가 없으면 '할 매매가 없습니다 — 앞서 보낸 지시는 내지 마세요' 한 통).
  08:00 뒤나 계좌가 멈춤이면 지우지 않고 `ledgerChanged=true`(화면 경고). 칸 `manual_accounts.recalc_session`·`manual_sessions.ledger_changed_at`.
- **시가 밖 시점 주문**: 규칙 계좌에 그 세션을 목표로 하는 시가 밖 시점(분 지정·매시·장중 시장가·종가) 대기 주문이 있으면 지시를 만들지 않는다(`timed-orders`, 개장 뒤 `UNAVAILABLE`) — ISA는 시가로만 지시한다.
- 시작에서 `startedAt`을 비우면 지금을 초 단위로 자른 시각. `account.startCash`는 장부의 시작 입금 행 합(시작 입금 행을 고치면 따라 바뀜). 화면 요약은 '순입금(시작 현금 포함)'(`summary.netDeposit`).
- 평가 가격은 밤 관측치 종가만(§1). 화면 안내의 동시호가 구간과 체결 고치기 기본 시각은 `instructions.open`에서(모르면 08:30~09:00·09:00).

## 11. 개장 10분 뒤 지시와 장중 스탑 지시(ADR 0033, 2026-11-07 구현 — 2026-11-07 배포)

앞 절과 다르면 이 절이 맞다. 시험 이름은 [ADR 0033](../adr/0033-real-isa-open-offset-and-stops.md). 새 API 경로는 없고 `GET /api/manual/isa`에 칸이 더해진다([API](../API.md)).

- **지시 시각**: 그 세션의 일일 맞추기 시각(`PaperMirrorService.dailySyncAt(kr_rules, E)` — 실제 매매와 같은 규칙, [실제 매매 명세](2026-11-06-real-trade-mirror.md) §13.1)이 있으면 지시는 '그 시각(보통 09:10) 이후 시장가'이고
  목표는 `targetsAt(kr_rules, E, T)`(그 시각까지의 모의 주문 반영)다. 없으면 지금의 시가 지시(§2) 그대로다. `manual_instructions`에 시각 칸이 없어 지시 근거와 세션 상세의 `targetAt`에 두고(마이그레이션 없음),
  응답 `instructions.targetAt`(시가 지시면 null)·항목 `targetAt`으로 내려 준다. 알림 글은 제목 'MM/DD(요일) HH:MM 매매 지시', 끝줄 'HH:MM 이후 시장가'다.
- **자동 기록**: 그 시각이 지난 뒤 그 시각의 1분봉 사다리 값(규칙 계좌 체결과 같은 값 — `PaperMirrorService.ladderPrices`)·장부 시각 T로 적는다. 그 시각의 1분봉 창이 없는 종목은 그 세션 시가로 어림한다(`autoNote: open-fallback`).
- **`timed-orders` 판정**(§10): STOP은 시가 날·시각 맞추기 날 모두 세지 않는다(스탑 지시가 따로 — 밤 대체 STOP이 지시를 막지 않게). 시각 맞추기 날에는 목표에 들지 않는 STOP이 아닌 시가 밖 규칙 주문만 센다.
- **장중 스탑 지시**(V28 `manual_stop_instructions` — 모의 STOP 주문 하나에 하나, UNIQUE(account, paper_order_id)):
  - 30초 주기(`dashboard.manual.stop-interval-ms`, 코드 기본 30000)가 08:30~17:00 KST에만 규칙 계좌의 오늘 STOP 매도(`MARKET`·`AT_MINUTE`·`NEXT_CLOSE`)를 보고 지시를 만든다. 나머지 일(지시·알림·자동 기록)은 10분 주기 그대로다.
  - 그날 지시 목표에 반영된 STOP은 세션 상세 `coveredStopOrderIds`에 적고 스탑 지시를 만들지 않는다. 수량 = ISA 장부 보유 + 지시 시각이 지난 아직 적지 않은 지시의 증감(0이면 만들지 않음).
  - 만들면 바로 텔레그램 한 통 — 제목 '[ISA 계좌] MM/DD(요일) 스탑 매도 지시' / 줄마다 '매도 <코드> <이름> <수량>주' / 장중 STOP이면 '지금 시장가로 매도하세요(개장 10분 전이면 09:10 이후)'
    (장 시간 변경일은 그날 개장 + 10분), 종가 STOP(15:20 뒤 감지)이면 '종가 단일가(15:20~15:30)에 시장가로 매도하세요'(마감이 늦은 날은 그날 마감에서 셈). **종목 코드·이름·수량만 — 금액·평가액 없음.** 실패하면 다음 주기에 다시, 그 세션 마감까지 못 알리면
    `SKIPPED`(`not-notified`) — 장부에 적지 않고 다음 지시를 막지 않는다.
  - 자동 기록: 알린 지시는 그 세션 앞 지시가 적힌 뒤 그 모의 STOP 주문과 같은 사다리 값·기준 시각으로 적는다(`manual_ledger.stop_instruction_id` — 한 행은 다음 지시와 스탑 지시 가운데 하나에만 묶임).
    창이 없으면 그 세션 종가로 어림(`close-fallback`), 다음 날 07:00 KST까지 값을 못 구하면(모의 주문이 지워짐 등) `SKIPPED`(`no-price`).
  - 앞 세션에 알린 스탑 지시가 아직 적히지 않았으면 다음 지시를 만들지 않는다(`record-pending` — 같은 종목을 두 번 팔라고 하지 않게).
  - 사용자 고침은 자동 기록 행을 장부에서 고친다(스탑 지시 묶음은 지우지 않음). 화면은 '장중 스탑 매도 지시' 표(최근 30 — 종목·수량·방식·기준 시각·상태·알림 시각·메모, 금액 칸 없음, 누를 수 없음)다.
- **복원**: 멈춤 방식(기본)은 오늘(KST)까지의 `PLANNED` 스탑 지시를 `SKIPPED`(`restored`)로 닫고(이미 알린 스탑을 다시 알리지 않게), QA 복원(비움)은 스탑 지시 표도 비운다(계좌 삭제 CASCADE).
