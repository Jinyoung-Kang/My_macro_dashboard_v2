# 설계 — 토스증권 실제 계좌가 모의 책을 따라 하는 실제 매매(한국 원화)

- 상태: **확정**(2026-11-06 사용자 승인). 결정 기록은 [ADR 0028](../adr/0028-real-trade-mirror.md). 이 문서는 수집기·백엔드·화면이 함께 따르는 **계약**이다.
  개장 10분 뒤 시각 맞추기와 장중 스탑 매도([ADR 0033](../adr/0033-real-isa-open-offset-and-stops.md), 2026-11-07 배포)는 §13 — 앞 절과 다르면 §13이 맞다.
- 사용자 요청: "모의 알고리즘 매매(한국)의 메커니즘에 따라 나의 실제 토스 계좌의 원화 자산을 운용·매매. 실제 계좌 요약의 '다시 읽기' 옆에 매매 켜기/끄기. [규칙 계좌,
  Claude 계좌1, Claude 계좌2] 중 고른 방식으로. 달러 자산은 나중 — 가능성만." 수정: 처음 방식은 Claude 계좌2 → 같은 날 다시 수정: **켜기 창 기본 방식은 규칙 계좌**(커밋·배포 전에 되돌림 — 셋 중 고르는 기능은 그대로).
- 사용자 결정(2026-11-06): ① 운용 범위 **원화 자산 전부** ② **바로 실제 주문**(미리보기·소액 시험 단계 없음) ③ 켜기류는 **확인 글자 + 운영자 비밀번호** ④ 텔레그램은 **건수·상태만**.
- 모의 책과의 관계: 모의 책은 지금처럼 주문을 내지 않는다(모의 프롬프트·패킷·화면 문구 그대로 — 실험 조건). 실제 계좌가 그 책을 **따라 할지**는 운영자의 별도 결정이고,
  실제 계좌 자료는 모의 장부·패킷·프롬프트·복기에 들어가지 않는다(방향은 모의 → 실제 한쪽뿐).

## 0. 용어

| 말 | 뜻 |
|---|---|
| 따라 하는 책 | `kr_rules`·`kr_claude`·`kr_claude2` 중 운영자가 고른 하나(`source_book`) |
| 운용 평가액 E | min(원화 매수 가능 금액 + 국내(KR·KRW) 보유 전부의 평가액, `TOSS_TRADING_MAX_EQUITY_KRW`) — 매번 토스에서 새로 읽은 값 |
| 시가 맞추기(SYNC) | 매일 시가 단일가 창에서 실제 보유를 '책의 시가 뒤 예상 비중'에 맞추는 묶음 |
| 시가 뒤 마무리(SYNC_FOLLOWUP) | 정규장 시작 뒤 09:30까지, 시가 맞추기에서 못 맞춘 차이(거절·미체결·매도 대금이 필요했던 매수)를 시장가로 메우는 것 |
| 장중 따라 하기(MIRROR) | 책의 장중 시점 주문(`AT_MINUTE`·`AT_hh00`·`MARKET`·`NEXT_CLOSE`)을 그 기준 시각에 따라 하는 것 |
| 선점(claim) | 장부 잠금 안에서 모의 주문이 아직 PENDING이고 기준 시각이 지났음을 확인하고 실제 주문 행을 쓰는 것 |

## 1. 상태와 스위치

- **세 스위치**가 모두 켜져야 주문이 나간다.
  1. 수집기 `TOSS_TRADING_ENABLED` — 환경변수가 strip 뒤 정확히 `true`, 그리고 `TOSS_ACCOUNT_ENABLED`도 `true`, 서비스 토큰(`COLLECTOR_API_TOKEN`)이 있고, 한도 네 값이 모두 맞을 때만.
  2. 백엔드 `REAL_TRADE_ENABLED` → `dashboard.realtrade.enabled`(기본 false).
  3. 화면 스위치 = `real_trade_config.state = 'LIVE'`.
- 1·2는 기반 `docker-compose.yml`에 **보간 없는 `"false"`**(로컬 `.env`·셸 값이 끼어들 수 없음, QA 덧붙임도 그대로 false), `compose.vultr.yml`만 서버 `.env` 값을 넘긴다
  (`TOSS_ACCOUNT_ENABLED` 선례). 백엔드 환경에는 `TOSS_*`가 없고 수집기 환경에는 `REAL_TRADE_ENABLED`가 없다. CI `images` 잡이 단언한다.
- 한도 네 값(수집기 환경, 서버 `.env`): `TOSS_TRADING_MAX_ORDER_KRW`(1건, 1 이상 99,999,999 이하), `TOSS_TRADING_MAX_ORDERS_PER_DAY`(1~200), `TOSS_TRADING_MAX_BUY_KRW_PER_DAY`(1 이상),
  `TOSS_TRADING_MAX_EQUITY_KRW`(1 이상). 하나라도 없거나 정수가 아니거나 범위 밖이면 매매는 꺼짐(`reason: "limits-invalid"`).
- **상태 기계**(`real_trade_config.state`, 시장별 한 행)

| 상태 | 뜻 | 새 주문 | 들어가는 길 |
|---|---|---|---|
| `OFF` | 꺼짐 | 없음 | 처음, 끄기 뒤 미체결 정리가 끝남 |
| `LIVE` | 켜짐 | 있음(손실 한도에 걸리면 매수만 멈춤 — `buys_paused`) | 켜기(확인 글자 + 비밀번호) |
| `HALTED` | 이상 멈춤 | 없음(이 기능의 미체결은 취소) | 이상 멈춤 사유 발생, 복원 직후 |
| `STOPPING` | 끄는 중 | 없음 | 끄기 — 이 기능의 미체결 취소 결과를 기다림 → 끝나면 `OFF` |

- 전이: `OFF→LIVE`(enable), `LIVE→STOPPING→OFF`(disable), `LIVE→HALTED`(자동), `HALTED→LIVE`(resume, 확인 글자 + 비밀번호), `HALTED→STOPPING→OFF`(disable), `LIVE→LIVE`(update — 방식·손실 한도·기준).
  끄기는 어떤 상태에서도 즉시(확인 글자·비밀번호 없음).
- **잠금**: 백엔드는 `real_trade_config` 행을 `SELECT … FOR UPDATE`로 잡고 '상태가 LIVE이고 버전이 읽은 값과 같음 + SENDING 행 삽입'을 한 트랜잭션에서 한다. 끄기가 커밋된 뒤에는 새 SENDING이 생길 수 없다.

## 2. 무엇을 사고파나 — 원화 자산 전부

- 운용 평가액 E = min(`cashBuyingPower`(KRW) + Σ 국내 보유 수량 × 현재가, 안전 상한). 상한을 넘는 부분은 현금으로 둔다.
- **목표 수량**(종목 t, 비중 w_t는 책의 예상 상태에서 그 종목 평가액 ÷ 책 순자산): `target_t = floor(w_t × E ÷ 기준가_t)`.
  **보낼 수량** = `target_t − 실제 보유_t − (토스 OPEN 목록의 그 종목 같은 방향 미체결 수량 — 앱 주문 포함)`. 양수면 매수, 음수면 매도.
  매도는 `sellableQuantity`·정수 보유를 넘지 않는다(국내 소수점 보유의 소수 부분은 팔 수 없어 건너뜀 — 표시).
- **책에 없는 국내 보유는 목표 0**(시가 맞추기에서 판다). 켜기 창이 '팔 종목·살 종목 예상 목록'을 보이고 확인받는다.
- 그 종목에 **반대 방향 미체결**(앱 주문 포함)이 있으면 그 종목은 건너뛴다(토스 409) — `skipped`(사유 `opposite-pending`), 알림. 사용자 주문을 취소하지 않는다.
- 그 종목에 **이 기능이 낸 주문 중 종료가 확인 안 된 것**(SENDING·UNKNOWN·ACCEPTED·PENDING·PARTIAL_FILLED)이 있으면 새 주문 금지.
- 매수 금액 확인: `수량 × upperLimitPrice ≤ 지금 매수 가능 금액 − 같은 창에서 이미 낸 매수의 상한가 합`. 모자라면 수량을 줄이고, 1주도 안 되면 그 창에서 미룬다(`deferred-cash`).
- 1건 상한(`TOSS_TRADING_MAX_ORDER_KRW`)을 넘으면 쪼개지 않고 상한까지만 보내며(매도는 floor(상한 ÷ (현재가 × 1.03)) — 수집기가 보내기 직전 현재가로 다시 잼) 나머지는 `capped`(다음 시가 맞추기가 다시 시도).
- 수집기 하루 한도(건수·매수 금액)는 계획이 미리 지킨다 — §12.1.

## 3. 언제 — 창은 그날 토스 장 운영 정보로

- 수집기가 `GET /api/v1/market-calendar/KR`의 `today.integrated`를 정리해 준다(§5.2). 백엔드는 그날 첫 창 전에 받아 두고 하루 동안 쓴다(실패하면 다시).
- 그날을 **쉬는** 경우(아무것도 보내지 않고 이벤트·알림): `integrated` 또는 `regularMarket`이 null(휴장), 토스 정규장 시작·끝이 모의 달력(`PaperMirrorService.sessionHours`)과 다름
  (예: 2026-11-19 수능 10:00~16:30인데 모의 `kr.calendar.openTimeOverrides`가 없음), 토스 응답 시각과 서버 시각 차이 > 5초, 모의 장부가 전 거래일을 아직 반영하지 않음(`ledgerCaughtUp=false`).
