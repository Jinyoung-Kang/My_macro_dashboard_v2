# 설계 — 미국 모의 계좌에 토스 매매 수수료·매도 제비용 반영과 과거 소급, ISA 장부 정렬, 실제 계좌·ISA 새로고침 주기와 기준 시각

- 상태: **확정**(2026-11-06 사용자 승인). 결정 기록은 [ADR 0030](../adr/0030-us-trading-costs-backfill.md). 이 문서는 수집기·백엔드·화면이 함께 따르는 **계약**이다.
- 사용자 요청: "모든 계좌(규칙·Claude1·Claude2)에 매매 수수료(매매 비용 포함)를 넣고, 토스증권 수수료를 포함해 모든 계좌의 손익을 다시 계산. [ISA 계좌]-[장부]에서 열을 누르면 오름·내림차순 정렬.
  [실제 계좌]와 [ISA 계좌]에 새로고침 주기 상자를 두고 고른 주기에 따라 그 시각 기준으로 손익을 다시 계산하고 기준 시각(초까지)을 표시."
- 사용자 결정(질문 답): 미국 수수료 **0.1%**, **과거 체결까지 소급**(당시 수량·체결가는 그대로, 비용만), **벤치마크 포함 미국 다섯 계좌 전부**, 매도 **SEC fee·FINRA TAF 포함**.

## 0. 확인한 사실

