# 설계 — 토스증권 실제 계좌 읽기 전용 조회(1단계)

- 상태: **확정**(2026-11-05 사용자 승인 — "읽기 전용 먼저, 원화 자산은 모의매매(한국)·달러 자산은 모의매매(미국)에 나눠 보이고 안전 장치를 같이, 권장안대로").
  결정 기록은 [ADR 0025](../adr/0025-toss-real-account-readonly.md). 이 문서는 세 층(수집기·백엔드·화면)이 함께 따르는 **응답 계약**이다.
- 범위: 실제 계좌의 보유 종목·매수 가능 금액·주문 내역(진행 중·최근 끝남)을 **읽기만** 한다. 주문·정정·취소·조건주문·웹소켓 `personal:order`·거래내역
  (`/api/v1/transactions`)은 범위 밖이다(2단계 관문은 ADR 0025).
- 모의 매매와의 관계: 별개 기능이다. 실제 계좌 자료는 모의 장부·순자산·Claude 패킷·프롬프트·복기·알림(텔레그램)·AI 리포트에 들어가지 않는다.
  모의매매 명세의 "실제 주문은 범위 아님"([2026-10-24-paper-trading-spec.md](2026-10-24-paper-trading-spec.md) §0, [한국 명세](2026-10-26-v2-kr-paper-spec.md) 머리말)은
  모의 책에 그대로 적용된다 — 이 기능은 주문을 내지 않는다.

## 1. 출처 — 토스증권 Open API 1.2.28(2026-11-05 공식 스펙)

| 엔드포인트 | 쓰는 것 | 호출 한도 묶음 |
|---|---|---|
| `GET /api/v1/accounts` | `accountType`, `accountSeq`(헤더 값으로만 — 밖으로 내지 않음). `accountNo`는 읽지 않고 버림 | ACCOUNT 초당 1회 |
| `GET /api/v1/holdings` | `HoldingsOverview` — 요약(`Price.krw`·`Price.usd`)과 `items[]` | ASSET 초당 5회 |
| `GET /api/v1/buying-power?currency=KRW` · `?currency=USD` | `cashBuyingPower`(현금 기반 매수 가능 금액, 미수 미발생 기준) | ORDER_INFO 초당 6회(09:00~09:10 3회) |
| `GET /api/v1/orders?status=OPEN` | 진행 중 주문 전부(쪽 나눔 없음) | ORDER_HISTORY 초당 5회 |
| `GET /api/v1/orders?status=CLOSED&from=&limit=100&cursor=` | 최근 30일 끝난 주문, 최대 3쪽 | ORDER_HISTORY |

계좌 문맥 API는 헤더 `X-Tossinvest-Account: {accountSeq}`가 필요하다. 숫자는 모두 JSON 문자열 decimal이고(소수 자릿수 들쭉날쭉), 시각은 ISO-8601 `+09:00`이다.
예수금 엔드포인트는 없다 — 현금 쪽 수치는 `cashBuyingPower` 하나뿐이라 화면은 '예수금'·'총자산'이라 부르지 않는다.

## 2. 흐름

화면 탭 `/paper/kr/real`·`/paper/us/real` → 백엔드 `GET /api/brokerage/account?market=KR|US`(운영자 전용) → 수집기 `GET /toss/account`(X-Service-Token) → 토스.

- **저장하지 않는다.** DB 표·스냅숏·수집 태스크·마이그레이션이 없다. 수집기 메모리에만 둔다(S3 백업·배포 전 덤프·QA 복원·태스크 기록·`/status`로 퍼지지 않음).
- **수집기 캐시** — 성공 10초 TTL(2026-11-06 60초에서 줄임 — [ADR 0030](../adr/0030-us-trading-costs-backfill.md), 화면 새로고침 주기. 나이는 갱신 시작부터, 주기 흔들림 여유 1초). 갱신이 실패하면 직전 성공값 **전체**를 `isStale: true`로 그 값을 받은 시각(`fetchedAt`)부터 최대 30분 보이고(그 뒤 버림), 실패 직후 30초는 토스를 다시 부르지 않는다.
  한 갱신의 호출이 **모두** 성공해야 캐시를 바꾼다(새 값과 옛 값을 섞지 않음). 동시에 들어온 요청은 기다리지 않는다 — 갱신 중이면 지금 캐시를 그대로,
  캐시가 없으면 `reason: "refreshing"`을 바로 돌려준다.