- 알림 없이 지나가지 않게 하는 것(QA-342, 2026-11-12 — 주문 동작은 그대로):
  - 휴장은 평소 일이라 알리지 않지만, **모의 달력이 거래일인데 토스만 휴장이라 답한 날**의 쉼 이벤트(`SKIP_DAY` `market-closed`, detail `paperOpen: true`)는 알린다.
  - 켜짐인데 **토스 장 운영 정보를 받지 못하거나**(`calendar-unavailable`) **수집기 매매 상태를 읽지 못하는**(`status-unavailable`) 끊김이 **3분 이어지고**,
    지금이 모의 달력의 그날 [개장 − 3분, 마감) 안이면 이벤트 `UNAVAILABLE`(사유 코드·날짜·알린 시각만)을 남기고 알린다. 멈춤이 아니고 재시도는 계속한다(받는 대로 이어 감).
    **개정(QA-342 보완, 2026-11-12 사용자 승인 — 알림 시점만 바뀜, 주문 동작은 그대로)**: 예전에는 첫 실패 주기에 바로, 사유마다 하루 한 번 알렸다 — 장중 배포로
    수집기가 10~30초 다시 뜨는 동안에도 알림이 가고, 그 한 번을 쓴 뒤의 긴 끊김은 알리지 못했다. 이제
    - 끊김은 사유마다 따로 잰다(처음 본 주기부터). 3분이 되기 전에 그 사유 없이 한 주기를 지나면 알리지 않는다. 밤새 이어진 끊김은 개장 3분 전 첫 주기에 알린다(예전과 같은 때).
    - 알린 끊김은 이어지는 동안 다시 알리지 않는다. 회복(그 사유 없이 한 주기)하면 표시를 지워, 다시 끊겨 3분 이어지면 다시 알린다.
    - 같은 사유의 알림은 30분에 한 번까지다 — 그 안에 다시 끊긴 것은 30분이 지나도 이어지고 있을 때 알린다.
    - 켜짐이 아닌 동안(끄는 중·꺼짐·이상 멈춤)은 끊김을 세지 않는다(다시 켜면 그때부터).
    - 다시 띄운 작업은 끊김을 그때부터 다시 재고(메모리), 30분 간격은 그날 이벤트의 알린 시각(`noticedAt`, 없으면 이벤트 시각)에서 이어 센다 — 다시 띄운 뒤에도
      끊김이 3분 이어지고 앞 알림부터 30분이 지났으면 한 번 더 알린다(배포 뒤 수집기가 올라오지 못한 경우).
  - 장 운영 정보에 종가 단일가 시각이 없어 장중·종가 창이 통째로 없는 날, 따라 하지 못한 스탑은 `STOP_SELL` 놓침으로, 장중·종가 주문은 마감 3분 뒤 창 요약(`MIRROR`)의 놓침으로 센다.

| 경로 | 주문 | 창 | 한 번 |
|---|---|---|---|
| 시가 맞추기 SYNC | MARKET + `OPG` | [`preMarket.singlePriceAuctionStartTime` + 30초, `preMarket.endTime` − 90초] (보통 08:50:30~08:58:30) | 하루 한 묶음(`real_trade_batches` 유일) |
| 시가 뒤 마무리 SYNC_FOLLOWUP | MARKET + `DAY` | [`regularMarket.startTime` + 30초, 그날 09:30 KST(장 시간 변경일은 시작 + 30분)] | 묶음의 종목마다, 그 종목의 이 기능 주문이 모두 종료 확인된 뒤 |
| 장중 따라 하기 MIRROR(`AT_MINUTE`·`AT_hh00`·`MARKET`) | MARKET + `DAY` | [T, min(T + 3분, `regularMarket.singlePriceAuctionStartTime` − 30초)] | 모의 주문(뿌리 번호)마다 |
| 장중 따라 하기 MIRROR(`NEXT_CLOSE`) | MARKET + `DAY` | [`regularMarket.singlePriceAuctionStartTime` + 30초, `regularMarket.endTime` − 120초] | 모의 주문마다 |
| 시각 맞추기 SYNC_AT(§13 — 따라 하는 책이 개장 10분 뒤 지정 시각인 날, 그날은 SYNC·SYNC_FOLLOWUP 대신) | MARKET + `DAY` | [max(T, `regularMarket.startTime` + 30초), min(T + 3분, 장중 끝)] (보통 09:10~09:13) | 하루 한 묶음 |
| 스탑 매도(§13 — 따라 하는 책의 시각 지정 STOP) | MARKET + `DAY` | [max(T, 장중 시작, 정규장 시작 + 10분), min(시작 + 3분, 장중 끝)], 종가 STOP은 종가 창 | 모의 STOP 주문(뿌리)마다 최대 2회 |

- 단일가 시각이 null이면 그 경로는 그날 쓰지 않는다(SYNC가 없으면 SYNC_FOLLOWUP이 정규장에서 같은 계산을 한다 — 이때는 회전율 한도 적용).
- 창을 놓치면 `missed`로 기록(다음 시가 맞추기가 메움). 수집기도 창 밖(정규장 시작 + 30초 전의 DAY, 프리마켓 단일가 창 밖의 OPG, 정규장 끝 뒤) 주문을 네트워크 전에 거부한다.
- 한 창 안 순서: 매도 → 매수(같은 묶음 안에서는 현금성 `153130`·`kr.cashLikeTickers`를 매수 마지막·매도 처음).

### 3.1 시가 맞추기의 목표
- `PaperMirrorService.openTargets(book, session)` — 책의 보유 + **그 세션 시가가 기준 시각인 모든 PENDING 주문**(출처 CLAUDE·RULE·STOP·INITIAL 모두)을 마지막 가격으로
  `ExpectedState.simulate` 한 결과의 비중(종목별 %)과 흡수한 모의 주문 번호들. 그 주문들은 MIRROR로 따로 따라 하지 않는다.
- 차이가 **1주 이상이고 |차이 금액| ≥ E의 1%** 일 때만 주문(책에 없는 보유는 1% 조건 없이 전량).
- 회전율 한도: 한 SYNC 묶음의 매수 + 매도 금액 합이 E의 60%를 넘으면 그 묶음을 보내지 않고 이상 멈춤(`turnover`) — 단 `sync_pending`을 켠 마지막 일(ENABLE·책을 바꾼 UPDATE·HALTED에서의 RESUME) 뒤 **첫 묶음**은 예외(켜기 창에서 확인). 남은 몫으로 `sync_pending`이 이어진 2·3번째 묶음은
  목표 변화량 Σ|w_now − w_prev|(바로 앞 SYNC 묶음 목표, 합집합 종목, 없는 종목 0%)가 60% 이하일 때만 예외이고, 넘으면 `turnover` 이상 멈춤(detail `turnoverPct`·`targetDriftPct`, 묶음·주문 없음). `sync_pending`을 끄는 때는 §12.2.

### 3.2 장중 따라 하기의 목표
- 대상: 따라 하는 책의 PENDING 주문 중 목표 세션 = 오늘, timing ∈ {`AT_MINUTE`, `AT_1000`…`AT_1500`, `MARKET`, `NEXT_CLOSE`}, 기준 시각 T ≤ 지금. 그 밖의 timing(모르는 값)은 보내지 않고 `skipped`(`timing-unsupported`)·알림.
- `PaperMirrorService.weightAfter(book, orderId, now)` — 책의 보유 + 기준 시각이 T 이하인 모든 PENDING 주문(시가 포함)을 `KrExpectedState`와 같은 가격 고르기로 simulate 한 뒤 그 종목의 비중 w*.
- 보낼 수량 = §2의 식을 w*로, **원 주문 방향으로만**(매수 주문이면 양수일 때만 매수, 매도 주문이면 음수일 때만 매도). 1%p 조건은 없고 1주 이상이면 보냄. w* = 0인 매도는 전량.
- 같은 뿌리(`reason.reissuedFrom` 사슬의 첫 주문)는 한 번만 따라 한다.

### 3.3 선점
- `PaperMirrorService.claim(book, orderId, now, insert)` — `PaperLedgerService.exclusively` 안에서 그 주문을 다시 읽어 PENDING이고 `now ≥ T`일 때만 `insert`(함수형 인자, 실제 주문 행을 SENDING으로 씀)를 부른다.
  paper는 realtrade 타입을 모른다(원시 값 인자 + `Supplier`). 토스 호출은 잠금 밖. 장중 교체는 같은 잠금 안에서 '기준 시각 > now'만 취소하므로 선점한 주문을 취소하지 않는다.

## 4. 멱등·결과 분류·장애 복구

- `client_order_id` = SENDING 행을 쓸 때 만든 UUID(36자, 토스 패턴 `^[a-zA-Z0-9\-_]+$`), 요청 본문 JSON(바이트 그대로)을 행에 저장한다.
- 수집기 `POST /toss/trading/orders`의 `outcome`:

| outcome | 뜻 | 예 | 백엔드 처리 |
|---|---|---|---|
| `ACCEPTED` | 토스가 주문을 받음(`orderId`) | 200 | 행에 orderId 저장, 상태 추적 |
| `REJECTED` | 주문이 생기지 않았음이 확실 | 400(모든 invalid-request·confirm-high-value-required·account-header-required), 401 뒤 재시도도 401, 403, 404, 409 `opposite-pending-order-exists`, 422(`idempotency-key-conflict` 제외) | 시도 종료. 사유 코드 기록 |
| `UNKNOWN` | 주문이 생겼는지 모름 | 읽기 시간 초과, 연결 뒤 끊김, 5xx 전부(`maintenance` 포함), 409 `request-in-progress`, 3xx, 응답 해석 실패 | 같은 키·같은 바이트로만 재전송(아래) |
| `NOT_SENT` | 네트워크로 나가지 않았음이 확실 | 수집기 검사 거부(창 밖·한도·형식), 가드, 연결 실패(ConnectTimeout·연결 거부), 토큰 발급 실패 | 시도 종료. 사유 코드 기록 |

- 422 `idempotency-key-conflict`는 `UNKNOWN`이면서 즉시 이상 멈춤(`idempotency-conflict`). 429는 `REJECTED`(`rate-limited`)지만 '같은 오류 3회'에 세지 않는다.
- **재전송**: `UNKNOWN`인 행은 `first_sent_at + 7분`까지만 같은 키·저장한 바이트 그대로 다시 보낸다(수량·가격을 다시 계산하지 않음). 그 뒤에는 POST 없이 **대조**: 토스 OPEN 목록과 오늘 CLOSED 목록에서
  같은 종목·방향·수량·`MARKET`·같은 TIF, `orderedAt ∈ [first_sent_at − 5초, first_sent_at + 7분 + 30초]`(뒤쪽 30초는 QA-343 — 창 끝 직전에 받은 재전송의 POST가 수집기 주문 예산 20초 안에서 창 끝을 넘겨 출발할 수 있음. 대조는 `first_sent_at + 7분 + 45초` 뒤에 시작), 다른 행에 묶이지 않은 후보가 **정확히 하나**면 그 orderId로 묶고, 아니면 이상 멈춤(`unknown-order`).
- 새 키(시도 2)는 앞 시도가 `REJECTED`·`NOT_SENT`이거나 종료 상태와 체결 수량이 확인된 뒤에만, 남은 수량만, 원 주문(또는 묶음의 종목)당 최대 2회.
- 수집기 안의 재시도는 401(재발급 대상 코드) 뒤 같은 키로 한 번뿐이다. 그 밖의 재시도는 백엔드 한 곳에서만.
- 상태 추적: 매 주기 `GET /toss/trading/orders/open` 한 번(전량) + OPEN에서 빠진 이 기능 주문만 `GET /toss/trading/orders/{orderId}` 한 번씩. 종료 상태(`FILLED`·`CANCELED`·`REJECTED`·`REPLACED`)와
  `execution`(체결 수량·평균가·금액·수수료·세금·체결 시각)을 행에 기록. 모르는 상태 코드는 종료로 보지 않고 기록·알림.
