# 설계 — 토스증권 실제 계좌가 모의 책을 따라 하는 실제 매매(한국 원화)

- 상태: **확정**(2026-11-06 사용자 승인). 결정 기록은 [ADR 0028](../adr/0028-real-trade-mirror.md). 이 문서는 수집기·백엔드·화면이 함께 따르는 **계약**이다.
- 사용자 요청: "모의 알고리즘 매매(한국)의 메커니즘에 따라 나의 실제 토스 계좌의 원화 자산을 운용·매매. 실제 계좌 요약의 '다시 읽기' 옆에 매매 켜기/끄기. [규칙 계좌,
  Claude 계좌1, Claude 계좌2] 중 고른 방식으로. 달러 자산은 나중 — 가능성만." 수정: **처음 방식은 Claude 계좌2**.
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
- 1건 상한(`TOSS_TRADING_MAX_ORDER_KRW`)을 넘으면 쪼개지 않고 상한까지만 보내며 나머지는 `capped`(다음 시가 맞추기가 다시 시도).

## 3. 언제 — 창은 그날 토스 장 운영 정보로

- 수집기가 `GET /api/v1/market-calendar/KR`의 `today.integrated`를 정리해 준다(§5.2). 백엔드는 그날 첫 창 전에 받아 두고 하루 동안 쓴다(실패하면 다시).
- 그날을 **쉬는** 경우(아무것도 보내지 않고 이벤트·알림): `integrated` 또는 `regularMarket`이 null(휴장), 토스 정규장 시작·끝이 모의 달력(`PaperMirrorService.sessionHours`)과 다름
  (예: 2026-11-19 수능 10:00~16:30인데 모의 `kr.calendar.openTimeOverrides`가 없음), 토스 응답 시각과 서버 시각 차이 > 5초, 모의 장부가 전 거래일을 아직 반영하지 않음(`ledgerCaughtUp=false`).

| 경로 | 주문 | 창 | 한 번 |
|---|---|---|---|
| 시가 맞추기 SYNC | MARKET + `OPG` | [`preMarket.singlePriceAuctionStartTime` + 30초, `preMarket.endTime` − 90초] (보통 08:50:30~08:58:30) | 하루 한 묶음(`real_trade_batches` 유일) |
| 시가 뒤 마무리 SYNC_FOLLOWUP | MARKET + `DAY` | [`regularMarket.startTime` + 30초, 그날 09:30 KST(장 시간 변경일은 시작 + 30분)] | 묶음의 종목마다, 그 종목의 이 기능 주문이 모두 종료 확인된 뒤 |
| 장중 따라 하기 MIRROR(`AT_MINUTE`·`AT_hh00`·`MARKET`) | MARKET + `DAY` | [T, min(T + 3분, `regularMarket.singlePriceAuctionStartTime` − 30초)] | 모의 주문(뿌리 번호)마다 |
| 장중 따라 하기 MIRROR(`NEXT_CLOSE`) | MARKET + `DAY` | [`regularMarket.singlePriceAuctionStartTime` + 30초, `regularMarket.endTime` − 120초] | 모의 주문마다 |

- 단일가 시각이 null이면 그 경로는 그날 쓰지 않는다(SYNC가 없으면 SYNC_FOLLOWUP이 정규장에서 같은 계산을 한다 — 이때는 회전율 한도 적용).
- 창을 놓치면 `missed`로 기록(다음 시가 맞추기가 메움). 수집기도 창 밖(정규장 시작 + 30초 전의 DAY, 프리마켓 단일가 창 밖의 OPG, 정규장 끝 뒤) 주문을 네트워크 전에 거부한다.
- 한 창 안 순서: 매도 → 매수(같은 묶음 안에서는 현금성 `153130`·`kr.cashLikeTickers`를 매수 마지막·매도 처음).

### 3.1 시가 맞추기의 목표
- `PaperMirrorService.openTargets(book, session)` — 책의 보유 + **그 세션 시가가 기준 시각인 모든 PENDING 주문**(출처 CLAUDE·RULE·STOP·INITIAL 모두)을 마지막 가격으로
  `ExpectedState.simulate` 한 결과의 비중(종목별 %)과 흡수한 모의 주문 번호들. 그 주문들은 MIRROR로 따로 따라 하지 않는다.
- 차이가 **1주 이상이고 |차이 금액| ≥ E의 1%** 일 때만 주문(책에 없는 보유는 1% 조건 없이 전량).
- 회전율 한도: 한 SYNC 묶음의 매수 + 매도 금액 합이 E의 60%를 넘으면 그 묶음을 보내지 않고 이상 멈춤(`turnover`) — 단 켜기·방식 바꾸기·멈춤 해제 직후 첫 SYNC(`sync_pending=true`)는 예외(켜기 창에서 확인).

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
  같은 종목·방향·수량·`MARKET`·같은 TIF, `orderedAt ∈ [first_sent_at − 5초, first_sent_at + 7분]`, 다른 행에 묶이지 않은 후보가 **정확히 하나**면 그 orderId로 묶고, 아니면 이상 멈춤(`unknown-order`).