- **호출** — 갱신 한 번: holdings 1 + buying-power 2 + orders OPEN 1 + CLOSED 1~3 = 5~7회. `accountSeq`는 메모리에 두고 `/accounts`는 처음과
  `account-not-found` 뒤에만 부른다. 호출 하나 timeout `(3, 4)`초, 새 호출은 갱신 시작 뒤 12초 안에서만 보낸다(토큰을 얻은 뒤·401 재시도 직전에도 남은 시간을
  다시 보고, 0 이하면 보내지 않고 `timeout`). 진행 중인 토큰 발급(연결 8초 + 읽기 8초)은 끊지 않는다 — 발급 응답을 못 받으면 서버에서는 새 토큰이 나가 운영 1분봉의
  토큰만 무효가 될 수 있다. 그래서 최악은 약 28초이고 백엔드는 35초, 화면은 40초를 기다린다. 429는 잠들지 않고 바로 실패.
- **토큰** — 계좌 경로의 401은 다른 곳이 이미 새 토큰을 받아 두었으면 발급 없이 그 토큰으로 한 번 더 보낸다. 아니면 `expired-token`·`token-revoked`·`invalid-token`일
  때만 토큰을 버리고 다시 받으며, 이 재발급은 10분에 한 번까지다.
- **켬** — 수집기 환경변수 `TOSS_ACCOUNT_ENABLED`가 정확히 `true`(앞뒤 공백 제거)이고 서비스 토큰(`API_TOKEN`)이 있을 때만. 기반 `docker-compose.yml`은
  `"false"` 고정이고 `compose.vultr.yml`만 서버 `.env` 값을 넘긴다(운영 서버에서만 켬). 백엔드는 이 이름을 읽지 않는다.

## 3. 수집기 `GET /toss/account`

토큰이 없거나 틀리면 401(다른 수집기 경로와 같음). 그 밖에는 **늘 200**. 시각은 KST `isoformat(timespec="seconds")`(예 `2026-11-05T14:03:12+09:00`).
숫자 칸은 토스 원문 문자열을 그대로 옮기되, 문자열이 아니거나 없으면 `null`.

| 필드 | 형 | 규칙 |
|---|---|---|
| `ok` | bool | 보일 데이터(새 값이나 이전 값)가 있으면 true |
| `enabled` | bool | 켬 조건(§2)을 모두 채우면 true |
| `reason` | string \| null | `ok`이고 새 값이면 null. 아니면 아래 표의 하나(이전 값을 보일 때는 그 갱신이 실패한 사유) |
| `errorCode` | string \| null | 토스 `error.code`가 `^[a-z0-9-]{1,40}$`일 때만(토큰 발급 실패는 토스 code가 아니라 null). 토스 `message`·응답 본문은 어디에도 싣지 않음 |
| `fetchedAt` | string \| null | 보이는 데이터를 받은 시각 |
| `isStale` | bool | 이전 값을 보이면 true |
| `staleSince` | string \| null | `isStale`일 때 첫 실패 시각 |
| `account` | object \| null | `{label: "토스증권 종합매매", type: "BROKERAGE"}`. 번호·`accountSeq` 없음 |
| `accountCount` | int \| null | `/accounts`가 준 BROKERAGE 계좌 수(`no-account` 안내용) |
| `sides` | `{KR: Side, US: Side}` \| null | |
| `closedFrom` | string \| null | CLOSED 조회 시작일 `YYYY-MM-DD`(KST 오늘 − 30일) |
| `closedTruncated` | bool | CLOSED를 3쪽에서 끊었거나 `hasNext`인데 `nextCursor`가 없으면 true. 데이터 없으면 false |
| `unclassifiedCount` | int | 보유 `(KR,KRW)`·`(US,USD)`에 맞지 않는 항목 + 통화가 KRW·USD가 아닌 주문. 데이터 없으면 0 |

**reason 값**

| reason | 언제 |
|---|---|
| `disabled` | `TOSS_ACCOUNT_ENABLED`가 true가 아님 |
| `no-service-token` | 서비스 토큰 없이 뜬 수집기(`COLLECTOR_ALLOW_NO_TOKEN`) |
| `not-configured` | `TOSS_CLIENT_ID`·`SECRET` 없음 |
| `ip-not-allowed` | 토스 403 `ip-not-allowed` 또는 토큰 발급 403 |
| `auth-failed` | 재발급 대상이 아닌 401, 재발급 뒤에도 401, 토큰 발급 실패 |
| `rate-limited` | 429 |
| `no-account` | BROKERAGE 계좌가 0개이거나 2개 이상, 또는 `accountSeq`를 다시 찾은 뒤에도 `account-not-found` |
| `refreshing` | 다른 요청이 갱신 중이고 보일 캐시가 없음 |
| `timeout` | 갱신 전체 예산(12초) 초과 |
| `upstream-error` | 그 밖의 토스 오류·형식 오류 |
| `internal` | 수집기 안의 예상 못 한 예외(로그에는 예외 클래스 이름만) |

