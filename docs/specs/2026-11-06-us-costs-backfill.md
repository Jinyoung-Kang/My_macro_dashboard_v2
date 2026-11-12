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
  - 체결마다 §1 계산(**그 체결 때 유효했던 설정 판**의 비율 — `settingsInForceAt`에 체결 행을 쓴 시각, 한국 확정 조정 d7과 같음)으로 조정 행을 넣고, 계좌 현금 `paper_book_state.cash`에 cash_delta 합을 더한다.
    ADR 0030 전 판에는 비용 키가 없어 기본 비율로 읽힌다(사용자 결정과 같음). 이력보다 앞선 체결도 기본 비율(판 번호 없음). 비용이 0원으로 나온 체결(비율 0인 판의 체결)은 조정 행을 넣지 않는다.
  - 일별 순자산 줄: 그 계좌의 `paper_nav_daily`에서 날짜 d마다 nav_d += Σ(fill_date ≤ d인 조정의 cash_delta), 현금 칸이 있으면 같이. 순자산에서 계산되는 수익률·노출·통계(누적 수익률·MDD·샤프·초과 수익·
    트랙 레코드 등)는 다시 계산하거나, 읽을 때 계산되면 그대로 따라오게 한다(구현이 확인해 명세 §9에 적음).
  - 결과 `{ok, market, books:[{code, fills, fee, tax, cashDelta}], navRowsUpdated, versions:[{settingsVersion, rates, fills}], zeroCostFills}`(모의 자료라 금액을 실어도 됨).
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
  같은 시각을 '보유 종목(실제)' 카드의 부제에도 적는다(2026-11-13 사용자 요청 — `데이터 기준(갱신) 시각 YYYY-MM-DD HH:mm:ss KST`, 이전 값을 보이는 중이면
  `· 이전 값 — 그 뒤 새로 읽지 못함`, 모르면 `—`. `lib/brokerage` `brokerageHoldingsBasisText` — 응답 계약은 그대로).
- **수집기 계좌 캐시 60초 → 10초**(ADR 0025 결정 3 개정): 성공값 TTL 10초(실패 때 이전 값 30분·실패 뒤 30초 쉼은 그대로). 한 번 갱신에 토스 5~7회 — 호출 한도 안.
  나이는 갱신을 시작한 시각부터 세고 화면 주기의 흔들림에 1초 여유를 둔다(시작부터 9초가 지난 요청은 새로 읽음 — 10초 주기 요청마다 새 값).
- **ISA**: 보유 종목의 실시간 가격(`hooks/useLivePrices` — ADR 0024 SSE, 표시 전용)을 고른 주기로 받아 화면에서 평가액·손익·비중을 다시 계산한다(평가액 = 현금 + Σ수량 × 실시간 가격,
  손익 = 평가액 − 순입금). 기준 시각 = 받은 가격의 시각 중 가장 이른 것(초까지). 가격을 못 받은 종목은 서버가 준 직전 종가로 두고 '직전 종가' 표시. 서버 장부·지시는 그대로(직전 종가).
  가격을 모르는 보유가 남으면 손익·손익률은 비운다(서버 요약과 같은 정의). 멈춘 값은 실시간으로 쓰지 않는다 — 뒤 응답에서 빠진 종목은 직전 종가, 연결이 끊기면 서버 값(`useLivePrices` 계약, QA-183·184).
- 화면 경계 시험(`isaBoundary`·`brokerageBoundary`)의 허용 목록을 이 변경에 맞춰 고치되 쓰기 금지 규칙은 그대로.

## 7. 시험
- 미국 체결 비용: 매수·매도 수수료 반올림, SEC 올림, TAF 상한·저가 주식 0, 매수 가능 수량, 시각 지정·사후 체결·스탑·벤치마크, 설정 판별 비율. 한국은 고정본 그대로.
- 소급: 조정 행 한 번(두 번 돌려도 같음), 새 비용 체결은 건너뜀, 현금·순자산 줄·통계, 확인 글자, 운영자 전용.
- 패킷 고정본: 비용 칸·문장만 바뀜.
- 화면: 미국 체결 비용 칸, ISA 정렬(오름·내림·aria-sort), 주기 상자·기준 시각(초까지)·ISA 실시간 재계산, 경계 시험.
- 수집기: 계좌 캐시 10초(갱신 시작부터, 여유 1초).

## 9. 구현에서 정한 것