- 새 키(시도 2)는 앞 시도가 `REJECTED`·`NOT_SENT`이거나 종료 상태와 체결 수량이 확인된 뒤에만, 남은 수량만, 원 주문(또는 묶음의 종목)당 최대 2회.
- 수집기 안의 재시도는 401(재발급 대상 코드) 뒤 같은 키로 한 번뿐이다. 그 밖의 재시도는 백엔드 한 곳에서만.
- 상태 추적: 매 주기 `GET /toss/trading/orders/open` 한 번(전량) + OPEN에서 빠진 이 기능 주문만 `GET /toss/trading/orders/{orderId}` 한 번씩. 종료 상태(`FILLED`·`CANCELED`·`REJECTED`·`REPLACED`)와
  `execution`(체결 수량·평균가·금액·수수료·세금·체결 시각)을 행에 기록. 모르는 상태 코드는 종료로 보지 않고 기록·알림.
- 취소: `POST /toss/trading/orders/{orderId}/cancel` → 원 주문을 `PENDING_CANCEL` → `CANCELED`/`FILLED`까지 따라감. 409 `already-*`는 종료로 처리, `CANCEL_REJECTED`면 원 주문이 살아 있음.

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
- `real_trade_batches`: `id BIGSERIAL PK`, `market`, `session DATE`, `kind TEXT CHECK(IN 'SYNC')`, `source_book`, `targets JSONB`(종목 → 비중), `absorbed_order_ids BIGINT[]`, `equity NUMERIC`, `created_at`, `UNIQUE(market, session, kind)`.
- `real_trade_orders`: `id BIGSERIAL PK`, `market`, `session DATE`, `purpose TEXT CHECK(IN 'SYNC','SYNC_FOLLOWUP','MIRROR')`, `batch_id BIGINT NULL REFERENCES real_trade_batches`, `source_book`, `book_generation`,
  `paper_order_id BIGINT NULL`, `paper_root_order_id BIGINT NULL`(FK 없음 — 모의 리셋이 막히지 않게), `symbol`, `side`, `quantity INTEGER`, `time_in_force`, `ref_price NUMERIC`, `attempt SMALLINT NOT NULL DEFAULT 1`,
  `client_order_id TEXT NOT NULL UNIQUE`, `request_body TEXT NOT NULL`, `send_outcome TEXT NOT NULL CHECK(IN 'SENDING','ACCEPTED','REJECTED','UNKNOWN','NOT_SENT')`, `outcome_code TEXT`,
  `toss_order_id TEXT`, `broker_status TEXT`, `terminal BOOLEAN NOT NULL DEFAULT false`, `filled_quantity NUMERIC`, `average_filled_price NUMERIC`, `filled_amount NUMERIC`, `commission NUMERIC`, `tax NUMERIC`,
  `filled_at TIMESTAMPTZ`, `first_sent_at`, `last_sent_at`, `send_count SMALLINT NOT NULL DEFAULT 0`, `cancel_requested_at`, `cancel_outcome TEXT`, `created_at`, `updated_at`.
  유일: `(market, paper_root_order_id, purpose, attempt) WHERE paper_root_order_id IS NOT NULL`, `(batch_id, symbol, purpose, attempt) WHERE batch_id IS NOT NULL`.
- 놓침·건너뜀은 주문 행이 아니라 이벤트(`WINDOW_SUMMARY`의 detail)로 남긴다.

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
- `GET /api/realtrade/status?market=KR|US` → `{"available", "market", "supported": KR만 true, "serverEnabled": {"collector": bool, "backend": bool, "reason"}, "state", "sourceBook", "sourceLabel",
  "lossLimitPct", "baselineEquity", "buysPaused", "haltReason", "version", "limits", "today": {"date","skipReason","windows"}, "lastPreflight": {"fetchedAt","equity","cashBuyingPower","holdings":[…]}|null,
  "orders": [최근 50 — 종목·방향·수량·TIF·용도·상태·체결 수량·평균가·금액·사유 코드·시각, orderId·client_order_id 없음], "events": [최근 30], "books": [{"code","label","status"}]}`.
- `GET /api/realtrade/preview?market=KR&sourceBook=kr_claude2` → 켜기 창의 예상 목록: 지금 preflight + 그 책의 '다음 시가' 목표로 §2·§3.1 계산 — `{"ok","equity","orders":[{"symbol","name","side","quantity","estAmount"}],"skipped":[…],"turnoverPct","warnings":[…]}`.
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
4. 오늘 달력·쉬는 날 판정(§3). 창 안이 아니면 끝(창 3분 전 warmup).
5. 창마다 preflight → 손실 한도 검사(E ≤ 기준 × (1 − 한도%)면 `buys_paused`) → 계획(Planner) → 선점·SENDING → 전송 → 결과 기록. 창이 끝나면 `WINDOW_SUMMARY` 이벤트(건수: 접수·체결·놓침·건너뜀·막힘·미룸).
- 이상 멈춤 사유: `unknown-order`, `idempotency-conflict`, `token-contention`, `repeated-error`(같은 code 3회 — 종목 단위 건너뜀 코드·429 제외), `turnover`, `book-changed`, `book-not-active`,
  `close-auction-mismatch`, `unknown-broker-status`, `restored`.
  이상 멈춤은 이 기능의 미체결을 취소하고 매도도 멈춘다. 손실 한도는 매수만 멈춘다.