**Side** (`KR`은 원화, `US`는 달러)

| 필드 | 출처 |
|---|---|
| `currency` | `"KRW"` / `"USD"` |
| `buyingPower` | 그 통화의 `cashBuyingPower`(응답의 `currency`가 요청과 다르면 null) |
| `summary` | `HoldingsOverview`에서 KR은 `.krw`, US는 `.usd`: `purchaseAmount`(`totalPurchaseAmount`), `marketValue`(`marketValue.amount`), `marketValueAfterCost`(`marketValue.amountAfterCost`), `profitLoss`(`profitLoss.amount`), `profitLossAfterCost`(`profitLoss.amountAfterCost`), `dailyProfitLoss`(`dailyProfitLoss.amount`). 요약의 `rate`·`rateAfterCost`·`dailyProfitLoss.rate`(원화 환산 합산)는 옮기지 않음 |
| `holdings` | Holding[] — `marketCountry`·`currency`가 둘 다 그 쪽일 때만(`symbol`이 없는 항목은 빼고 `unclassifiedCount`에 셈) |
| `openOrders` | Order[] — `currency`로 나눔(KRW→KR, USD→US) |
| `closedOrders` | Order[] — 같은 규칙, `orderedAt` 내림차순 |

**Holding** — 모두 string \| null: `symbol`, `name`, `marketCountry`, `currency`, `quantity`, `lastPrice`, `averagePurchasePrice`,
`purchaseAmount`(`marketValue.purchaseAmount`), `marketValue`(`marketValue.amount`), `marketValueAfterCost`, `profitLoss`(`profitLoss.amount`), `profitLossAfterCost`,
`profitLossRate`(`profitLoss.rate`, 소수 0.1077 = 10.77%), `profitLossRateAfterCost`, `dailyProfitLoss`(`dailyProfitLoss.amount`), `dailyProfitLossRate`.
종목 하나는 한 통화라 항목의 비율은 섞이지 않는다.

**Order** — 모두 string \| null: `symbol`, `name`(같은 symbol의 보유 이름표에서만 — `/stocks`를 부르지 않음), `side`, `orderType`, `timeInForce`, `status`(모르는 enum도 원문),
`currency`, `price`, `quantity`, `orderAmount`, `orderedAt`, `canceledAt`, `filledQuantity`, `averageFilledPrice`, `filledAmount`, `commission`, `tax`, `filledAt`, `settlementDate`
(마지막 일곱은 `execution.*`). `orderId`는 OPEN·CLOSED 사이 중복 제거(같은 id가 두 쪽에 있으면 CLOSED를 남김)에만 쓰고 **응답에 싣지 않는다**.

## 4. 백엔드 `GET /api/brokerage/account?market=KR|US`

운영자 전용(AccessPolicy owner). `market`이 없거나 틀리면 400(`Params.oneOf`), 그 밖에는 **늘 200**(paper·live와 같은 약속).
숫자는 JSON number 또는 null(`BigDecimal`, 변환 실패는 예외 없이 null — 받는 모양은 부호·정수부·선택 소수부의 평범한 decimal이고 토스 상한대로 30자까지, 지수 표기·쉼표·NaN은 null). 시각은 `Kst.DISPLAY`(`yyyy-MM-dd HH:mm`).