- 취소: `POST /toss/trading/orders/{orderId}/cancel` → 원 주문을 `PENDING_CANCEL` → `CANCELED`/`FILLED`까지 따라감. `CANCEL_REJECTED`면 원 주문이 살아 있음. 다시 보내지 않는 끝난 거절과 재시도 규칙은 §12.3.

## 5. 수집기 계약

### 5.1 쓰기 세션과 가드
- 새 `collector/app/services/toss_trade.py`. 세션 이름 `toss_trade`(`http.get_api_session("toss_trade", adapter_class=_TradeWriteAdapter)`), `trust_env=False`. 공유 `toss` 세션·`_ReadOnlyAdapter`·기존 시험은 그대로.
- `_TradeWriteAdapter.send`는 네트워크 전에 검사하고 통과할 때만 `super().send`: 메서드 POST, scheme `https`, 호스트 = `toss._HOST`, 포트 None/443, userinfo·query·fragment 없음,
  경로 fullmatch `^/api/v1/orders$` 또는 `^/api/v1/orders/[A-Za-z0-9_-]{1,128}/cancel$`, `%`·`..` 없음. 그 밖은 `TossTradeViolation`. 쓰기 호출은 늘 `allow_redirects=False`.
- 플래그(§1의 1)가 꺼져 있으면 세션을 만들지 않는다. 호스트 글자는 `toss.BASE_URL`·`toss._HOST`를 가져다 쓴다(이 모듈에 호스트 글자를 쓰지 않음).
- 읽기(보유·매수 가능·매도 가능·현재가·상한가·주문 조회·장 운영 정보)는 공유 읽기 세션 `toss._authorized_get(toss._http(), …)`로 한다. 계좌 seq는 `toss_account.account_seq()`(새 공개 함수 — 잠금·단일 실행,
  BROKERAGE 계좌가 정확히 하나일 때만, 캐시 재사용, `account-not-found`면 다시 찾음).
- 토큰: `toss.get_access_token()`·`_invalidate_token` 공유. 401은 `expired-token`·`token-revoked`·`invalid-token`일 때만 재발급(계좌 모듈과 같은 10분 1회 창 공유), 같은 키로 한 번 재전송.
  10분 안에 `token-revoked`를 2번 넘게 보면 상태 응답에 `tokenContention: true`(백엔드가 이상 멈춤). 백엔드는 각 창 3분 전에 `POST /toss/trading/warmup`을 불러 토큰 남은 시간이 30분 미만이면 미리 재발급하게 한다.
- 호출 한도: 계좌·매매 모듈이 함께 쓰는 그룹별 토큰 버킷 — ORDER ≤ 5/초, ORDER_HISTORY ≤ 3/초, ORDER_INFO ≤ 2/초, ASSET ≤ 3/초, MARKET_DATA ≤ 8/초. 기다림은 요청당 최대 3초, 넘으면 `rate-limited`.

### 5.2 경로(모두 `X-Service-Token`, 빈 토큰이면 403 없이 `{"ok": false, "enabled": false, "reason": "no-service-token"}`)
- `GET /toss/trading/status` → `{"ok": true, "enabled": bool, "reason": str|null, "limits": {"maxOrderKrw", "maxOrdersPerDay", "maxBuyKrwPerDay", "maxEquityKrw"}|null, "tokenContention": bool, "serverTime": ISO}`.
  꺼져 있으면 `enabled:false`와 사유(`disabled`·`account-disabled`·`no-service-token`·`limits-invalid`).
- `GET /toss/trading/calendar` → `{"ok", "date", "skewSeconds": float|null, "today": {"preMarket": {"start","auctionStart","end"}|null, "regular": {"start","closingAuctionStart","end"}|null}|null, "previousBusinessDay": date, "nextBusinessDay": date}`
  (`skewSeconds` = 토스 응답 `Date` 헤더 − 서버 시각, 헤더 없으면 null). KST 날짜마다 캐시, 실패는 캐시하지 않음.
- `POST /toss/trading/warmup` → `{"ok", "tokenRefreshed": bool}`.
- `GET /toss/trading/preflight?symbols=a,b&sell=c,d` → 캐시 없이 새로: `{"ok", "fetchedAt", "cashBuyingPowerKrw": "decimal", "holdings": [{"symbol", "name", "quantity": "decimal", "lastPrice": "decimal"}](KR·KRW 전부),
  "quotes": {sym: {"lastPrice", "upperLimitPrice", "lowerLimitPrice"}}(symbols ∪ 보유 종목), "sellable": {sym: "decimal"}(sell 목록만)}`. 하나라도 실패하면 `{"ok": false, "reason"}`(부분 값 없음).
- `POST /toss/trading/orders` 본문 `{"clientOrderId", "symbol", "side", "timeInForce", "quantity", "firstSentAt"}` → `{"outcome", "orderId"?, "code"?, "httpStatus"?}`.
  수집기 검사(통과 못 하면 `NOT_SENT`와 code): 매매 켜짐, 종목 `^[0-9][0-9A-Z]{5}$`, side `BUY`·`SELL`, TIF `DAY`·`OPG`, 수량 `^[1-9][0-9]{0,8}$`, clientOrderId 36자 패턴, `firstSentAt` + 7분 안,
  창(§3 — 수집기가 자기 달력으로 다시 확인), 1건 금액(매수 = 상한가 × 수량, 매도 = 현재가 × 수량 — 수집기가 직접 받은 값) ≤ 1건 상한, 오늘(KST) 국내 주문 수 < 하루 건수 상한과
  오늘 국내 매수 금액 합(체결 금액 + 미체결 수량 × 상한가) + 이번 매수 ≤ 하루 매수 상한 — **토스 OPEN·오늘 CLOSED 목록에서 세고(앱 주문 포함) 조회가 실패하면 보내지 않음**.
  보내는 본문은 `{"clientOrderId","symbol","side","orderType":"MARKET","timeInForce","quantity"}` 뿐(`price`·`confirmHighValueOrder` 없음).
- `POST /toss/trading/orders/{orderId}/cancel` → `{"outcome", "cancelOrderId"?, "code"?}`(orderId는 경로 정규식 검사, 틀리면 `NOT_SENT`).
- `GET /toss/trading/orders/open` → `{"ok", "orders": [정리된 주문]}`, `GET /toss/trading/orders/today` → 오늘 OPEN + CLOSED(국내), `GET /toss/trading/orders/{orderId}` → `{"ok", "order"}`.
  정리된 주문 = `{"orderId","symbol","side","orderType","timeInForce","status","quantity","filledQuantity","averageFilledPrice","filledAmount","commission","tax","orderedAt","canceledAt","filledAt","currency"}`
  (모르는 칸은 버림, decimal은 문자열 그대로). 이 경로들은 백엔드 전용 — 백엔드는 orderId를 DB에만 둔다.
- 로그·응답에 계좌번호·accountSeq·토스 오류 `message`·응답 본문을 싣지 않는다. 오류 code는 `^[a-z0-9-]{1,40}$`일 때만. 예상 못 한 예외는 클래스 이름만.

## 6. DB — `db/migrations/V24__real_trade.sql`(백엔드 소유, ADR 0008)