| 항목 | 값 | 출처 |
|---|---|---|
| 토스 국내 매매 수수료(이 계좌) | 0.015% (2021-01-01 ~ 무기한) | 토스 Open API `GET /api/v1/commissions`(2026-11-06) |
| 토스 미국 매매 수수료(이 계좌) | 0.1% (종료일 2026-11-07, 그 뒤 비율은 그날 다시 확인) | 같은 API |
| SEC Section 31 fee | 매도 금액 $1,000,000당 $20.60(2026-04-04부터, 그 전 $0.00) | [SEC Fee Rate Advisory 2026-2](https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2) |
| FINRA Trading Activity Fee | 매도 1주당 $0.000195, 1건 상한 $9.79(2026) | [FINRA fee adjustment schedule](https://www.finra.org/rules-guidance/rule-filings/sr-finra-2024-019/fee-adjustment-schedule) |

- **한국 모의 다섯 계좌는 출발부터 토스와 같은 비용 모델**이다: 수수료 `kr.commissionBp` 1.5bp(= 0.015%), 매도세(코스피 거래세 5bp + 농특세 15bp, 코스닥 20bp, ETF 0), 슬리피지 5bp(`analytics/KrxCosts`).
  바꿀 것이 없다 — 고정본·장부 그대로.
- **미국 모의 다섯 계좌(`rules`·`claude`·`claude2`·`bench_spy`·`bench_mix`)는 수수료 0**이었다(체결가에 슬리피지 5bp만, `paper_fills.fee·tax` 늘 0 — 명세 2026-10-24 L5·D9).
- 토스 공개 수수료 페이지는 JS로만 그려져 읽지 못했다. 토스가 SEC fee·TAF를 고객에게 따로 받는지는 확인하지 못했다(사용자 결정으로 넣음 — 설정으로 0으로 둘 수 있음).

## 1. 미국 체결 비용 — 앞으로의 체결

- 새 설정 키(최상위 — 미국 키는 접두어 없음, `slippageBp` 선례):
  - `commissionBp` — 매매 수수료(bp), 기본 **10**(0.1%), 범위 0~100.
  - `regFees.secPerMillion` — SEC fee($/백만 달러, 매도만), 기본 **20.60**, 범위 0~1000.
  - `regFees.tafPerShare` — FINRA TAF($/주, 매도만), 기본 **0.000195**, 범위 0~0.01.
  - `regFees.tafMaxPerTrade` — TAF 1건 상한($), 기본 **9.79**, 범위 0~100.
  `PaperSettingKeys`·`PaperSettings.from`·설정 화면에 들어가고 저장 이력·설정 판(`settingsInForceAt`)을 따른다. 한국 키(`kr.*`)는 그대로.
- 계산(체결 하나, 금액은 `BigDecimal`, 달러 센트까지):
  - 체결가 = 지금처럼 관측가 × (1 ± 슬리피지)(가격 정의 불변), 체결 금액 gross = 수량 × 체결가.
  - 수수료 fee = round_half_up(gross × commissionBp / 10,000, 센트). 매수·매도 모두.
  - 제비용 tax(매도만) = ceil(gross × secPerMillion / 1,000,000, 센트) + ceil(min(수량 × tafPerShare, tafMaxPerTrade), 센트). 체결가가 tafPerShare보다 작으면 TAF 0(FINRA 규칙).
  - 현금 흐름: 매수 −(gross + fee), 매도 +(gross − fee − tax). `paper_fills.fee` = 수수료, `tax` = 제비용, `slippage_cost` = 0(슬리피지는 가격에).
  - 매수 가능 수량: floor(예산 ÷ (체결가 × (1 + commissionBp/10,000)))이고 현금 한도도 수수료를 넣어 본다.
  - 사후 체결(backfill)·미국 시각 지정 체결(`UsTimedFills`)·스탑·벤치마크 체결 모두 같은 계산.
- 그 체결 때 유효한 설정 판의 비율을 쓴다. 비율이 바뀌면(예: 11/07 뒤 토스 미국 비율) 설정만 바꾸면 그 뒤 체결부터 적용된다.

## 2. 과거 소급

- 새 표 `paper_cost_adjustments`(`db/migrations/V26__paper_cost_adjustments.sql`, 백엔드 소유): `fill_id BIGINT PRIMARY KEY`(체결 하나에 한 행 — 두 번 넣을 수 없음),
  `book_code`, `market`, `fee NUMERIC(18,4)`, `tax NUMERIC(18,4)`, `cash_delta NUMERIC(18,4)`(≤ 0), `fill_date DATE`(체결이 장부에 반영된 거래일 — `observation_date`), `settings_version INTEGER`,
  `rates JSONB`(쓴 비율), `reason TEXT`(`us-cost-backfill`), `created_at`. 체결 행(`paper_fills`)은 고치지 않는다(`paper_fill_confirmations` 선례).
- 운영자 작업 `POST /api/paper/admin/cost-backfill` 본문 `{market:"US", confirm:"비용 소급"}`(운영자 전용, `AccessPolicy`, 확인 글자 서버 재검사):
  - 장부 잠금(`PaperLedgerService.exclusively`) 안, 한 트랜잭션에서.
  - 대상: 미국 다섯 계좌의 체결 가운데 `fee = 0 AND tax = 0`이고 조정 행이 없는 것(새 비용으로 이미 체결된 행·이미 조정한 행은 건너뜀 — 두 번 돌려도 결과는 한 번).
  - 체결마다 §1 계산(지금 유효한 설정 판의 비율)으로 조정 행을 넣고, 계좌 현금 `paper_book_state.cash`에 cash_delta 합을 더한다.
  - 일별 순자산 줄: 그 계좌의 `paper_nav_daily`에서 날짜 d마다 nav_d += Σ(fill_date ≤ d인 조정의 cash_delta), 현금 칸이 있으면 같이. 순자산에서 계산되는 수익률·노출·통계(누적 수익률·MDD·샤프·초과 수익·
    트랙 레코드 등)는 다시 계산하거나, 읽을 때 계산되면 그대로 따라오게 한다(구현이 확인해 명세 §9에 적음).
  - 결과 `{ok, market, books:[{code, fills, fee, tax, cashDelta}], navRowsUpdated}`(모의 자료라 금액을 실어도 됨).
- 소급 비용은 **당시 수량·체결가·결정을 바꾸지 않는다**(그때 수수료가 있었다면 수량이 조금 달랐을 것). 화면 미국 체결 표에 소급 행은 '비용 소급 — 수량은 당시 그대로' 표시.
- 소급은 배포 뒤 운영 서버에서 한 번 돌린다. 백업·QA 복원으로 함께 옮겨진다(조정 행이 있으면 다시 돌려도 건너뜀).

## 3. 실험 조건·패킷

- 미국 Claude 패킷(계좌1·계좌2·자유 시점 판)의 비용 줄에 수수료·제비용을 싣는다(지금 `slippageBp`만) — 한국 패킷의 `commissionBp`·`sellTax`와 같은 모양. 실험 조건 변경이라 ADR 0018 기록에 한 줄을 남기고
  패킷·렌더 고정본을 갱신한다(바뀐 것은 비용 칸·문장뿐임을 시험으로).
- 미국 실행 감사·반사실(`ExecutionAudit` 등)이 비용을 빼고 어림하던 곳은 그대로 두고 설명 문구만 맞춘다(범위 밖).

## 4. 화면 — 미국 비용

- 미국 체결 표에 수수료·제비용 칸(한국 `krFills`의 `fee`·`tax`와 같은 응답 모양 — `PaperQueryService`가 미국에도 실음), 소급 조정이 있으면 그 값과 '비용 소급' 표시.
- 설정 화면은 새 키 넷을 보인다(기존 설정 표 생성 방식 그대로).

## 5. ISA 장부 정렬

- `IsaLedgerTable`의 열마다 `sortValue`(시각·종류·종목·수량·체결가·금액·수수료·세금·출처·메모 제외) — 머리를 누르면 오름 → 내림(`lib/dataTable` `nextSort`·`ariaSortOf`), 기본은 시각 내림차순.
  보유·지시·지난 지시 표에도 같은 방식(종목·수량·평가 등 숫자·글 열).

## 6. 새로고침 주기와 기준 시각

- [실제 계좌]·[ISA 계좌] 탭 머리에 주기 상자(`components/LiveIntervalSelect` 재사용, 값은 `hooks/useLiveSeconds` — 다른 화면 '실시간 시세'와 한 값 공유)와 **기준 시각 `YYYY-MM-DD HH:mm:ss KST`**.
- **실제 계좌**: 고른 주기(끄기 또는 10초 이상 — 5초는 10초로 올려 씀)로 `GET /api/brokerage/account`를 다시 읽는다. 토스가 그 시각 가격으로 계산한 손익이 바뀐다.
  기준 시각 = 수집기가 토스에서 받은 시각(`fetchedAt`, 초까지 — 백엔드가 초까지 내려보냄). 실제 매매 칸의 사전 조회 시각도 초까지.
- **수집기 계좌 캐시 60초 → 10초**(ADR 0025 결정 3 개정): 성공값 TTL 10초(실패 때 이전 값 30분·실패 뒤 30초 쉼은 그대로). 한 번 갱신에 토스 5~7회 — 호출 한도 안.
- **ISA**: 보유 종목의 실시간 가격(`hooks/useLivePrices` — ADR 0024 SSE, 표시 전용)을 고른 주기로 받아 화면에서 평가액·손익·비중을 다시 계산한다(평가액 = 현금 + Σ수량 × 실시간 가격,
  손익 = 평가액 − 순입금). 기준 시각 = 받은 가격의 시각 중 가장 이른 것(초까지). 가격을 못 받은 종목은 서버가 준 직전 종가로 두고 '직전 종가' 표시. 서버 장부·지시는 그대로(직전 종가).
- 화면 경계 시험(`isaBoundary`·`brokerageBoundary`)의 허용 목록을 이 변경에 맞춰 고치되 쓰기 금지 규칙은 그대로.

## 7. 시험
- 미국 체결 비용: 매수·매도 수수료 반올림, SEC 올림, TAF 상한·저가 주식 0, 매수 가능 수량, 시각 지정·사후 체결·스탑·벤치마크, 설정 판별 비율. 한국은 고정본 그대로.
- 소급: 조정 행 한 번(두 번 돌려도 같음), 새 비용 체결은 건너뜀, 현금·순자산 줄·통계, 확인 글자, 운영자 전용.
- 패킷 고정본: 비용 칸·문장만 바뀜.
- 화면: 미국 체결 비용 칸, ISA 정렬(오름·내림·aria-sort), 주기 상자·기준 시각(초까지)·ISA 실시간 재계산, 경계 시험.
- 수집기: 계좌 캐시 10초.

## 9. 구현에서 정한 것
(구현 뒤 채움)