| 필드 | 형 | 규칙 |
|---|---|---|
| `available` | bool | `state == "OK"` |
| `state` | enum | `OK`·`DISABLED`·`NOT_CONFIGURED`·`COLLECTOR_UNREACHABLE`·`IP_NOT_ALLOWED`·`AUTH_FAILED`·`RATE_LIMITED`·`NO_ACCOUNT`·`REFRESHING`·`UPSTREAM_ERROR` |
| `message` | string \| null | state별 고정 한국어 문구(수집기·토스 문구를 옮기지 않음). OK이고 새 값이면 null |
| `market` / `currency` | string | `KR`→`KRW`, `US`→`USD` |
| `accountLabel` | string \| null | 수집기 `account.label` |
| `accountCount` | int \| null | |
| `fetchedAtKst` / `staleSinceKst` | string \| null | 파싱 실패는 null |
| `ageSeconds` | int \| null | 주입한 Clock 기준 |
| `isStale` | bool | |
| `staleReason` | string \| null | 이전 값을 보일 때 그 실패의 state(아래 대응 표) |
| `upstreamCode` | string \| null | 수집기 `errorCode`(같은 정규식으로 다시 확인) |
| `buyingPower` | number \| null | |
| `summary` | object \| null | `purchaseAmount`, `marketValue`, `marketValueAfterCost`, `profitLoss`, `profitLossAfterCost`, `dailyProfitLoss`, `profitLossPct`, `profitLossPctAfterCost`. 두 Pct는 **대시보드 계산** — 같은 통화의 `profitLoss × 100 / purchaseAmount`(`MathContext.DECIMAL64`, 소수 4자리 HALF_UP), 매입금액이 null·0이면 null. 일간 수익률은 계산하지 않음 |
| `holdings` | HoldingRow[] | §3 Holding과 같은 이름. `*Rate` 세 칸은 `*Pct`(= 비율 × 100)로. 숫자 칸 number \| null, `symbol` string, `name` string \| null |
| `openOrders` / `closedOrders` | OrderRow[] | enum 칸은 원문 string, 숫자 칸 number \| null, `orderedAtKst`·`canceledAtKst`·`filledAtKst`(`Kst.DISPLAY`, 실패 null), `settlementDate` 원문 |
| `closedFromDate` | string \| null | |
| `closedTruncated` | bool | |
| `unclassifiedCount` | int | 수집기 값 + 백엔드에서 통화가 맞지 않아 뺀 항목 |

**수집기 → state 대응**

| 수집기 | state |
|---|---|
| `read-mode=store_only`(공개 데모) — 수집기를 부르지 않음 | `DISABLED` |
| `enabled:false`(`disabled`·`no-service-token`) | `DISABLED` |
| `not-configured`·`ip-not-allowed`·`auth-failed`·`rate-limited`·`no-account`·`refreshing` | 같은 이름의 state |
| `timeout`·`upstream-error`·`internal`·모르는 값·`ok:true`인데 `sides` 없음 | `UPSTREAM_ERROR` |
| 수집기 불통(연결 실패·시간 초과·4xx·5xx) | `COLLECTOR_UNREACHABLE` |
| `ok:true`, `isStale:false` | `OK` |
| `ok:true`, `isStale:true` | `OK`, `isStale:true`, `staleReason`은 그 실패의 state |

수집기 호출은 전용 조용한 경로(읽기 35초 — §2의 최악값보다 길게)로 한다 — 실패하면 로그에 상태 코드나 예외 클래스 이름만 남기고 응답 본문은 남기지 않는다.

## 5. 화면 — 두 시장 화면의 탭 `실제 계좌`(키 `real`)

- `PAPER_TABS` 맨 끝(설정 뒤)에 `{ key: "real", label: "실제 계좌", opensIn: null, upcoming: null }`. 주소 `/paper/kr/real`·`/paper/us/real`.
- `PaperScreen`이 그 탭일 때만 `BrokerageSection`을 마운트한다 — 읽기는 탭을 열 때만. `useApi(endpoints.brokerage.account(market), 0, { followRefresh: false, timeoutMs: 40_000 })`,
  '다시 읽기' 단추(`reload`).
- 맨 위 `Banner`(`LockIcon`): "실제 계좌(토스증권) — 모의 장부와 별개 · 읽기 전용 · 이 화면에서는 주문할 수 없습니다". 한국 탭은 "원화 자산만 — 달러 자산은 모의매매(미국)의 실제 계좌 탭",
  미국 탭은 그 반대와 링크(`paperTabPath("real", 다른 시장)`).
- 요약: `StatGrid`·`StatTile` — 평가금액, 매입금액, 평가손익(대시보드 계산 손익률과 함께), 일간 손익(금액만), 매수 가능 금액("통화별 현금 기반 — 두 화면의 금액을 더하지 마세요").
- 보유·주문: `DataTable`. 미국 소수점 수량은 최대 6자리(`lib/brokerage.ts`의 수량 포맷). 주문 상태·방향·유형은 한국어 이름표, 모르는 값은 원문.
- 상태: 꺼짐(`DISABLED`)은 안내 배너만, 그 밖의 실패는 고정 문구 + 다시 시도, `isStale`이나 화면 `refreshError`는 '이전 값'과 받은 시각, null은 '—',
  보유가 없으면 '보유 종목 없음', `closedTruncated`이면 "최근 끝난 주문은 일부만 받았습니다", `unclassifiedCount > 0`이면 "분류하지 못한 항목 N개".