### 7.4 알림(텔레그램 — 건수·상태만)
- `PaperTelegram`으로, `notify=true` 이벤트를 `notified_at`이 빌 때까지 다음 주기에 다시 보낸다. 글은 고정 문구 + 상태 + 건수 + 사유 코드: 예 `<b>[실제 매매] 시가 맞추기</b>` / `접수 5 · 체결 5 · 놓침 0 · 건너뜀 1 · 막힘 0`,
  `<b>[실제 매매] 멈춤</b>` / `사유: unknown-order`. **종목·수량·금액·계좌 식별자를 쓰지 않는다.** 이모지 없음.

## 8. 화면 계약

- 새 `frontend/src/components/screens/realtrade/` + `lib/realtrade.ts` + `lib/types/realtrade.ts`(배럴에 넣지 않음) + `endpoints.realtrade.*`.
- **실제 매매 칸**(`RealTradePanel`)은 `/paper/kr/real` 탭 맨 위 — 계좌 읽기(brokerage)·모의 개요 실패와 상관없이 그리고, **끄기 단추가 늘 보인다**(LIVE·HALTED·STOPPING). 상태는 `GET /api/realtrade/status`를 15초마다.
- 같은 켜기/끄기 단추(`RealTradeToggle`)를 실제 계좌 요약 '다시 읽기' 옆에도(`PaperScreen`이 `BrokerageSection`에 `extraActions`로 넘김 — brokerage 모듈은 realtrade를 가져오지 않음).
- 켜기 창(`RealTradeEnableDialog` — `Dialog` 위 폼, `ConfirmDialog`의 requireText 모양): 방식 셋(기본 Claude 계좌2, 책 상태 표시), 손실 한도(기본 15%), 서버 안전 상한, 예상 목록(`/preview`),
  경고 "원화 자산 전부를 운용합니다 — 이 책에 없는 국내 주식은 다음 시가에 팔립니다 · 켠 동안 앱에서 국내 주식을 직접 사고팔지 마세요 · 모의와 달리 실제 돈이 움직입니다", 켜기 전 점검표
  (토스 앱 투자자지시 거래소 '통합' · 미수·신용 끔 · 위험 고지·사전 요건), 확인 글자 칸(`실제 매매 켜기`), 비밀번호 칸. 친 글자를 그대로 서버로 보낸다.
- 끄기: 확인 창 없이 바로(누른 뒤 "새 주문 멈춤 — 미체결 취소 중" → 결과).
- 칸 내용: 상태 칩(꺼짐·켜짐·멈춤(사유)·끄는 중·서버에서 꺼짐), 따라 하는 책, 운용 평가액·기준 대비 손익(부호와 색), 오늘 창과 쉬는 사유, 최근 실제 주문 표(용도·종목·방향·수량·상태·체결가),
  이벤트, 멈춤 해제·설정 바꾸기 단추(같은 확인). 미국 탭은 "미국 실제 매매는 준비 중입니다"(꺼진 단추).
- 화면 경계 시험 `realtradeBoundary.test.ts`: realtrade 모듈을 밖에서 가져오는 곳은 `PaperScreen` 하나, lib/paper*·lib/home*·배럴은 realtrade를 가져오지 않음, realtrade는 brokerage 모듈을 가져오지 않음,
  apiPost는 `endpoints.realtrade.*`에만. 기존 `brokerageBoundary.test.ts`는 그대로(brokerage 모듈은 쓰기 함수를 가져오지 않음). 배너 문구는 '조회는 읽기 전용 — 자동 매매는 위 실제 매매 칸'.

## 9. 운영

- 서버 `.env`(로컬 `.env`를 다시 보낼 때 다시 덧붙임): `TOSS_TRADING_ENABLED=true`, `REAL_TRADE_ENABLED=true`, 한도 네 줄. 값은 켜기 전에 사용자에게 확인.
- **복원**: `scripts/db-restore.sh`(make restore·서버 복원)는 복원 직후 `real_trade_config`를 모두 `HALTED`(`restored`)로 바꾼다. QA 복원(`scripts/qa/qa-stack.sh restore`)은 `real_trade_*`를 비운다.
- `scripts/vultr/deploy.sh`: 실제 매매가 LIVE이고 지금이 한국 거래 창(08:45~09:35, 15:15~15:35 KST, 평일)이면 경고하고 멈춤 — `REALTRADE_DEPLOY_OK=1`일 때만 진행.
- 비상 끄기: 화면 끄기 → 안 되면 서버에서 `POST /api/realtrade/disable` 한 줄(DEVELOPMENT §7) → 서버 `.env`의 `TOSS_TRADING_ENABLED=false`로 재배포 → 토스 앱에서 미체결 취소.
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