- `real_trade_config`: `market TEXT PK CHECK(market IN ('KR','US'))`, `state TEXT NOT NULL CHECK(IN 'OFF','LIVE','HALTED','STOPPING')`, `source_book TEXT`, `book_generation TEXT`(책 `startedOn`·`createdAt`),
  `loss_limit_pct NUMERIC(5,2) NOT NULL DEFAULT 15 CHECK(1~50)`, `baseline_equity NUMERIC(20,2)`, `buys_paused BOOLEAN NOT NULL DEFAULT false`, `sync_pending BOOLEAN NOT NULL DEFAULT false`,
  `halt_reason TEXT`, `halt_detail JSONB`, `version INTEGER NOT NULL DEFAULT 0`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_by BIGINT`.
- `real_trade_events`: `id BIGSERIAL PK`, `market`, `at TIMESTAMPTZ DEFAULT now()`, `kind TEXT`(ENABLE·DISABLE·UPDATE·RESUME·HALT·BUYS_PAUSED·SKIP_DAY·WINDOW_SUMMARY·PASSWORD_FAILED·RESTORED …), `user_id BIGINT NULL`,
  `detail JSONB`(사유 코드·건수 — 종목·금액은 넣어도 되지만 알림 글에는 쓰지 않음), `notify BOOLEAN NOT NULL DEFAULT false`, `notified_at TIMESTAMPTZ NULL`.
- `real_trade_batches`: `id BIGSERIAL PK`, `market`, `session DATE`, `kind TEXT CHECK(IN 'SYNC')`, `source_book`, `targets JSONB`(종목 → 비중 — 비중 0은 묶음을 만들 때의 전량 매도 대상 표시, §12.2 QA-376), `absorbed_order_ids BIGINT[]`, `equity NUMERIC`, `created_at`, `UNIQUE(market, session, kind)`.
- `real_trade_orders`: `id BIGSERIAL PK`, `market`, `session DATE`, `purpose TEXT CHECK(IN 'SYNC','SYNC_FOLLOWUP','MIRROR')`, `batch_id BIGINT NULL REFERENCES real_trade_batches`, `source_book`, `book_generation`,
  `paper_order_id BIGINT NULL`, `paper_root_order_id BIGINT NULL`(FK 없음 — 모의 리셋이 막히지 않게), `symbol`, `side`, `quantity INTEGER`, `time_in_force`, `ref_price NUMERIC`, `attempt SMALLINT NOT NULL DEFAULT 1`,
  `client_order_id TEXT NOT NULL UNIQUE`, `request_body TEXT NOT NULL`, `send_outcome TEXT NOT NULL CHECK(IN 'SENDING','ACCEPTED','REJECTED','UNKNOWN','NOT_SENT')`, `outcome_code TEXT`,
  `toss_order_id TEXT`, `broker_status TEXT`, `terminal BOOLEAN NOT NULL DEFAULT false`, `filled_quantity NUMERIC`, `average_filled_price NUMERIC`, `filled_amount NUMERIC`, `commission NUMERIC`, `tax NUMERIC`,
  `filled_at TIMESTAMPTZ`, `first_sent_at`, `last_sent_at`, `send_count SMALLINT NOT NULL DEFAULT 0`, `cancel_requested_at`, `cancel_outcome TEXT`, `created_at`, `updated_at`.
  유일: `(market, paper_root_order_id, purpose, attempt) WHERE paper_root_order_id IS NOT NULL`, `(batch_id, symbol, purpose, attempt) WHERE batch_id IS NOT NULL`.
- 놓침·건너뜀은 주문 행이 아니라 이벤트(`WINDOW_SUMMARY`의 detail)로 남긴다.
- `real_trade_valuation`(V29, 2026-11-08): `market TEXT PK`, `fetched_at TIMESTAMPTZ NOT NULL`, `equity NUMERIC(20,2) NOT NULL`(E — 안전 상한 적용), `total NUMERIC(20,2)`(상한 없는
  총액), `cash_buying_power NUMERIC(20,2)`, `updated_at`. 정기 작업이 사전 조회 때마다 바꾸고(읽은 시각이 지금 행보다 이르면 덮지 않음) 재기동 뒤 상태 응답의 `lastPreflight`로
  되살린다. 마지막 거래일 마감 + 10분 뒤 값이 없으면 거래일 장중(개장 30분 전 ~ 마감 10분 뒤)이 아닐 때 15분마다 읽기 전용 사전 조회(매도 가능 수량 없음)를 한 번 시도 —
  끄는 중·이상 멈춤이면 하지 않고 실패는 로그만. 보유·계좌 식별자는 두지 않는다. 주문·손실 판정은 이 표를 읽지 않는다. QA 복원은 비운다.

## 7. 백엔드 계약

### 7.1 패키지와 의존
- `feature.paper.PaperMirrorService`(public, 공개 메서드 인자는 원시 값·`Supplier`만, PaperStore 쓰기 메서드를 부르지 않음): `book(code)`(상태·세대·시장), `sessionHours(date)`(모의 KR 달력의 개장·마감, 모르면 empty),
  `ledgerCaughtUp(code, session)`, `openTargets(code, session)`, `dueOrders(code, session, now)`, `weightAfter(code, orderId, now)`, `orderStatus(code, orderId)`, `rootOf(code, orderId)`, `claim(code, orderId, now, Supplier<T>)`.
  읽기는 `PaperMarkets.open`(`StoreReader.quietly`)을 거친다.
- `feature.realtrade`: `RealTradeController`, `RealTradeService`(API·상태 전이·비밀번호), `RealTradeJob`(전용 단일 스레드 스케줄러, 10초 주기, `dashboard.realtrade.enabled`가 false면 아무것도 안 함),
  `RealTradePlanner`(순수 계산 — 목표·차이·순서·창·임계값·회전율), `RealTradeExecutor`(SENDING·전송·결과·재전송·대조·추적·취소), 레코드들.
- `store.RealTradeStore`(JDBC는 여기만, `SchemaCheck`로 준비 여부), `collector.CollectorTradeClient`(새 클래스 — 예외 종류 보존: 연결 실패 = `NOT_SENT`, 읽기 시간 초과 = `UNKNOWN`; 주문 읽기 시간 초과 25초).
- `ArchitectureRulesTest.realtradeIsIsolated`: feature.realtrade 밖의 어떤 패키지도 `feature.realtrade`·`store.RealTradeStore`·`collector.CollectorTradeClient`를 참조하지 않는다. realtrade가 쓰는 우리 패키지는
  자기 패키지·`store.RealTradeStore`·`collector.CollectorTradeClient`·`feature.paper.PaperMirrorService`(와 그 중첩 record)·`feature.paper.PaperTelegram`·`feature.auth.AuthService`·config·support·`Kst`·analytics만.
  brokerage 고립 규칙·시험은 그대로.
- `AuthService.verify(현재 운영자 이메일, 비밀번호)`로 비밀번호 확인. 연속 5회 틀리면 30분 동안 켜기류를 거절(`password-locked`). 틀림은 `PASSWORD_FAILED` 이벤트.

### 7.2 API(모두 운영자 전용 — `AccessPolicy`, `AccessPolicyTest.realtradeRoutesAreOwnerOnly`)
- `GET /api/realtrade/status?market=KR|US` → 키(순서): `available`, `market`, `supported`(KR만 true), `serverEnabled`{`collector`,`backend`,`reason`}, `state`, `sourceBook`, `sourceLabel`, `lossLimitPct`,
  `baselineEquity`, `baselineTotal`, `buysPaused`, `haltReason`, `unfinishedOrders`(토스 주문 번호가 있는 이 기능의 미종료 행 수), `cancelGaveUpOrders`(미종료이고 취소를 포기한 행 수),
  `unresolvedOrders`(미종료·UNKNOWN·토스 주문 번호 없는 행 수 — 셋 다 건수만), `version`, `limits`, `today`{`date`,`skipReason`,`windows`[{`kind`,`start`,`end`}]}, `serverTime`(응답을 만든 서버 시각),
  `jobStartedAt`(정기 작업 시작 — 꺼져 있으면 null), `jobLastCycleAt`(예외 없이 끝낸 마지막 주기 — 꺼져 있으면 null), `lastPreflight`{`fetchedAt`,`afterClose`(2026-11-08 — 그날 정규장 마감 뒤에 읽은 값인가, 휴장일 true, 달력이 모르면 null),`equity`,`total`,`cashBuyingPower`,`holdings`}(마지막 값은 아래 §6 `real_trade_valuation`에서 되살림 — 그때 `holdings`는 빈 목록),
  `orders`(최근 50 — orderId·client_order_id 없음), `events`(최근 30), `books`.
- `GET /api/realtrade/preview?market=KR&sourceBook=kr_rules` → 켜기 창의 예상 목록: 지금 preflight + 그 책의 '다음 시가' 목표로 §2·§3.1 계산 — `{"ok","equity","orders":[{"symbol","name","side","quantity","estAmount"}],"skipped":[…],"turnoverPct","warnings":[…]}`.
- `POST /api/realtrade/enable` 본문 `{"market","sourceBook","lossLimitPct","confirm","password","version"}` — confirm은 정확히 `실제 매매 켜기`. 서버 두 스위치가 켜져 있어야 함. 성공하면 LIVE·`sync_pending=true`·
  `baseline_equity`(preflight E)·`book_generation`.
- `POST /api/realtrade/disable` 본문 `{"market"}` — 비밀번호·확인 글자 없음, 늘 받음(서버 스위치가 꺼져 있어도 상태를 STOPPING/OFF로).
- `POST /api/realtrade/update` 본문 `{"market","sourceBook"?,"lossLimitPct"?,"rebaseline"?,"confirm":"설정 바꾸기","password","version"}` — 방식이 바뀌면 옛 책 따라 하기 즉시 중단 → 이 기능의 미체결 취소 → `sync_pending=true`.
- `POST /api/realtrade/resume` 본문 `{"market","confirm":"멈춤 해제","password","version"}` — HALTED → LIVE(`sync_pending=true`), `buys_paused` 해제도 이 경로.
- 미국(`market=US`)은 enable·update·resume에서 400 `not-supported`. 버전이 다르면 409 `version-conflict`. 확인 글자가 다르면 400 `confirm-mismatch`. 비밀번호가 틀리면 403 `password-invalid`.
- `docs/API.md`·`RouteInventoryTest`·`scripts/qa/routes.json`(쓰기 경로 `"fuzz": false`)을 같은 커밋에.

### 7.3 정기 작업 한 주기(10초)
1. 끄는 중(STOPPING)·멈춤(HALTED)이면 이 기능의 미체결 취소와 추적만, 끝나면 STOPPING → OFF.
2. 진행 중 주문 추적(§4) — 상태와 무관하게 늘.
3. LIVE가 아니면 끝. 따라 하는 책이 ACTIVE가 아니거나 세대가 다르면 이상 멈춤(`book-changed`/`book-not-active`).
4. 오늘 달력·쉬는 날 판정(§3 — 그날 첫 창과 정규장 시작 + 10분 가운데 이른 쪽의 3분 전, §13.2 QA-377). 창 안이 아니면 끝(창 3분 전 warmup).
5. 창마다 preflight(두 단계 — §12.4) → 손실 한도 검사(`baseline_total − 지금 상한 없는 총액 ≥ baseline_equity × 한도%`면 `buys_paused` — §12.5, 지금 총액은 토스 미체결 매수가 잡은 금액을 되돌린 값) → 계획(Planner) → 선점·SENDING → 전송 → 결과 기록. 창이 끝나면 `WINDOW_SUMMARY` 이벤트(건수: 접수·체결·놓침·건너뜀·막힘·미룸).
- 이상 멈춤 사유: `unknown-order`, `idempotency-conflict`, `token-contention`, `repeated-error`(같은 code 3회 — 종목 단위 건너뜀 코드·`rate-limited`·`over-order-limit`·`over-daily-orders`·`over-daily-buy` 제외), `turnover`, `book-changed`, `book-not-active`,
  `close-auction-mismatch`, `unknown-broker-status`, `restored`, `collector-disabled`(§12.10).
  이상 멈춤은 이 기능의 미체결을 취소하고 매도도 멈춘다. 손실 한도는 매수만 멈춘다.

### 7.4 알림(텔레그램 — 건수·상태만)
- `PaperTelegram`으로, `notify=true` 이벤트를 `notified_at`이 빌 때까지 다음 주기에 다시 보낸다. 글은 고정 문구 + 상태 + 건수 + 사유 코드: 예 `<b>[실제 매매] 시가 맞추기</b>` / `접수 5 · 체결 5 · 놓침 0 · 건너뜀 1 · 막힘 0`,
  `<b>[실제 매매] 멈춤</b>` / `사유: unknown-order`. **종목·수량·금액·계좌 식별자를 쓰지 않는다.** 이모지 없음.

## 8. 화면 계약

- 새 `frontend/src/components/screens/realtrade/` + `lib/realtrade.ts` + `lib/types/realtrade.ts`(배럴에 넣지 않음) + `endpoints.realtrade.*`.
- **실제 매매 칸**(`RealTradePanel`)은 `/paper/kr/real` 탭 맨 위 — 계좌 읽기(brokerage)·모의 개요 실패와 상관없이 그리고, **끄기 단추가 늘 보인다**(LIVE·HALTED·STOPPING). 상태는 `GET /api/realtrade/status`를 15초마다.
- 같은 켜기/끄기 단추(`RealTradeToggle`)를 실제 계좌 요약 '다시 읽기' 옆에도(`PaperScreen`이 `BrokerageSection`에 `extraActions`로 넘김 — brokerage 모듈은 realtrade를 가져오지 않음).
- 켜기 창(`RealTradeEnableDialog` — `Dialog` 위 폼, `ConfirmDialog`의 requireText 모양): 방식 셋(기본 규칙 계좌, 책 상태 표시), 손실 한도(기본 15%), 서버 안전 상한, 예상 목록(`/preview`),
  경고 "원화 자산 전부를 운용합니다 — 이 책에 없는 국내 주식은 다음 시가에 팔립니다 · 켠 동안 앱에서 국내 주식을 직접 사고팔지 마세요 · 모의와 달리 실제 돈이 움직입니다", 켜기 전 점검표
  (토스 앱 투자자지시 거래소 '통합' · 미수·신용 끔 · 위험 고지·사전 요건), 확인 글자 칸(`실제 매매 켜기`), 비밀번호 칸. 친 글자를 그대로 서버로 보낸다.
- 끄기: 확인 창 없이 바로(누른 뒤 "새 주문 멈춤 — 미체결 취소 중" → 결과).
- 칸 내용: 상태 칩(꺼짐·켜짐·멈춤(사유)·끄는 중·서버에서 꺼짐), 따라 하는 책, 운용 평가액·기준 대비 손익(부호와 색), 오늘 창과 쉬는 사유, 최근 실제 주문 표(용도·종목·방향·수량·상태·체결가),
  이벤트, 멈춤 해제·설정 바꾸기 단추(같은 확인). 미국 탭은 "미국 실제 매매는 준비 중입니다"(꺼진 단추).
- 화면 경계 시험 `realtradeBoundary.test.ts`: realtrade 모듈을 밖에서 가져오는 곳은 `PaperScreen` 하나, lib/paper*·lib/home*·배럴은 realtrade를 가져오지 않음, realtrade는 brokerage 모듈을 가져오지 않음,
  apiPost는 `endpoints.realtrade.*`에만. 기존 `brokerageBoundary.test.ts`는 그대로(brokerage 모듈은 쓰기 함수를 가져오지 않음). 배너 문구는 '조회는 읽기 전용 — 자동 매매는 위 실제 매매 칸'.

## 9. 운영

- 서버 `.env`(로컬 `.env`를 다시 보낼 때 다시 덧붙임): `TOSS_TRADING_ENABLED=true`, `REAL_TRADE_ENABLED=true`, 한도 네 줄. 값은 켜기 전에 사용자에게 확인.
- **복원**: `scripts/db-restore.sh`(make restore·서버 복원)는 복원 직후 꺼져 있지 않은 `real_trade_config` 행을 `HALTED`(`restored`)로 바꾼다(같은 트랜잭션 — 실패하면 복원 전체를 되돌림).
  QA 복원(`scripts/qa/qa-stack.sh restore` → `RESTORE_REAL_TRADE=clear`)은 주문·묶음·이벤트를 비우고 설정을 `OFF`로 둔다.
- `scripts/vultr/deploy.sh`: 실제 매매가 LIVE이고 지금이 한국 거래 창(08:45~09:35, 15:15~15:35 KST, 평일)이면 경고하고 멈춤 — `REALTRADE_DEPLOY_OK=1`일 때만 진행.
  ADR 0033(§13)부터 창은 정규장 전체(평일 08:45~15:35 KST)다.
- 비상 끄기: 화면 끄기 → 안 되면 서버에서 `POST /api/realtrade/disable` 한 줄(DEVELOPMENT §7) → 서버 `.env`의 `TOSS_TRADING_ENABLED=false`로 바꾸고 **수집기만 다시 만듦**
  (`docker compose … up -d --no-deps --no-build collector` — `deploy.sh`는 LIVE·거래 창이면 멈추므로 비상 끄기에 쓰지 않음) → 토스 앱에서 미체결 취소.
- 서버 밖(로컬 v1·v2·v3·QA) 어디에도 같은 토스 키를 두지 않는다(토큰 1개 — 주문 시각에 401).
- **에이전트는 끄기 외의 켜기류 API(enable·update·resume)를 부르지 않는다.** 켜기는 사용자가 화면에서 직접.

## 10. 확인 불가(첫 실제 주문에서 드러남)와 지키는 법

| 모르는 것 | 지키는 법 |
|---|---|
| OPG 접수 시작 시각·창 밖 거절이 동기인지 비동기인지·잔량 처리 | OPG는 프리마켓 단일가 창 안에서만, 종료 확인 전에는 대체 주문 없음(SYNC_FOLLOWUP은 종목의 주문이 모두 종료 확인된 뒤) |
| 시장가 매수 증거금 기준(상한가로 잡는지) | 수량 × 상한가 ≤ 매수 가능 금액으로만 보냄 |
| 같은 키 재전송 결과 | 7분 안 같은 바이트만, 그 뒤 대조 → 모호하면 멈춤 |
| 통합(SOR)에서 종가 단일가 구간 시장가의 체결 거래소·가격 | `NEXT_CLOSE` 체결의 `filledAt`이 그날 `regular.endTime` ± 2분 밖이면 이상 멈춤(`close-auction-mismatch`) — 사람이 확인하고 해제 |

## 11. 시험(층별 — 이름은 구현에서 정함)
- 수집기: 쓰기 가드(허용 두 경로 밖 전부·쿼리·`%2F`·`..`·리다이렉트·http·다른 호스트가 네트워크 전에 막힘, 공유 `toss` 세션 어댑터는 그대로 `_ReadOnlyAdapter`), AST(쓰기 호출은 `toss_trade.py`의 두 경로뿐,
  기존 두 AST 시험 그대로), outcome 분류 표 전부, 수집기 검사(창·한도·형식·오늘 세기 실패 → 안 보냄), 401 재발급 뒤 같은 키, 카나리(오류 message·본문이 응답·로그에 없음), 서비스 토큰(PROTECTED),
  플래그 해석(정확히 true·한도 형식). 토스 차단 fixture를 `conftest.py` 전역으로(옮기는 커밋 먼저).
- 백엔드: Planner(비중→수량·책에 없는 보유 전량 매도·소수 부분·반대 방향 건너뜀·상한가 현금 확인·1건 상한·임계값·회전율·순서·창·놓침·11-19형 장 시간 → 쉼), 이중 매수 없음
  (모의 미체결 → 다음 결정 재매수 → 실제 추가 0, 재발행 뿌리 → 0, 이미 맞춘 보유 → 0), 선점(교체와 경쟁), 멱등(UNKNOWN 재전송 같은 바이트·7분 뒤 대조 하나/0/둘 → 묶음/멈춤/멈춤, 시도 2 조건),
  OPG 비동기 거절 → 마무리 1회·상태 미확인 → 0·부분 체결 → 잔량만, 끄기 뒤 SENDING 없음(잠금), 손실 한도 → 매수만 멈춤, 이상 멈춤 → 매도도 멈춤·취소, 비밀번호 틀림·잠금, 끄기는 비밀번호 없이,
  접근(회원 403·운영자 200), 분리(ArchitectureRulesTest), 알림 글에 종목·금액 없음, 복원 뒤 HALTED.
- 화면: 끄기가 계좌·개요 실패 때도 보임, 켜기 창(확인 글자·비밀번호·기본 계좌2·예상 목록), US 준비 중, 경계 시험.
- compose·CI: 로컬·QA 두 플래그 false(셸에 true가 있어도), Vultr 전달, 백엔드에 `TOSS_*` 없음·수집기에 `REAL_TRADE_ENABLED` 없음.

## 12. 구현·적대적 리뷰 뒤 확정한 세부(2026-11-06)

앞 절과 다르면 이 절이 맞다. 두 번의 적대적 리뷰(계획 다섯 관점, 구현 다섯 관점 — 지적마다 반박 검증)에서 확인된 결함을 고친 결과다.

### 12.1 하루 한도를 계획이 지킴
- 사전 조회 때마다 `GET /toss/trading/orders/today`를 읽어 수집기와 같은 식(오늘 국내 KRW 주문 수, 매도가 아닌 주문의 체결 금액 + 진행 중 잔량 × 상한가)으로 남은 건수·남은 매수 금액을 구한다.
  넘는 주문은 줄이거나 미룬다(건너뜀 `deferred-daily-cap` — 창 요약의 '미룸'). 오늘 목록을 못 읽거나 진행 중 매수의 상한가를 끝내 모르면 그 주기는 보내지 않는다.
- **형식 밖 종목 코드의 진행 중 매수(QA-413, 2026-11-12 사용자 승인 — 주문 동작이 바뀜)**: 오늘 목록의 진행 중 매수(앱 주문) 가운데 종목 코드가 국내 코드 모양
  (`^[0-9][0-9A-Z]{5}$`)이 아닌 것은 상한가를 물을 길이 없다 — 수집기 사전 조회는 그 모양만 받고, 백엔드 클라이언트는 하나라도 섞이면 부르지 않고 실패한다.
  예전에는 그 한 건 때문에 남은 몫 셈이 통째로 실패해, 그 주문이 끝날 때까지 **스탑 매도를 포함한 모든 주기가 보내지 않음**이었다. 이제
  - 그 종목은 사전 조회에 넣지 않는다(형식에 맞는 종목의 상한가는 지금처럼 다시 묻는다).
  - 그 주문이 걸려 있는 동안 **남은 하루 매수 금액을 0으로** 둔다 — 매수는 모두 `deferred-daily-cap`(미룸)이고, 그 주문이 끝나 오늘 목록에 체결 금액으로
    남으면 다시 정확히 센다. 수집기 주문 보기에는 주문 가격이 없고(§5.2 정리된 주문) 그 종목의 현재가·상한가를 받을 길도 없어, 잡힌 금액을 '더 크게 잡는 쪽'으로
    어림할 값이 없다 — 그래서 어림하지 않고 매수를 멈춘다(매수 한도가 느슨해지는 방향이 아님).
  - 건수는 그대로 센다(그 주문도 1건) — 남은 건수가 없으면 매도도 미룬다. 1건 상한·현금·손실 한도·이상 멈춤은 무관하다.
  - **매도와 스탑 매도는 나간다**(달라지는 것). 수집기는 주문마다 자기 식으로 한 번 더 세는데(§5.2) 그 종목의 상한가를 토스에 직접 묻는다 — 토스가 답하면
    수집기가 실제 한도를 지키고, 답하지 못하면 `count-unavailable`로 보내지 않는다(그 사유의 안 보냄이 오늘 3건이면 §7.3 '같은 오류 3회' 이상 멈춤 — 예전에는
    행 자체가 없어 멈춤도 없었다).
  - 켜기 창 예상 목록도 같은 셈이라, 그런 날은 실패(`count-unavailable`) 대신 매수가 미룸으로 보인다. 켜기·기준 다시 잡기의 기준 총액(§12.10)은 그대로다 —
    그런 주문이 걸려 있으면 미체결 매수의 상한가를 몰라 502 `preflight-failed`(켜지 않는 쪽).
  - 토스가 그런 코드를 실제로 주는지는 확인하지 못했다(QA-351과 같은 불확실성).

### 12.2 시가 맞추기·마무리의 범위와 낡은 묶음
- 시가 뒤 마무리의 범위 = 묶음 목표 종목 ∪ 그 묶음이 주문한 종목 − **그날 장중 따라 하기가 손댄 종목**(오늘 MIRROR 행이 있는 종목 + 묶음이 흡수하지 않은 장중 대기 주문 중 따라 할 시각 ≤ 지금인 종목).
  범위 밖 보유는 팔지도 사지도 않는다. E는 전체 계좌로, 현금은 마무리 시도가 남은 종목에만 배정한다. 시가 창 안 재시도의 목표 수량은 묶음에 고정한 E(`real_trade_batches.equity`)로 센다.
- **개정(QA-376, 2026-11-12 사용자 승인 — 주문 동작이 바뀜)**: 범위에 **묶음을 만들 때의 전량 매도 대상**을 더한다 — 그때 실제 계좌에 있던, 책의 목표에 없는 정수 보유
  (책이 들지 않는 종목, 책이 그 시각까지 전량 매도하는 종목, 목표 세션이 지난 대기 STOP 종목 — 모의 공개 창의 목표 비중에는 수량 0인 종목이 없어 모두 같은 길). 묶음의
  `targets`에 **비중 0**으로 남기고, 마무리(시각 맞추기 날은 그 창 안 재시도)가 범위를 셀 때 넣는다. 계획에 넘기는 비중 맵에는 0을 넣지 않는다 — 비중 값이 있으면
  '책의 종목'으로 보고 1% 문턱(§3.1)을 걸기 때문이고, 전량 매도 대상은 지금처럼 문턱 없이 전량이다. 예전에는 범위가 '목표 종목 ∪ 주문 행의 종목'이라, 묶음을 만들 때
  주문 행을 쓰지 못한 전량 매도(VI 대기, 접수 불가 거절로 멈춘 뒤 순서, 창 끝이 가까워 묶음만 만든 날, 하루 한도·매도 가능 수량 미확인으로 미룬 것)가 그날 다시 보이지 않고
  다음 거래일 맞추기까지 남았다. 그런 날 그 종목의 매도 주문이 **같은 날 창 안에서 한 번 더** 나간다(한도·창·시도 수 2·보내기 직전 확인은 그대로). 묶음을 만든 뒤에 생긴
  보유(장중 따라 하기로 산 종목, 앱에서 산 종목)와 장중 따라 하기가 손댄 종목은 지금처럼 범위 밖이다. 감수한 것: 묶음을 만들 때 반대 방향 미체결(앱 매수 주문)로 건너뛴
  책 밖 보유는, 그 앱 주문이 창 안에서 끝나면 그날 팔린다(예전에는 다음 맞추기) — 책의 종목은 원래 그랬다. 표시 전에 만든 묶음은 예전 범위 그대로다.
  회전율(§3.1): 묶음을 만들 때 매매 제한(VI·종목 거절 대기)으로 기다리는 전량 매도 대상의 몫을 회전율에 함께 센다(대기 STOP 종목 제외) — 풀린 뒤 팔리는 몫이
  회전율 멈춤을 비켜 가지 않게. 책의 종목이 매매 제한으로 빠진 몫은 지금처럼 세지 않는다.
- 그날 묶음의 책이 지금 책과 다르거나, 묶음을 `sync_pending`을 켠 마지막 일(ENABLE, 책을 바꾼 UPDATE, HALTED에서의 RESUME)보다 먼저 만들었으면 그날 시가 재시도·마무리를 하지 않는다(`batch-stale`).
- `sync_pending`은 묶음 계획에 `capped`·`deferred-cash`·`deferred-daily-cap`이 없으면 묶음을 만들 때 끈다. 있으면 켠 뒤 3번째 SYNC 묶음 전까지 켜 두고 3번째 묶음에서 끈다.

### 12.3 취소 재시도
- 다시 보내지 않는 끝난 거절: `REJECTED` 중 `already-filled`·`already-canceled`·`already-rejected`·`already-modified`·`cancel-restricted`·`order-not-found`·`http-404`. 수집기는 취소의 409
  `already-processing`을 `UNKNOWN`으로 돌려준다. 그 밖(`rate-limited`·401 계열·`order-hours-closed`·`NOT_SENT`·`UNKNOWN`·접수했는데 원 주문이 살아 있음)은 마지막 시도부터 30초마다 최대 5번
  (`real_trade_orders.cancel_count`·`cancel_last_at`). 다 쓰고도 원 주문이 미종료면 `CANCEL_GAVE_UP` 이벤트(알림, 건수만, 행마다 한 번 — `cancel_gave_up_at`) → 사람이 앱에서 취소.
- 수집기는 취소의 401(재발급 대상 세 코드)이면 10분 재발급 창을 이미 썼어도 한 번 재발급해 같은 본문으로 다시 보낸다(끄기·이상 멈춤의 미체결 취소가 토큰 경합 때문에 401로만 끝나지 않게). 주문은 창을 그대로 따른다.
- 미체결 목록에 없는 `PARTIAL_FILLED`는 주문 세션이 오늘보다 앞이거나, `canceledAt`이 있거나, 오늘 주문이고 지금 ≥ 정규장 끝 + 5분이면 종료로 본다(오늘 장중이면 아직 아님 — 목록 반영 지연).
- 결과 모름 재전송: 주기 순서는 SENDING 정리 → 추적 → 설정 다시 읽기 → 재전송·대조. 재전송마다 설정 행 잠금 안에서 'LIVE이고 같은 version'을 확인하고, 같은 루프에서 이상 멈춤이 걸리면 남은 행은 재전송하지 않는다.
- **꺼짐·이상 멈춤에서 남은 결과 모름 행의 대조(QA-380, 2026-11-12 사용자 승인 — 주문 동작은 그대로, 토스 조회 횟수만 바뀜)**: 켜짐이 아니면 대조가 후보를
  정하지 못해도 멈춤이 없어 행이 결과 모름으로 남고(사람이 켜기·멈춤 해제로 닫음), 예전에는 그동안 주기(10초)마다 토스 미체결·오늘 목록을 읽었다. 이제
  주기 처음에 읽은 상태가 `OFF`·`HALTED`일 때는
  - 세션이 오늘(KST)보다 앞인 행은 조회하지 않고 '확인 필요'로만 센다 — 수집기의 오늘 목록은 `from = to = 오늘`이고 이 기능의 주문은 당일 주문(`DAY`·`OPG`)뿐이라
    지난 세션의 주문은 목록에 나타날 수 없다.
  - 당일 행은 **첫 전송부터 15분(`RECONCILE_EVERY_CYCLE_FOR`) 안에는 예전처럼 주기마다** 대조하고, 그 뒤에는 목록을 읽고도 후보를 정하지 못한 대조 뒤
    5분(`RECONCILE_RETRY_SPACING`)마다 다시 대조한다(늦게 보이면 묶어 취소·추적 — §12.10). 15분의 근거: 첫 대조(첫 전송 + 7분 45초)가 후보를 찾지 못해
    이상 멈춤이 된 직후에 그 주문이 목록에 뜨면 바로 묶어 취소해야 한다 — 개장 전 `OPG` 주문은 가장 이른 전송이 08:50:30이고 체결이 09:00이라, 15분이면
    단일가 체결 시각과 그 뒤 5분을 덮는다(처음부터 5분 간격이면 09:00 전에 묶지 못함 — 독립 검토 지적). 목록을 읽지 못한 대조는 간격 없이 다음 주기에 다시
    한다. 간격은 메모리에만 있어 다시 띄우면 한 번 바로 대조한다.
  - 켜짐은 그대로다(지난 세션 행도 목록을 읽고, 후보가 하나가 아니면 `unknown-order` 멈춤). 끄는 중도 그대로 주기마다 대조한다(§12.10 '끄기 마무리').
  - 화면·알림은 그대로다: 상태 응답 `unresolvedOrders`(DB의 결과 모름 행 수)와 꺼짐 알림의 '확인 필요 n건'은 대조 여부와 무관하게 행이 닫힐 때까지 남는다.

### 12.4 사전 조회 두 단계·수집기 예산
- 정기 작업과 켜기 창 예상 목록은 먼저 `sell` 없이 읽어 정수 보유로 계획하고, 매도 후보가 있으면 그 종목만 `sell`로 다시 읽어 매도 가능 수량까지로 자른다(모르면 팔지 않음 — `sellable-unknown`).
  장중 따라 하기는 매도 주문의 종목만 `sell`로 묻는다.
- 수집기 예산 = clamp(5 + 0.6 × 매도 종목 수 + 0.15 × 시세 종목 수, 20, 35)초(백엔드 읽기 시간 초과 40초 안). 어림이 35초를 넘으면 `invalid-request`로 거절한다.
- `warmup`은 옛 토큰을 먼저 버리지 않는다 — `toss.refresh_token()`이 발급에 성공할 때만 캐시를 바꾼다.

### 12.5 손실 한도
- 켤 때(와 기준 다시 잡기 때) 상한 적용 평가액 `baseline_equity`(E0)와 상한 없는 총액 `baseline_total`(U0)을 함께 저장한다. 판정: `U0 − 지금 상한 없는 총액 ≥ E0 × 한도%`면 `buys_paused`.
  지금 총액에는 이 기능의 미종료 매수 중 토스 주문 번호가 있는 것의 (수량 − 체결) × 상한가(모르면 기준가)를 되돌린다(미체결 매수가 매수 가능 금액을 잡아 생기는 거짓 멈춤 방지).
  안전 상한보다 총액이 큰 계좌에서도 운용분의 손실을 잡는다. 입출금은 '기준 다시 잡기'로.
- 기준 다시 잡기는 이 기능의 미종료 매수(토스 주문 번호 있음)가 있으면 409 `invalid-state`(사전 조회 전과 설정 행 잠금 안에서 확인) — U0와 판정값의 정의를 맞추기 위함.
- **개정(QA-379, 2026-11-12 사용자 승인 — 매수 멈춤이 걸리는 조건이 바뀜)**: 판정의 지금 총액에 **이 기능의 행으로 세지 않은 토스 미체결 매수**(앱 주문, 주문 번호를 아직
  묶지 못한 이 기능의 결과 모름 주문)가 잡은 금액도 되돌린다. 기준 총액 U0(§12.10)는 미체결 매수 전체를 되돌리는데 판정값은 이 기능의 행만 되돌려 두 식이 달랐고,
  ① 앱 매수가 걸린 채 켜거나 ② 켠 뒤 앱에서 손실 한도 금액 이상의 매수를 걸어 두면, 그 주문이 끝날 때까지 잡힌 금액이 손실로 보여 손실 0에도 `buys_paused`가 켜졌다(해제는 사람이).
  되돌리는 금액은 **확실히 잡혀 있는 하한**이다 — 판정값이 진짜 손실을 가리지 않게.
  - 시장가 매수: 남은 수량 × 상한가(이 기능의 주문·U0와 같은 식 — 두 식이 같아짐).
  - 그 밖(지정가 등): 남은 수량 × 하한가. 수집기의 주문 보기에는 주문 가격이 없어 잡힌 금액을 모른다. 상한가로 되돌리면 (상한가 − 지정가) × 수량만큼 지금 총액이 부풀어
    그만큼의 진짜 손실이 가려지므로, 그 주문이 잡을 수 있는 가장 작은 금액만 되돌린다. 그래서 지정가 앱 매수는 (지정가 − 하한가) × 수량만큼 여전히 손실 쪽으로 보인다
    (그 금액이 한도 금액 이상이면 예전처럼 매수 멈춤 — 전일 종가 근처 지정가라면 주문 금액이 E0의 절반쯤일 때부터, 예전에는 한도 금액 15%부터).
  - 방향·주문 번호·수량·체결 수량·단가를 모르는 주문은 되돌리지 않는다(예전과 같은 쪽). 이 기능의 미종료 행은 주문 번호로 빼 두 번 되돌리지 않는다.
  - 단가는 그 주기의 사전 조회와 하루 한도를 세며 물은 시세에서만 본다(토스 호출을 더하지 않음). 못 되돌려도 주기를 막지 않는다.
  - 전제는 그대로다(§12.8): 토스 `cashBuyingPower`가 미체결 매수에 줄어든다 — 줄지 않으면 앱 시장가 매수가 걸린 동안 그 금액만큼 손실 한도가 늦게 걸린다
    (이 기능의 주문은 처음부터 같은 전제). 손실 한도는 매수만 멈추며 매도·스탑 매도·한도 다섯 가지·이상 멈춤은 이 수정과 무관하다.

### 12.6 정기 작업·화면
- `tick`은 Error를 포함해 무엇이든 잡고 다음 주기를 이어 간다(클래스 이름만 로그). 화면은 LIVE·HALTED·STOPPING인데 `jobLastCycleAt ?? jobStartedAt`이 같은 응답의 `serverTime`보다
  3분 넘게 앞서면 '정기 작업이 멈춘 것 같습니다 — 비상 끄기 절차'(주기를 하나도 못 끝냈으면 '기동 뒤 끝낸 주기 없음').
- 끄기 단추는 상태를 모르는 동안(첫 읽기·다시 읽기·실패)에도 보인다. 상태 읽기 한도는 30초, 백엔드의 수집기 상태 호출은 5초.
- 취소를 포기한 주문이 있으면 '취소를 5번 보냈지만 n건이 아직 살아 있습니다 — 토스증권 앱에서 직접 취소하세요', 꺼졌는데 결과 모름이 남으면 '꺼졌습니다 — 결과를 모르는 주문 n건은 토스증권 앱에서 확인하세요'
  (끄기 뒤 안내의 우선순위: 취소 포기 > 서버 스위치 꺼짐 > 결과 모름 > 정리 끝·취소 중).
- 서버 스위치가 꺼졌는데 STOPPING·HALTED이거나 `unfinishedOrders > 0`이면 '이 기능이 미체결을 취소할 수 없습니다 — 토스증권 앱에서 직접 취소하세요'.
- 모의 개요가 없거나 실패해도 한국 화면에 '실제 계좌 탭으로(실제 매매 끄기)' 단추를 둔다.
- 오류 본문은 `{ok:false, error, message}` — 화면은 `error`를 정확히 비교한다(`ApiError.code`). 409는 `version-conflict`·`invalid-state`·`server-disabled`·`book-changed`·`not-ready`, 502 `preflight-failed`,
  400 `invalid-market`·`invalid-version`·`invalid-loss-limit`·`invalid-source-book`·`book-not-active`·`nothing-to-update`.
- 알림: STOPPED는 '꺼짐 / 취소로 끝남 n · 체결로 끝남 m', 새 종류 `CANCEL_GAVE_UP`은 '취소 못 함 / n건 — 토스증권 앱에서 직접 취소하세요'(종목·수량·금액 없음).

### 12.7 V24에 더한 칸
`real_trade_config.baseline_total`, `real_trade_orders.cancel_count`·`cancel_last_at`·`cancel_gave_up_at`. 그 밖에 안전 CHECK(LIVE면 책·세대 필수, TIF는 `DAY`·`OPG`, 시도 1~2, 한국 종목 모양,
MIRROR는 모의 주문 번호·뿌리, SYNC·SYNC_FOLLOWUP은 묶음 번호 필수, 토스 주문 번호 부분 유일).

### 12.8 첫 실제 주문 뒤 확인할 것(§10에 더함)
- 토스 `cashBuyingPower`가 미체결 매수(상한가 기준)에 줄어드는지 — 줄지 않으면 §12.5의 되돌림이 평가액을 부풀려 손실 한도가 늦게 걸리고, 같은 창의 예약 이중 차감도 다시 본다.

### 12.9 스탑 매도는 규칙 계좌와 같은 시가에(사용자 결정 2026-11-06 — 시각 지정 STOP은 §13이 바꿈)
- 시가 목표는 출처 STOP 매도도 흡수한다 — 실제 계좌는 규칙 계좌와 같은 시가에 판다. 모의 장부는 체결 때 금융위 확정 종가로 스탑을 다시 판정해 드물게 취소하는데
  (잠정 종가 ≤ 스탑가 < 확정 종가), 그러면 실제 계좌만 그 종목을 다음 시가 맞추기에서 다시 사는 하루 왕복이 생긴다(비용은 그 종목의 약 0.2~0.3%). 손절을 늦추지 않는 쪽을 골랐다(3차 리뷰 RT3-MON-1).

### 12.10 3차 리뷰 뒤 확정한 세부(2026-11-06)
- **창 끝 다시 보기**: 묶음·장중 주문을 보내기 직전마다 그 창이 지금 시각에 열려 있는지 다시 보고, 닫혔으면 보내지 않고 '놓침'으로 센다. 시가 맞추기는 창 끝 − 60초 뒤에 시작한 시도에서
  OPG를 보내지 않는다(그날 묶음이 없으면 묶음만 만들고 시가 뒤 마무리가 DAY로 메움). `outside-window`는 '같은 오류 3회'에 세지 않는다.
- **수집기 스위치가 꺼지면 멈춤**: LIVE인데 수집기가 매매 스위치가 꺼졌다고 분명히 답하면 이상 멈춤 `collector-disabled` — 스위치를 되돌린 것만으로는 재개되지 않고 화면의 멈춤 해제
  (확인 글자 + 비밀번호)가 필요하다. 상태를 읽지 못한 것(`serverEnabled.collector = null`, 사유 `status-unreadable`)은 멈추지 않고 화면은 '서버 상태를 읽지 못함'으로 보인다.
- **끄기 마무리**: STOPPING → OFF는 그 주기 결과 모름 대조가 토스 목록을 실제로 읽었을 때만. OFF에서도 대조·추적을 이어 가고 늦게 묶인 이 기능의 토스 주문은 취소한다.
  꺼짐·이상 멈춤에서 조회를 아끼는 것(§12.3, QA-380)은 이 조건을 바꾸지 않는다 — 끄는 중에는 지난 세션 행도, 방금 대조에 실패한 당일 행도 주기마다 목록을 읽고,
  이상 멈춤으로 읽고 시작해 조회를 아낀 주기 도중에 끄기가 커밋되면 그 주기에는 넘기지 않는다(다음 주기가 끄는 중으로 읽고 목록을 실제로 읽은 뒤에).
- **기준 총액**: 켜기·기준 다시 잡기의 U0에 그때 토스 미체결 매수(앱 주문 포함)의 잔량 × 상한가를 되돌린다(판정값과 같은 정의 — 판정값이 실제로 앱 주문을 되돌리게 된 것은 QA-379, §12.5. 지정가 앱 매수는 U0가 상한가·판정값이 하한가라 손실 쪽으로만 어긋난다). 켜기 창 예상 목록은 상태의 `lastPreflight`를 덮어쓰지 않는다.
- **운영**: Vultr 덧붙임 `stop_grace_period` — backend 150초(웹 서버 종료 단계 30초 + 종료 훅 60초 + 주문 읽기 25초 + ISA 종료 대기 30초보다 김 — QA-257, 열린 실시간 시세 연결은 종료가 시작되면 바로 닫음), collector 30초. `deploy.sh` 가드는 LIVE·STOPPING·HALTED를 모두 센다.
  복원은 복원 전 DB의 꺼지지 않은 시장·끝나지 않은 주문이 복원 뒤 빠지면 경고한다(켜기 전·V24 전 백업 — 토스 미체결은 운영자가 앱에서 확인·취소). 서버 `.env` 다시 전달은 서버 전용 줄을 서버에서 이어 붙인다.

## 13. 개장 10분 뒤 시각 맞추기와 장중 스탑 매도(ADR 0033, 2026-11-07 구현·배포 — main@`231efe95`)

앞 절과 다르면 이 절이 맞다. 결정과 시험 이름은 [ADR 0033](../adr/0033-real-isa-open-offset-and-stops.md)에 있고, 쓰기 길은 그대로 수집기 `toss_trade.py`의 두 경로뿐이다(새 쓰기 경로·새 API 경로 없음).

### 13.1 맞추기 시각과 창
- `PaperMirrorService.dailySyncAt(book, session)`이 그 세션의 일일 맞추기 시각 T를 준다. 없으면 지금의 시가 맞추기(SYNC·SYNC_FOLLOWUP).
  - 없음: 책이 한국·운용 중이 아니거나 거래일이 아님, 또는 그 세션 시가에 체결될 STOP이 아닌 `NEXT_OPEN` 대기 주문이 있음(전환일).
  - 규칙 계좌: 대기 `AT_MINUTE` 규칙 주문 가운데 가장 이른 목표(그 세션 첫 분 이상) → 없으면 `kr.rules.timing=AT_MINUTE`일 때 `RuleTiming.choose`(기준일 = 앞 거래일 — 개장이 늦은 날 10:10).
    `NEXT_CLOSE`·`NEXT_OPEN` 설정이면 없음.
  - Claude 계좌: 그 계좌의 `*.freeTiming`이 켜져 있으면 그 세션 첫 분.
- 시각 맞추기 날의 창은 §3 표의 SYNC_AT 한 줄이다(그날은 시가 단일가 창과 시가 뒤 마무리 창이 없음). 창이 비면(T가 장중 끝 뒤) 시가 맞추기 날로 센다. 첫 창 3분 전까지 주기마다 다시 세고, 따라 하는
  책·세대가 바뀌면 다시 센다. 묶음 종류·주문 용도는 시가 뒤 마무리와 같다(V24 CHECK 그대로). 창 안 재시도는 지금 규칙대로다.
- 목표는 `PaperMirrorService.targetsAt(book, session, T)` — 보유 + 그 세션 시가 주문 + 기준 시각이 T 이하인 시각 지정 주문을 simulate한 비중. 시각 지정 STOP(`MARKET`·`AT_MINUTE`·`NEXT_CLOSE`)은
  비중에 반영하되 흡수하지 않고 `stopOrderIds`로 따로 돌려준다(§13.2가 판다). 기준 시각이 T 이하인 다른 모의 주문은 묶음 몫이라 장중 따라 하기가 따로 보내지 않는다 — 묶음을 만들지 못하고
  창을 넘기면 그 주문들도 놓침이다. 옛 `NEXT_OPEN` STOP(감시를 켜지 않은 한국 밤 스탑)은 지금처럼 묶음이 흡수한다. 시가 경로의 `openTargets`는 바이트까지 그대로다.
- 켜기 창 예상 목록(`/preview`)은 다음 맞추기 시각이 있으면 그 시각까지의 목표로 계산하고 응답에 `syncAt`을 싣는다(시가 맞추기면 null).
  예상의 세션은 정기 작업과 같은 기준으로 고른다(QA-344, 2026-11-12): 오늘 묶음이 없고 오늘 맞추기 창이 아직 닫히지 않았으면(시각 맞추기 날은 [T, T + 3분] —
  정기 작업이 매매 제한으로 늘린 창이 있으면 그 끝, 시가 맞추기 날은 개장 전) 오늘, 아니면 다음 거래일. 그 창이 지금 열려 있으면 응답 `immediate: true`이고
  화면은 세션 날짜와 '창이 열려 있는 동안 켜면 이 목록이 바로 주문됩니다'를 보인다 — 정기 작업은 켠 시각과 관계없이 창 안이고 그날 묶음이 없으면 묶음을 만든다(그대로).

### 13.2 스탑 매도
- 대상: 따라 하는 책의 PENDING 출처 STOP 매도 중 목표 세션 = 오늘이고 timing ∈ {`MARKET`, `AT_MINUTE`, `NEXT_CLOSE`}인 것(장중 감시 STOP과 밤 대체 STOP — ADR 0032).
- 비중을 셈하지 않고(가격을 몰라도 손절이 사라지지 않게) 그때 다시 읽은 정수 보유 전량을 매도 가능 수량·1건 상한까지 시장가 `DAY`로 판다. 창은 §3 표의 스탑 매도 줄(정규장 시작 + 10분 하한 —
  모의가 그 앞 시각의 STOP을 내더라도 실제로는 팔지 않음).
- 같은 뿌리 최대 2회: 시도 1이 체결이 있는 채 끝나면 새로 읽은 수량으로 시도 2(보유가 남았을 때만). 이 기능의 그 종목 주문이 진행 중이면 다음 주기로 미룬다(묶음 매도와 겹쳐도 더 팔지 않음).
- 묶음의 회전율 한도(§3.1)는 대기 STOP 종목(`pendingStopSymbols`)의 매도와, 그 대금(묶음의 스탑 매도 + 이 기능이 오늘 먼저 접수한 스탑 종목 매도 — 진행 중이면 수량, 끝났으면 체결 수량 × 기준가)까지의
  현금성 매수를 빼고 센다(QA-302 — 스탑이 `turnover` 멈춤을 걸어 같은 주기의 스탑 경로까지 세우지 않게, 시가 맞추기 날 흡수한 `NEXT_OPEN` STOP도 같음). 남은 몫 묶음의 목표 변화량도
  STOP 종목이 줄어든 몫과 그만큼까지의 현금성 증가를 뺀다. 보내는 주문은 그대로이고, 스탑이 아닌 몫이 60%를 넘으면 예전처럼 멈춘다(멈춤 동안은 스탑도 없음).
- 손실 한도로 매수가 멈춘 동안에도 판다. 장부가 밀린 날(`ledgerCaughtUp=false`)에도 스탑만은 보내고(묶음·장중 따라 하기 없음), 토스 장 시간이 모의 달력과 다른 날은 스탑도 보내지 않는다.
- **개정(QA-377, 2026-11-12 사용자 승인)**: 그날의 쉬는 날 판정(§3 — 판정 전에는 스탑 매도를 포함해 아무것도 보내지 않음)을 '첫 창 3분 전'이 아니라
  **min(첫 창의 시작, 정규장 시작 + 10분)의 3분 전**에 한다. 예전에는 맞추기 시각 T가 개장 10분 뒤보다 늦은 날(규칙 계좌의 지정 시각을 09:10이 아닌 값으로 둔 설정 —
  허용 범위 09:10~15:19)에 T − 3분까지 판정이 없어, 그 사이의 장중 스탑(창은 정규장 시작 + 10분부터)이 나가지 않고 놓침으로만 남았다. 맞추기 창을 굳히는 시각
  (§13.1 — 그 창 3분 전까지 주기마다 다시 셈)과 묶음을 만드는 시각은 그대로다. 맞추기 시각이 개장 10분 뒤인 날(운영 값 09:10, 장 시간 변경일의 첫 분)과 시가 맞추기 날은
  두 시각이 같아 **달라지는 것이 없다**. 달라지는 날: T가 늦은 설정의 날에만, 판정·토큰 예열·장부 밀림 확인이 개장 7분 뒤(보통 09:07)로 당겨지고 그때부터 스탑 매도가 돈다
  (기준 시각이 T 이하인 스탑 아닌 주문은 지금처럼 묶음 몫이라 따로 보내지 않음).
- 이벤트 `STOP_SELL`(detail은 보냄·막힘·놓침 건수만), 알림도 건수만(§7.4). 놓침에는 하루 한도(`deferred-daily-cap`)로 미룬 채 창이 끝난 뿌리도 들고(장중 창 요약은 그 뿌리를 미룸으로만 셈),
  막힘에는 토스 거절·안 보냄과, 정수 보유가 있는데 구조적 건너뜀(`not-sellable`·`price-missing` 등 — 소수 부분만 남은 것은 아님)으로 그날 닫은 뿌리가 든다(QA-303, 뿌리마다 한 번).

### 13.3 매수 직전 대기 STOP 확인
- 묶음 첫 전송·창 안 재시도·시가 뒤 마무리·장중 따라 하기의 매수를 보내기 직전마다 `PaperMirrorService.pendingStopSymbols(book, session)`을 DB에서 다시 읽어, 그 종목 매수는 보내지 않고
  건너뜀 사유 `pending-stop`으로 창 요약에 센다(09:10 묶음이 매도 대금을 기다리는 동안 생긴 STOP 종목을 재시도가 다시 사지 않게).

### 13.4 화면·운영
- 상태 응답 `today.windows`의 `kind`에 `SYNC_AT`, 이벤트에 `STOP_SELL`이 더해진다([API](../API.md)). 이름표 '맞추기(시장가)'는 시가 뒤 마무리와 시각 맞추기의 시장가 주문이 함께 쓴다.
- 켜기 창 경고의 '이 책에 없는 국내 주식은 다음 시가에 팔립니다'는 '…다음 맞추기(보통 개장 10분 뒤 09:10, 시가 맞추기 날은 08:50)에서 팔립니다'로, 멈춤 해제 글의 '다음 시가 맞추기'는 '다음 맞추기'로 바뀌고,
  예상 목록에 다음 맞추기 방식('개장 10분 뒤 맞추기 09:10 시장가'·'시가 맞추기(시가 단일가)')을 보인다(§8의 문구는 이 글로 바뀜).
- 켜기·해제 안내 글(QA-347, 2026-11-12 — 동작은 그대로, 글만): 정기 작업은 켜짐이면 켠 시각과 관계없이 그날 남은 장중 주문(`MIRROR`)과 장중 스탑(§13.2)을 바로 따라 하고,
  전체 맞추기(묶음)만 다음 맞추기 창에서 한다. 그래서 화면·텔레그램의 켜짐 글은 '전체 맞추기는 다음 맞추기에서, 그 전에도 오늘 남은 장중 주문과 장중 스탑은 바로 따라 함'이고,
  해제 글은 이상 멈춤 해제(위와 같음)와 매수 멈춤만 푼 해제('매수도 바로 다시 따라 합니다')를 가른다. 장부가 밀려 쉬는 날(`ledger-behind`)의 오늘 줄은 '스탑 매도만 합니다'.
- `deploy.sh` 가드: 평일 08:45~15:35 KST(장 시간 변경일은 개장 − 15분 ~ 마감 + 5분, 설정을 읽지 못하면 08:45~16:35).
- 저장 전 서버 읽기 전용 확인(값은 출력하지 않음): `TOSS_TRADING_MAX_ORDER_KRW` ≥ 가장 큰 단일 보유 평가액(아니면 스탑은 시도마다 상한만큼, 남은 수량은 다음 날 맞추기가 '책에 없는 보유'로 팖),
  `TOSS_TRADING_MAX_ORDERS_PER_DAY`가 재선정일 주문 수와 스탑 여유를 합친 것 이상, 실제 매매 상태와 따라 하는 책.
- 첫 효과: `kr.rules.timing=AT_MINUTE`을 저장한 뒤 그 세션 시가에 체결될 STOP이 아닌 대기 주문이 없는 첫 세션. 11-09는 조건부다(QA-304) — 배포 전(11-06 밤) 규칙 계좌 결정이
  STOP이 아닌 `NEXT_OPEN` 주문을 남겼을 때만 전환일(옛 08:50 `OPG`)이고 첫 시각 맞추기는 11-10 09:10이다. 그 결정이 `NO_TRADE`였으면 11-09의 대기 주문은 STOP뿐이라 설정으로
  시각을 세어 **첫 시각 맞추기가 11-09 09:10**이다(금요일 밤 `NEXT_OPEN` STOP은 따로 갈 길 없이 그 묶음만이 판다). 저장 전 읽기 전용 확인에 '목표 세션 11-09인 STOP이 아닌
  `NEXT_OPEN` 대기 주문이 있는가'를 더하거나 저장 뒤 예상 목록의 `syncAt`을 본다. 11-09를 시가 맞추기 날로 두려면 `kr.rules.timing` 저장을 11-09 09:13 뒤(22:30 결정 전)로
  미룰 수 있다(그날 창은 첫 창 3분 전에 굳음 — 고르는 것은 사용자). `kr.stopWatch.mode=ON`이면 장중 감시 STOP은 시가 맞추기 날에도 §13.2로 팔린다.

2026-11-09 개정: 규칙 계좌 설정이 `AT_MINUTE`이면 시가 주문이 남은 날도 시각 맞추기를 한다(전환일 없음). 시각 맞추기 창의 VI·서킷브레이커 대기는 [ADR 0033](../adr/0033-real-isa-open-offset-and-stops.md) '결과와 남은 위험'이 계약이다.