- 쓰지 않는 것: `Hero`·`AssetRow`·'출발 이후' 칩(모의 계좌로 읽히지 않게), 주문·취소 단추, `apiPost`·`apiDelete`.
- 모듈 위치: `components/screens/brokerage/*`, `lib/brokerage.ts`, `lib/types/brokerage.ts`(배럴 `lib/types.ts`로 내보내지 않음), `endpoints.brokerage.account`, `SOURCES.tossAccount`
  ("토스증권 Open API (공식) — 실제 계좌 조회(읽기 전용, 모의 장부와 별개)").

## 6. 안전 장치와 지키는 시험

| 장치 | 시험 |
|---|---|
| 공유 `toss` 세션 가드 — GET과 `POST /oauth2/token`만, `https://openapi.tossinvest.com`만, 위반은 네트워크 전에 `TossReadOnlyViolation` | `collector/tests/test_toss_account.py`(쓰기 경로 6개·다른 호스트·http 차단, `HTTPAdapter.send` 기록기), AST(`toss.py`의 유일한 쓰기 호출은 `AUTH_URL` POST, `toss_account.py`에는 없음) |
| 계좌 경로의 401은 `expired-token`·`token-revoked`·`invalid-token`만 재발급, 10분에 1회 | 같은 파일 |
| 오류 message·본문 미전달, 예상 못 한 예외는 클래스 이름만 | 같은 파일(카나리), `CollectorClientAccountTest`(카나리), `BrokerageServiceTest` |
| `accountNo`·`accountSeq`·`orderId`·모르는 필드 미전달 | `test_toss_account.py`, `BrokerageServiceTest` |
| 저장하지 않음·다른 기능과 분리 | `ArchitectureRulesTest.brokerageIsIsolated`, `BrokerageIsolationTest` |
| 운영자 전용·GET만 | `AccessPolicyTest.brokerageRoutesAreOwnerOnlyAndGetOnly`, `ApiIntegrationTest` |
| 서버에서만 켬 | `.github/workflows/ci.yml` compose 해석 단언(로컬·QA는 셸 값과 무관하게 false, Vultr는 기본 false·env 전달, backend에 이 이름 없음) |
| 화면이 모의 모듈과 섞이지 않고 쓰기 호출이 없음 | `frontend/src/components/screens/brokerage/__tests__/brokerageBoundary.test.ts`, `paperBrokerage.test.tsx` |
| 시험이 실제 토스를 부르지 않음 | `test_toss_account.py` autouse fixture(키 가짜·tossinvest 호스트로 가는 `send`는 예외) |

## 7. 한계(1단계)

- 모의 장부 개요를 못 읽으면 `PaperScreen`이 탭 줄을 그리지 않아 실제 계좌 탭에도 닿지 못한다.
- 390px 화면에서는 탭 여덟 개 가운데 마지막(실제 계좌)이 가로 스크롤 밖에서 시작한다.
- KRW·USD 매수 가능 금액이 통합증거금·자동 환전으로 서로 겹치는지는 스펙으로 확인되지 않았다 — 화면은 더하지 말라고만 적는다.
- BROKERAGE 계좌가 둘 이상이면 고르지 않고 `NO_ACCOUNT`로 멈춘다.
- 수집기를 다시 띄우면 메모리 캐시가 비어 처음 한 번은 토스를 새로 부른다.

## 8. 검증 출력 규칙

에이전트(사람이 아닌 자동 작업)는 운영 응답의 금액·수량·개수·종목을 출력하거나 문서·커밋·QA 기록에 적지 않는다. 서버 확인은 아래 한 줄만 쓴다.

```bash
docker compose exec -T collector python -c 'import json,os,urllib.request as u; d=json.load(u.urlopen(u.Request("http://localhost:8000/toss/account",headers={"X-Service-Token":os.environ["COLLECTOR_API_TOKEN"]}))); print({k:d.get(k) for k in ("ok","enabled","reason","isStale")}, {s:sorted(v) for s,v in (d.get("sides") or {}).items()})'
```

(수집기 이미지에는 curl이 없어 파이썬 표준 라이브러리로 부른다. 출력은 상태와 각 쪽의 **키 이름**뿐이다.)

화면 `/paper/kr/real`·`/paper/us/real`의 숫자 확인은 운영자가 직접 한다.