- **매수 가능 수량**: floor(예산 ÷ (체결가 × (1 + 수수료율)))에서 수수료를 센트 반올림해 유출이 예산을 넘으면 한 주씩 줄인다(현금 음수 방지). 비율이 모두 0이면 ADR 0030 전 장부와 바이트까지 같다
  (고정본 `ledger-us-week.txt` — 기본 비용 판은 `ledger-us-week-costs.txt`).
- **비용을 세는 금액**: 저장된 체결 금액(`paper_fills.gross`, 소수 4자리)에서 센다 — 앞으로의 체결과 소급이 같은 값. 아주 작은 매도에서 제비용이 금액보다 커도 막지 않는다.
- **옛 설정 행**: 운영 서버의 지금 설정 행에는 새 키 넷이 없어 기본값(10bp·20.60·0.000195·9.79)으로 읽고 `fallbacks`에 남긴다(판을 자동으로 올리지 않음 — 배포 뒤 다음 미국 체결부터 적용).
  키 넷 모두 규칙 계좌 영향(`affectsRules`).
- **소급 비율**: 체결마다 그때 유효했던 판(리뷰 반영 — 처음에는 지금 판이었으나 실행 순서·소급 전 비율 변경에 따라 값이 달라져 바꿈). 0원 체결은 조정 행 없이 건너뛰어
  (`zeroCostFills`로 셈) 0원 행이 체결을 '조정함'으로 막지 않는다 — 그래서 '비율 모두 0이면 400' 거절은 없앴다. 시장은 `US`만. 결과에 쓴 판별 비율·건수(`versions`)를 싣고,
  조정한 체결이 0인 계좌도 싣는다. 작업 기록 `cost-backfill`을 남긴다.
- **장부 처리**: 비용이 있는 반영 거래일마다 그 날 이후 순자산 줄의 현금·순자산에 차이를 더하고 노출을 다시 센다(평가액은 그대로). `paper_book_state`도 현금·순자산·노출을 함께. 통계(누적 수익률·MDD·
  샤프·초과 수익)는 읽을 때 순자산 줄에서 계산하므로 저절로 따라온다 — 통계는 첫 순자산 줄부터 재므로 출발일(첫 줄) 체결의 비용은 통계에는 빠지고 시작 현금 대비 수익률(`returnPct`)에는
  들어간다(출발 전 비용의 기존 정의 그대로). 지난 주간 복기·결정 패킷은 그때의 기록이라 다시 쓰지 않는다.
- **패킷**: 미국 Claude 패킷 `12_hardRules`에 `commissionBp`·`slippageBp`·`sellRegFees{secPerMillion, tafPerShare, tafMaxPerTrade}`(한국 `sellTax`와 달리 세금이 아니라 이 이름)와 비용 문장 한 줄.
  시스템 프롬프트·렌더 고정본은 그대로(캐시 블록 불변). 장중 확인·판단 패킷은 `4_portfolio.expected.note`만 '(슬리피지·수수료·매도 제비용 빼고 어림)'. 패킷 목표 크기 경고 기준 +200토큰.
- **응답**: 미국 체결 행에 `fee`·`tax`(달러 소수 2자리)·`costAdjustment`, 맨 위에 `costAdjustmentTotal{rows, fee, tax, cashDelta}`.
- **V26**: `fill_id`·`book_code`에 외래키 `ON DELETE CASCADE`(계좌 초기화 때 함께 지움), CHECK(fee·tax ≥ 0, cash_delta ≤ 0, market US·KR), `PaperStore.ready()`가 V26 표를 요구.
- **화면**: 규칙·계좌1·벤치마크 체결 표에 '수수료·제비용(달러)' 칸, 계좌2(시각 지정) 표는 폭을 지키려 금액 칸 셋째 줄에 '비용 X · Y'. 표 위에 '비용 소급 N건 … — 수량은 당시 그대로' 한 줄.
  실제 계좌의 주기 상자·기준 시각은 조회 칸 머리(응답이 꺼짐이면 숨기고 다시 읽지 않음), 요약 '받은 시각'도 초까지(백엔드가 `yyyy-MM-dd HH:mm:ss`로 내림). ISA 기준 시각 = 평가에 쓴 실시간 가격의
  체결 시각 중 가장 이른 것(없으면 받은 시각), 실시간 가격을 하나도 못 받으면 서버 값 그대로·'직전 종가로 평가'. ISA 장부는 메모·고치기 칸 말고 모든 열 정렬(기본 시각 내림차순).
