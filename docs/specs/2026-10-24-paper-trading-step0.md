# 단계 0 결과 — 모의 알고리즘 매매 선행 확인 (2026-10-24)

> 명세 [§7](2026-10-24-paper-trading-spec.md)·설계 [§9 단계 0](2026-10-24-paper-trading-design-plan.md)의 여덟 항목을 확인한 기록입니다.
> 요약과 그에 따른 결정 변경은 설계 §13에 있고, 이 문서는 근거 표입니다.
>
> - 측정은 운영 DB에 쓰지 않았습니다. EDGAR·야후 호출은 운영 수집기 컨테이너 안에서 "받기만" 했고(저장하지 않음),
>   10년 가격 저장본의 크기·응답 시간은 QA 스택(`macrodash_qa`, 운영 백업 2026-10-24 15:22 복원)에서만 바꿔 쟀습니다.
> - 라벨: `[사실]` 확인한 값, `[해석]` 그 위의 판단, `[확인 필요]` 뒤에 확인할 것.
> - 단계 0-b(2026-10-25, SEC XBRL 재무 — 명세 D28·설계 §4-5)는 이 문서 끝에 있습니다.

## 1. 미국 장중 저장본의 마지막 봉

- [사실] 오늘(2026-10-24 토)은 미국 휴장이라 장중 두 시각을 비교할 수 없습니다. 스냅샷은 최신 1건만 남아 지난 장중 저장본도
  없습니다(`equity_history`의 10-23 03:57 KST 실행이 10-22 장중이었지만 05:12·05:52 실행이 확정 종가로 덮음).
- [사실] 같은 수집 함수(`services/sector.collect_daily_closes`, yfinance 1.7.0 일봉)로 지금 열려 있는 시장(BTC-USD)을 75초 간격으로
  두 번 받으면 마지막 봉 날짜가 오늘(2026-10-24)이고 값이 80,684.22 → 80,658.37로 바뀝니다. SPY는 10-23 종가 759.97로 고정.
- [해석] 미국 장중에도 마지막 봉이 그날 날짜의 지연 시세로 들어올 것으로 봅니다(`fix_Yahoo_returning_live_separate`가 마지막 live
  행을 남기는 코드와 일치).
- [확인 필요] 10-26(월) KST 22:30 이후 `PaperRiskJob`이 남기는 관측치 기록(봉 날짜·수집 시각, `paper_job_runs`)으로 확인합니다.
- 영향: 없음. 장중 봉이 없더라도 체결 조건 2(봉 날짜 > 기준 거래일) 때문에 `NEXT_OBSERVATION`은 저절로 다음 확정 종가로 체결됩니다.

## 2~4. 후보 기관 CIK · 목록 깊이 · 커버리지

### A. 후보 기관 CIK (EDGAR 회사 검색 + submissions JSON, 2026-10-24)

| 분류 | 후보 | CIK | EDGAR 등록 이름 | 13F-HR 원본 수 | 첫 공시 | 마지막 공시(보고 분기) | 비고 |
|---|---|---|---|---:|---|---|---|
| 가치·집중 | Berkshire Hathaway | 0001067983 | BERKSHIRE HATHAWAY INC | 111 | 1999-05-17 | 2026-08-14 (2026-06-30) |  |
| 가치·집중 | Baupost Group | 0001061768 | BAUPOST GROUP LLC/MA | 105 | 1999-05-14 | 2026-08-13 (2026-06-30) | 같은 이름의 다른 CIK 0001054420(5건, 마지막 2002-05-10)는 옛 등록 |
| 가치·집중 | Pershing Square | 0002026053 | PERSHING SQUARE INC. | 5 | 2025-08-14 | 2026-08-14 (2026-06-30) | 선행 CIK 0001336528(Pershing Square Capital Management, L.P., 13F-HR 82건, 마지막 2026-05-15·2026-03-31)에서 이어받음 |
| 가치·집중 | Third Point | 0001040273 | Third Point LLC | 109 | 1999-11-26 | 2026-08-14 (2026-06-30) |  |
| 가치·집중 | Greenlight Capital | 0001489933 | DME Capital Management, LP | 10 | 2024-05-15 | 2026-08-14 (2026-06-30) | 선행 CIK 0001079114(GREENLIGHT CAPITAL INC, 13F-HR 100건, 마지막 2024-02-14·2023-12-31)에서 이어받음 |
| 가치·집중 | Appaloosa | 0001656456 | Appaloosa LP | 42 | 2016-05-13 | 2026-08-14 (2026-06-30) | 같은 이름의 다른 CIK 0001006438(68건, 마지막 2016-02-12)는 옛 등록 |
| 가치·집중 | Akre Capital | 0001112520 | AKRE CAPITAL MANAGEMENT LLC | 103 | 2001-08-09 | 2026-08-14 (2026-06-30) |  |
| 가치·집중 | Ruane Cunniff (Sequoia) | 0001720792 | Ruane, Cunniff & Goldfarb L.P. | 34 | 2018-05-15 | 2026-08-14 (2026-06-30) | 같은 이름의 다른 CIK 0000728014(77건, 마지막 2018-05-15)는 옛 등록 |
| 가치·집중 | Dodge & Cox | 0000200217 | DODGE & COX | 110 | 1999-05-12 | 2026-08-13 (2026-06-30) |  |
| 가치·집중 | Davis Selected Advisers | 0001036325 | DAVIS SELECTED ADVISERS | 93 | 1999-05-12 | 2026-08-11 (2026-06-30) |  |
| 가치·집중 | Markel | 0001096343 | MARKEL GROUP INC. | 77 | 2001-08-14 | 2026-07-31 (2026-06-30) | 같은 이름의 다른 CIK 0001034180(35건, 마지막 2007-11-13)는 옛 등록 |
| 가치·집중 | Himalaya Capital | 0001709323 | Himalaya Capital Management LLC | 35 | 2017-06-14 | 2026-08-14 (2026-06-30) |  |
| 가치·집중 | Gardner Russo & Quinn | 0000860643 | GARDNER RUSSO & QUINN LLC | 110 | 1999-06-08 | 2026-08-13 (2026-06-30) |  |
| 가치·집중 | Scion Asset Management | 0001649339 | Scion Asset Management, LLC | 32 | 2016-02-16 | 2025-11-03 (2025-09-30) | 2026-06-30 분기 공시 없음 |
| 성장·테크 | Tiger Global | 0001167483 | TIGER GLOBAL MANAGEMENT LLC | 100 | 2002-02-14 | 2026-08-14 (2026-06-30) |  |
| 성장·테크 | Lone Pine | 0001061165 | LONE PINE CAPITAL LLC | 87 | 2005-02-14 | 2026-08-14 (2026-06-30) |  |
| 성장·테크 | Viking Global | 0001103804 | VIKING GLOBAL INVESTORS LP | 101 | 2000-02-14 | 2026-08-14 (2026-06-30) | 같은 이름의 다른 CIK 0001101785(6건, 마지막 2002-11-14)는 옛 등록 |
| 성장·테크 | Coatue | 0001135730 | COATUE MANAGEMENT LLC | 93 | 2001-03-02 | 2026-08-14 (2026-06-30) |  |
| 성장·테크 | Altimeter | 0001541617 | Altimeter Capital Management, LP | 59 | 2012-02-14 | 2026-08-14 (2026-06-30) |  |
| 성장·테크 | D1 Capital | 0001747057 | D1 Capital Partners L.P. | 31 | 2019-02-14 | 2026-08-14 (2026-06-30) |  |
| 성장·테크 | Maverick Capital | 0000934639 | MAVERICK CAPITAL LTD | 104 | 1999-05-14 | 2026-08-14 (2026-06-30) | 같은 이름의 다른 CIK 0000928617(6건, 마지막 2002-05-14)는 옛 등록 |
| 성장·테크 | Baillie Gifford | 0001088875 | BAILLIE GIFFORD & CO | 110 | 1999-06-18 | 2026-08-06 (2026-06-30) | 같은 이름의 다른 CIK 0001085972(2건, 마지막 2001-11-14)는 옛 등록 |
| 성장·테크 | Duquesne Family Office | 0001536411 | Duquesne Family Office LLC | 59 | 2012-02-09 | 2026-08-14 (2026-06-30) |  |
| 성장·테크 | Fisher Asset Management | 0000850529 | Fisher Asset Management, LLC | 110 | 1999-05-11 | 2026-08-04 (2026-06-30) |  |
| 매크로 | Bridgewater Associates | 0001350694 | Bridgewater Associates, LP | 83 | 2006-02-14 | 2026-08-14 (2026-06-30) |  |
| 매크로 | Soros Fund Management | 0001029160 | SOROS FUND MANAGEMENT LLC | 111 | 1999-05-17 | 2026-08-14 (2026-06-30) |  |
| 매크로 | Tudor Investment | 0000923093 | TUDOR INVESTMENT CORP ET AL | 110 | 1999-05-13 | 2026-08-14 (2026-06-30) |  |

### B. 목록 깊이·수집 시간(`count=100`, 기존 `_parse_filing_links`·`_collect_one_filing`)

| 후보 | 목록 행(현재·선행) | 원본 30건 확보 | 받은 분기 | 첫~마지막 보고 분기 | 끊긴 분기 | 소요(초) |
|---|---|---|---:|---|---|---:|
| Berkshire Hathaway | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 10.4 |
| Baupost Group | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 11.5 |
| Pershing Square | [[5], [97]] | [5, 30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 12.2 |
| Third Point | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 12.1 |
| Greenlight Capital | [[10], [100]] | [10, 30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 15.7 |
| Appaloosa | [[42]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 10.9 |
| Akre Capital | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 12.8 |
| Ruane Cunniff (Sequoia) | [[35]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 14.8 |
| Dodge & Cox | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 15.7 |
| Davis Selected Advisers | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 15.6 |
| Markel | [[80]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 12.1 |
| Himalaya Capital | [[36]] | [30] | 30 | 2018-03-31 ~ 2026-06-30 | 2018-09-30→2019-12-31 | 10.8 |
| Gardner Russo & Quinn | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 11.6 |
| Scion Asset Management | [[33]] | [30] | 30 | 2016-06-30 ~ 2025-09-30 | 2016-09-30→2018-12-31 | 11.3 |
| Tiger Global | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 11.5 |
| Lone Pine | [[95]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 12.8 |
| Viking Global | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 12.3 |
| Coatue | [[99]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 12.3 |
| Altimeter | [[62]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 15.2 |
| D1 Capital | [[31]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 12.5 |
| Maverick Capital | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 15.8 |
| Baillie Gifford | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 14.6 |
| Duquesne Family Office | [[62]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 10.0 |
| Fisher Asset Management | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 13.5 |
| Bridgewater Associates | [[98]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 11.2 |
| Soros Fund Management | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 12.8 |
| Tudor Investment | [[100]] | [30] | 30 | 2019-03-31 ~ 2026-06-30 | — | 17.5 |

### C. 티커 커버리지(평가액 기준) — 지금 매핑표 vs CUSIP 매핑 추가 후

커버리지 = 그 구간 시작·끝 가격이 모두 있는 보유의 평가액 / 그 분기 13F 총평가액. 7년 창 = 2019-10-23~2026-10-23(구간 29개 안팎).

| 후보 | 최신 분기 보유 수 | 최신 분기 $B | 지금 매핑 최신 분기 | 지금 매핑 7년 최소·평균 | 추가 후 7년 최소·평균 | D22 자격 | 미달 사유 |
|---|---:|---:|---:|---|---|---|---|
| Berkshire Hathaway | 29 | 299.25 | 78.1% | 73.3% · 84.8% | 94% · 97% | ✓ | — |
| Baupost Group | 23 | 5.42 | 35.8% | 5.3% · 14.4% | 36% · 66% | ✗ | 최소 커버리지 36% < 50%; 평균 커버리지 66% < 70% |
| Pershing Square | 14 | 19.47 | 47.6% | 14.0% · 28.9% | 73% · 92% | ✓ | — |
| Third Point | 42 | 4.65 | 21.1% | 17.6% · 33.5% | 68% · 84% | ✓ | — |
| Greenlight Capital | 46 | 3.91 | 2.4% | 0.0% · 1.8% | 67% · 79% | ✓ | — |
| Appaloosa | 25 | 7.47 | 56.4% | 30.8% · 52.1% | 75% · 93% | ✓ | — |
| Akre Capital | 19 | 5.11 | 12.3% | 11.0% · 28.7% | 89% · 96% | ✓ | — |
| Ruane Cunniff (Sequoia) | 54 | 6.43 | 32.3% | 31.0% · 50.1% | 70% · 88% | ✓ | — |
| Dodge & Cox | 222 | 191.01 | 30.9% | 27.9% · 31.6% | 78% · 89% | ✓ | — |
| Davis Selected Advisers | 112 | 23.29 | 22.6% | 21.2% · 31.4% | 78% · 91% | ✓ | — |
| Markel | 130 | 13.13 | 65.5% | 30.3% · 54.7% | 75% · 90% | ✓ | — |
| Himalaya Capital | 8 | 3.7 | 63.8% | 50.7% · 65.0% | 98% · 100% | ✓ | — |
| Gardner Russo & Quinn | 85 | 8.93 | 45.1% | 33.9% · 44.0% | 87% · 93% | ✓ | — |
| Scion Asset Management | 4 | 68.14 | 0.0% | 0.0% · 10.2% | 43% · 73% | ✗ | 최소 커버리지 43% < 50%; 최신 분기 공시 없음(마지막 2025-09-30) |
| Tiger Global | 46 | 23.98 | 58.0% | 14.5% · 40.7% | 75% · 91% | ✓ | — |
| Lone Pine | 34 | 16.36 | 17.0% | 3.4% · 37.9% | 73% · 91% | ✓ | — |
| Viking Global | 90 | 35.08 | 39.0% | 27.3% · 40.0% | 74% · 87% | ✓ | — |
| Coatue | 66 | 48.63 | 59.7% | 18.9% · 52.1% | 75% · 91% | ✓ | — |
| Altimeter | 20 | 9.83 | 57.3% | 4.4% · 32.9% | 81% · 94% | ✓ | — |
| D1 Capital | 55 | 34.78 | 9.4% | 9.4% · 28.9% | 85% · 93% | ✓ | — |
| Maverick Capital | 177 | 11.08 | 41.7% | 13.7% · 29.2% | 60% · 80% | ✓ | — |
| Baillie Gifford | 277 | 110.23 | 22.4% | 22.2% · 26.7% | 79% · 86% | ✓ | — |
| Duquesne Family Office | 86 | 4.35 | 9.8% | 4.0% · 37.0% | 70% · 85% | ✓ | — |
| Fisher Asset Management | 1036 | 335.83 | 47.0% | 33.9% · 48.8% | 61% · 81% | ✓ | — |
| Bridgewater Associates | 997 | 24.38 | 26.3% | 21.2% · 36.7% | 73% · 81% | ✓ | — |
| Soros Fund Management | 254 | 7.62 | 22.1% | 3.6% · 13.1% | 23% · 39% | ✗ | 최소 커버리지 23% < 50%; 평균 커버리지 39% < 70% |
| Tudor Investment | 1680 | 24.22 | 0.5% | 0.0% · 2.9% | 21% · 31% | ✗ | 최소 커버리지 21% < 50%; 평균 커버리지 31% < 70% |

### D. 2026-10-23 기준 예상 순위(원형 계산, 7년 CAGR) — 구현 뒤 자바 계산과 대조

| 순위 | 후보 | 구간 | CAGR | 누적 | 같은 구간 SPY 누적 | MDD | 샤프 |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Duquesne Family Office (상위 5) | 29 | 27.5% | 448% | 180% | -31% | 1.18 |
| 2 | Appaloosa (상위 5) | 29 | 21.9% | 300% | 180% | -10% | 1.33 |
| 3 | Greenlight Capital (상위 5) | 29 | 19.1% | 239% | 180% | -27% | 0.87 |
| 4 | Viking Global (상위 5) | 29 | 18.0% | 220% | 180% | -30% | 1.04 |
| 5 | Himalaya Capital (상위 5) | 28 | 16.8% | 197% | 180% | -27% | 0.79 |
| 6 | Coatue | 29 | 16.8% | 197% | 180% | -54% | 0.65 |
| 7 | Baillie Gifford | 29 | 16.5% | 192% | 180% | -46% | 0.68 |
| 8 | Fisher Asset Management | 29 | 16.4% | 190% | 180% | -26% | 1.06 |
| 9 | Davis Selected Advisers | 29 | 16.0% | 182% | 180% | -20% | 0.89 |
| 10 | Berkshire Hathaway | 29 | 15.6% | 176% | 180% | -19% | 1.04 |
| 11 | Pershing Square | 29 | 15.2% | 169% | 180% | -19% | 0.99 |
| 12 | Ruane Cunniff (Sequoia) | 29 | 14.5% | 159% | 180% | -28% | 0.89 |
| 13 | Dodge & Cox | 29 | 14.5% | 158% | 180% | -25% | 0.86 |
| 14 | Maverick Capital | 29 | 13.9% | 149% | 180% | -47% | 0.70 |
| 15 | D1 Capital | 29 | 13.4% | 142% | 180% | -52% | 0.65 |
| 16 | Markel | 29 | 13.4% | 141% | 180% | -18% | 0.87 |
| 17 | Tiger Global | 29 | 13.0% | 136% | 180% | -60% | 0.55 |
| 18 | Bridgewater Associates | 29 | 11.2% | 110% | 180% | -16% | 0.85 |
| 19 | Lone Pine | 29 | 11.0% | 107% | 180% | -53% | 0.51 |
| 20 | Gardner Russo & Quinn | 29 | 10.5% | 101% | 180% | -23% | 0.76 |
| 21 | Akre Capital | 29 | 9.5% | 89% | 180% | -21% | 0.62 |
| 22 | Altimeter | 29 | 8.0% | 71% | 180% | -62% | 0.40 |
| 23 | Third Point | 29 | 6.9% | 60% | 180% | -41% | 0.44 |

### E. 매핑 추가 후보 상위 200개(CUSIP 단위)

순위 = 7년 창의 각 분기에서 그 증권이 차지한 기관 내 비중(기관마다 같은 무게)의 합. 판정: ✓ 채택, ✗ 제외(사유), — OpenFIGI US 티커 없음(상장폐지·인수·외국 원주 등, 가격을 구할 수 없음).

| # | CUSIP | 13F 이름(대표) | 클래스 | 보유 기관 수 | 비중 합 | OpenFIGI 티커·이름 | 종류 | SEC 등록 이름 | 야후 이력 | 판정 |
|---:|---|---|---|---:|---:|---|---|---|---|---|
| 1 | 30303M102 | FACEBOOK INC | CL A | 21 | 31.98 | META · META PLATFORMS INC-CLASS A | Common Stock | Meta Platforms, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 2 | 833445109 | SNOWFLAKE INC | CL A | 16 | 31.14 | SNOW · SNOWFLAKE INC | Common Stock | Snowflake Inc. | 2020-09-16~2026-10-23 | ✓ |
| 3 | 392709101 | GREEN BRICK PARTNERS INC | COM | 3 | 27.39 | GRBK · GREEN BRICK PARTNERS INC | Common Stock | Green Brick Partners, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 4 | 01609W102 | ALIBABA GROUP HLDG LTD | SPONSORED ADS | 21 | 26.80 | BABA · ALIBABA GROUP HOLDING-SP ADR | ADR | Alibaba Group Holding Ltd | 2016-10-24~2026-10-23 | ✓ |
| 5 | 22266T109 | COUPANG INC | CL A | 13 | 26.36 | CPNG · COUPANG INC | Common Stock | Coupang, Inc. | 2021-03-11~2026-10-23 | ✓ |
| 6 | 060505104 | BK OF AMERICA CORP | COM | 11 | 26.25 | BAC · BANK OF AMERICA CORP | Common Stock | BANK OF AMERICA CORP /DE/ | 2016-10-24~2026-10-23 | ✓ |
| 7 | 90353T100 | UBER TECHNOLOGIES INC | COM | 18 | 25.16 | UBER · UBER TECHNOLOGIES INC | Common Stock | Uber Technologies, Inc | 2019-05-10~2026-10-23 | ✓ |
| 8 | 57636Q104 | MASTERCARD INCORPORATED | CL A | 18 | 18.77 | MA · MASTERCARD INC - A | Common Stock | Mastercard Inc | 2016-10-24~2026-10-23 | ✓ |
| 9 | 47215P106 | JD.COM INC | SPON ADR CL A | 17 | 18.70 | JD · JD.COM INC-ADR | ADR | JD.com, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 10 | 14040H105 | CAPITAL ONE FINL CORP | COM | 16 | 18.43 | COF · CAPITAL ONE FINANCIAL CORP | Common Stock | CAPITAL ONE FINANCIAL CORP | 2016-10-24~2026-10-23 | ✓ |
| 11 | 615369105 | MOODYS CORP | COM | 12 | 17.76 | MCO · MOODY'S CORP | Common Stock | MOODYS CORP /DE/ | 2016-10-24~2026-10-23 | ✓ |
| 12 | 76131D103 | RESTAURANT BRANDS INTL INC | COM | 10 | 17.58 | QSR · RESTAURANT BRANDS INTERN | Common Stock | Restaurant Brands Internationa | 2016-10-24~2026-10-23 | ✓ |
| 13 | 43300A203 | HILTON WORLDWIDE HLDGS INC | COM | 8 | 15.37 | HLT · HILTON WORLDWIDE HOLDINGS IN | Common Stock | Hilton Worldwide Holdings Inc. | 2016-10-24~2026-10-23 | ✓ |
| 14 | 169656105 | CHIPOTLE MEXICAN GRILL INC | COM | 11 | 15.28 | CMG · CHIPOTLE MEXICAN GRILL INC | Common Stock | CHIPOTLE MEXICAN GRILL INC | 2016-10-24~2026-10-23 | ✓ |
| 15 | 722304102 | PDD HOLDINGS INC | SPONSORED ADS | 14 | 13.51 | PDD · PDD HOLDINGS INC | ADR | PDD Holdings Inc. | 2018-07-26~2026-10-23 | ✓ |
| 16 | 11271J107 | BROOKFIELD CORP | CL A LTD VT SH | 13 | 13.26 | BN · BROOKFIELD CORP | Common Stock | BROOKFIELD Corp /ON/ | 2016-10-24~2026-10-23 | ✓ |
| 17 | 530307305 | LIBERTY BROADBAND CORP | COM SER C | 9 | 12.46 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 18 | 69331C108 | PG&E CORP | COM | 11 | 12.25 | PCG · P G & E CORP | Common Stock | PG&E Corp | 2016-10-24~2026-10-23 | ✓ |
| 19 | 48251W104 | KKR & CO INC | COM | 13 | 11.62 | KKR · KKR & CO INC | Common Stock | KKR & Co. Inc. | 2016-10-24~2026-10-23 | ✓ |
| 20 | 81141R100 | SEA LTD | SPONSORD ADS | 16 | 11.00 | SE · SEA LTD-ADR | ADR | Sea Ltd | 2017-10-20~2026-10-23 | ✓ |
| 21 | 641069406 | NESTLE SA SPONSORED ADR | COM | 2 | 9.66 | NSRGY · NESTLE SA-SPONS ADR | ADR |  | 2016-10-24~2026-10-23 | ✓ |
| 22 | 98138H101 | WORKDAY INC | CL A | 12 | 9.53 | WDAY · WORKDAY INC-CLASS A | Common Stock | Workday, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 23 | 58733R102 | MERCADOLIBRE INC | COM | 15 | 9.50 | MELI · MERCADOLIBRE INC | Common Stock | MERCADOLIBRE INC | 2016-10-24~2026-10-23 | ✓ |
| 24 | 143130102 | CARMAX INC | COM | 13 | 9.32 | KMX · CARMAX INC | Common Stock | CARMAX INC | 2016-10-24~2026-10-23 | ✓ |
| 25 | 10922N103 | BRIGHTHOUSE FINL INC | COM | 6 | 9.14 | BHF · BRIGHTHOUSE FINANCIAL INC | Common Stock | Brighthouse Financial, Inc. | 2017-07-17~2026-10-23 | ✓ |
| 26 | 36162J106 | GEO GROUP INC NEW | COM | 4 | 8.73 | GEO · GEO GROUP INC/THE | Common Stock | GEO GROUP INC | 2016-10-24~2026-10-23 | ✓ |
| 27 | G5480U120 | LIBERTY GLOBAL PLC | SHS CL C | 7 | 8.59 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 28 | 67103H107 | OREILLY AUTOMOTIVE INC | COM | 9 | 8.53 | ORLY · O'REILLY AUTOMOTIVE INC | Common Stock | O REILLY AUTOMOTIVE INC | 2016-10-24~2026-10-23 | ✓ |
| 29 | 82509L107 | SHOPIFY INC | CL A | 16 | 8.08 | SHOP · SHOPIFY INC - CLASS A | Common Stock | SHOPIFY INC. | 2016-10-24~2026-10-23 | ✓ |
| 30 | 45866F104 | INTERCONTINENTAL EXCHANGE IN | COM | 10 | 8.07 | ICE · INTERCONTINENTAL EXCHANGE IN | Common Stock | Intercontinental Exchange, Inc | 2016-10-24~2026-10-23 | ✓ |
| 31 | L8681T102 | SPOTIFY TECHNOLOGY S A | SHS | 13 | 7.48 | SPOT · SPOTIFY TECHNOLOGY SA | Common Stock | Spotify Technology S.A. | 2018-04-03~2026-10-23 | ✓ |
| 32 | 878742204 | TECK RESOURCES LTD | CL B | 9 | 7.34 | TECK · TECK RESOURCES LTD-CLS B | Common Stock | TECK RESOURCES LTD | 2016-10-24~2026-10-23 | ✓ |
| 33 | 30212P303 | EXPEDIA GROUP INC | COM NEW | 13 | 7.07 | EXPE · EXPEDIA GROUP INC | Common Stock | Expedia Group, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 34 | 852234103 | BLOCK INC | CL A | 14 | 7.03 | XYZ · BLOCK INC | Common Stock | Block, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 35 | 874039100 | TSMC ADR | SPONSORED ADS | 17 | 7.01 | TSM · TAIWAN SEMICONDUCTOR-SP ADR | ADR | TAIWAN SEMICONDUCTOR MANUFACTU | 2016-10-24~2026-10-23 | ✓ |
| 36 | 31620M106 | FIDELITY NATL INFORMATION SV | COM | 13 | 6.98 | FIS · FIDELITY NATIONAL INFO SERV | Common Stock | Fidelity National Information  | 2016-10-24~2026-10-23 | ✓ |
| 37 | 76954A103 | RIVIAN AUTOMOTIVE INC | COM CL A | 11 | 6.97 | RIVN · RIVIAN AUTOMOTIVE INC-A | Common Stock | Rivian Automotive, Inc. / DE | 2021-11-10~2026-10-23 | ✓ |
| 38 | 718172109 | PHILIP MORRIS INTERNATIONAL IN | COM | 4 | 6.97 | PM · PHILIP MORRIS INTERNATIONAL | Common Stock | Philip Morris International In | 2016-10-24~2026-10-23 | ✓ |
| 39 | H25662182 | COMPAGNIE FINANCIERE RICHEMONT | COM | 1 | 6.97 | CFRHF · CIE FINANCIERE RICHEMO-A REG | Common Stock |  | 2016-10-24~2026-10-23 | ✓ |
| 40 | 22160N109 | COSTAR GROUP INC | COM | 10 | 6.91 | CSGP · COSTAR GROUP INC | Common Stock | COSTAR GROUP, INC. | 2016-10-24~2026-10-23 | ✓ |
| 41 | 902973304 | US BANCORP DEL | COM NEW | 12 | 6.83 | USB · US BANCORP | Common Stock | US BANCORP \DE\ | 2016-10-24~2026-10-23 | ✓ |
| 42 | 632307104 | NATERA INC | COM | 8 | 6.71 | NTRA · NATERA INC | Common Stock | Natera, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 43 | N39338194 | HEINEKEN HOLDING NV | COM | 1 | 6.70 | HKHHF · HEINEKEN HOLDING NV | Common Stock | HEINEKEN HOLDING N V | 2016-10-24~2026-10-23 | ✓ |
| 44 | 25809K105 | DOORDASH INC | CL A | 14 | 6.65 | DASH · DOORDASH INC - A | Common Stock | DoorDash, Inc. | 2020-12-09~2026-10-23 | ✓ |
| 45 | 125523100 | THE CIGNA GROUP | COM | 10 | 6.59 | CI · THE CIGNA GROUP | Common Stock | Cigna Group | 2016-10-24~2026-10-23 | ✓ |
| 46 | G6683N103 | NU HLDGS LTD | ORD SHS CL A | 10 | 6.55 | NU · NU HOLDINGS LTD/CAYMAN ISL-A | Common Stock | Nu Holdings Ltd. | 2021-12-09~2026-10-23 | ✓ |
| 47 | 776696106 | ROPER TECHNOLOGIES INC | COM | 9 | 6.55 | ROP · ROPER TECHNOLOGIES INC | Common Stock | ROPER TECHNOLOGIES INC | 2016-10-24~2026-10-23 | ✓ |
| 48 | 60770K107 | MODERNA INC | COM | 9 | 6.51 | MRNA · MODERNA INC | Common Stock | Moderna, Inc. | 2018-12-07~2026-10-23 | ✓ |
| 49 | 518439104 | LAUDER ESTEE COS INC | CL A | 9 | 6.32 | EL · ESTEE LAUDER COMPANIES-CL A | Common Stock | ESTEE LAUDER COMPANIES INC | 2016-10-24~2026-10-23 | ✓ |
| 50 | 084670108 | BERKSHIRE HATHAWAY INC., CLASS A | Common | 2 | 6.29 | BRK/A · BERKSHIRE HATHAWAY INC-CL A | Common Stock | BERKSHIRE HATHAWAY INC | 2016-10-24~2026-10-23 | ✓ |
| 51 | 02079K305 | ALPHABET INC CLASS A | COM | 4 | 6.27 | GOOGL · ALPHABET INC-CL A | Common Stock | Alphabet Inc. | 2016-10-24~2026-10-23 | ✓ |
| 52 | 565394103 | MAPLEBEAR INC | COM | 9 | 6.21 | CART · MAPLEBEAR INC | Common Stock | Maplebear Inc. | 2023-09-19~2026-10-23 | ✓ |
| 53 | 92552V100 | VIASAT INC | COM | 4 | 6.16 | VSAT · VIASAT INC | Common Stock | VIASAT INC | 2016-10-24~2026-10-23 | ✓ |
| 54 | 44267D107 | HOWARD HUGHES CORP | COM | 5 | 5.95 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 55 | 464287200 | ISHARES TR | CORE S&P500 ET | 5 | 5.85 | IVV · ISHARES CORE S&P 500 ETF | ETP |  | 2016-10-24~2026-10-23 | ✓ |
| 56 | 146869102 | CARVANA CO | CL A | 13 | 5.83 | CVNA · CARVANA CO | Common Stock | CARVANA CO. | 2017-04-28~2026-10-23 | ✓ |
| 57 | 92840M102 | VISTRA CORP | COM | 13 | 5.80 | VST · VISTRA CORP | Common Stock | Vistra Corp. | 2016-10-24~2026-10-23 | ✓ |
| 58 | G96629103 | WILLIS TOWERS WATSON PLC LTD | SHS | 8 | 5.77 | WTW · WILLIS TOWERS WATSON PLC | Common Stock | WILLIS TOWERS WATSON PLC | 2016-10-24~2026-10-23 | ✓ |
| 59 | 74736K101 | QORVO INC | COM | 7 | 5.72 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 60 | 064058100 | BANK NEW YORK MELLON CORP | COM | 9 | 5.63 | BNY · BANK OF NEW YORK MELLON CORP | Common Stock | Bank of New York Mellon Corp | 2016-10-24~2026-10-23 | ✓ |
| 61 | F72027109 | PERNOD RICARD | COM | 1 | 5.35 | PDRDF · PERNOD RICARD SA | Common Stock |  | 2016-10-24~2026-10-23 | ✓ |
| 62 | 225310101 | CREDIT ACCEP CORP MICH | COM | 4 | 5.31 | CACC · CREDIT ACCEPTANCE CORP | Common Stock | CREDIT ACCEPTANCE CORP | 2016-10-24~2026-10-23 | ✓ |
| 63 | 070830104 | BATH & BODY WORKS INC | COM | 7 | 5.24 | BBWI · BATH & BODY WORKS INC | Common Stock | Bath & Body Works, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 64 | 16119P108 | CHARTER COMMUNICATIONS INC N | CL A | 13 | 5.15 | CHTR · CHARTER COMMUNICATIONS INC-A | Common Stock | CHARTER COMMUNICATIONS, INC. / | 2016-10-24~2026-10-23 | ✓ |
| 65 | 50212V100 | LPL FINL HLDGS INC | COM | 10 | 5.12 | LPLA · LPL FINANCIAL HOLDINGS INC | Common Stock | LPL Financial Holdings Inc. | 2016-10-24~2026-10-23 | ✓ |
| 66 | 573284106 | MARTIN MARIETTA MATERIALS | COM | 7 | 4.96 | MLM · MARTIN MARIETTA MATERIALS | Common Stock | MARTIN MARIETTA MATERIALS INC | 2016-10-24~2026-10-23 | ✓ |
| 67 | 78463V107 | SPDR GOLD TR | GOLD SHS | 5 | 4.92 | GLD · SPDR GOLD SHARES | ETP | SPDR GOLD TRUST | 2016-10-24~2026-10-23 | ✓ |
| 68 | 44267T102 | HOWARD HUGHES HOLDINGS INC | COM | 4 | 4.85 | HHH · HOWARD HUGHES HOLDINGS INC | Common Stock | Howard Hughes Holdings Inc. | 2016-10-24~2026-10-23 | ✓ |
| 69 | 112585104 | BROOKFIELD ASSET MGMT INC | CL A LTD VT SH | 7 | 4.84 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 70 | 27579R104 | EAST WEST BANCORP INC | COM | 6 | 4.80 | EWBC · EAST WEST BANCORP INC | Common Stock | EAST WEST BANCORP INC | 2016-10-24~2026-10-23 | ✓ |
| 71 | N07059210 | ASML HOLDING N V | N Y REGISTRY S | 9 | 4.74 | ASML · ASML HOLDING NV-NY REG SHS | NY Reg Shrs | ASML HOLDING NV | 2016-10-24~2026-10-23 | ✓ |
| 72 | 444859102 | HUMANA INC | COM | 14 | 4.63 | HUM · HUMANA INC | Common Stock | HUMANA INC | 2016-10-24~2026-10-23 | ✓ |
| 73 | G61188127 | LIBERTY GLOBAL LTD | COM CL C | 4 | 4.62 | LBTYK · LIBERTY GLOBAL LTD-C | Common Stock | Liberty Global Ltd. | 2016-10-24~2026-10-23 | ✓ |
| 74 | 808513105 | CHARLES SCHWAB CORP. | COM | 10 | 4.54 | SCHW · SCHWAB (CHARLES) CORP | Common Stock | SCHWAB CHARLES CORP | 2016-10-24~2026-10-23 | ✓ |
| 75 | 20717M103 | CONFLUENT INC | CLASS A COM | 12 | 4.47 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 76 | 02079K107 | ALPHABET INC CLASS C | CAP STK CL C | 4 | 4.39 | GOOG · ALPHABET INC-CL C | Common Stock | Alphabet Inc. | 2016-10-24~2026-10-23 | ✓ |
| 77 | 036752103 | ANTHEM INC | COM | 11 | 4.38 | ELV · ELEVANCE HEALTH INC | Common Stock | Elevance Health, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 78 | 03831W108 | APPLOVIN CORP | COM CL A | 12 | 4.29 | APP · APPLOVIN CORP-CLASS A | Common Stock | AppLovin Corp | 2021-04-15~2026-10-23 | ✓ |
| 79 | G25508105 | CRH PLC | ORD | 8 | 4.29 | CRH · CRH PLC | Common Stock | CRH PUBLIC LTD CO | 2016-10-24~2026-10-23 | ✓ |
| 80 | G51502105 | JOHNSON CONTROLS INTERNATIONAL PLC | SHS | 10 | 4.19 | JCI · JOHNSON CONTROLS INTERNATION | Common Stock | Johnson Controls International | 2016-10-24~2026-10-23 | ✓ |
| 81 | 03769M106 | APOLLO GLOBAL MGMT INC | COM | 10 | 4.09 | APO · APOLLO GLOBAL MANAGEMENT INC | Common Stock | Apollo Global Management, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 82 | 23804L103 | DATADOG INC | CL A COM | 13 | 4.09 | DDOG · DATADOG INC - CLASS A | Common Stock | Datadog, Inc. | 2019-09-19~2026-10-23 | ✓ |
| 83 | 531229755 | LIBERTY MEDIA CORP DEL | COM LBTY ONE S | 9 | 4.03 | FWONK · LIBERTY MEDIA CORP-C | Common Stock | Liberty Media Corp | 2016-10-24~2026-10-23 | ✓ |
| 84 | 20854L108 | CONSOL ENERGY INC NEW | COM | 3 | 3.99 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 85 | 531229854 | LIBERTY MEDIA CORP DEL | COM SER C FRML | 10 | 3.98 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 86 | 056752108 | BAIDU INC | SPON ADR REP A | 12 | 3.93 | BIDU · BAIDU INC - SPON ADR | ADR | Baidu, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 87 | 278642103 | EBAY INC. | COM | 8 | 3.91 | EBAY · EBAY INC | Common Stock | EBAY INC | 2016-10-24~2026-10-23 | ✓ |
| 88 | 084670702 | BERKSHIRE HATHAWAY INC., CLASS B | Common | 3 | 3.87 | BRK/B · BERKSHIRE HATHAWAY INC-CL B | Common Stock | BERKSHIRE HATHAWAY INC | 2016-10-24~2026-10-23 | ✓ |
| 89 | 46625H100 | J.P. MORGAN CHASE | COM | 5 | 3.80 | JPM · JPMORGAN CHASE & CO | Common Stock | JPMORGAN CHASE & CO | 2016-10-24~2026-10-23 | ✓ |
| 90 | 31428X106 | FEDEX CORP | COM | 12 | 3.76 | FDX · FEDEX CORP | Common Stock | FEDEX CORP | 2016-10-24~2026-10-23 | ✓ |
| 91 | 22788C105 | CROWDSTRIKE HLDGS INC | CL A | 12 | 3.73 | CRWD · CROWDSTRIKE HOLDINGS INC - A | Common Stock | CrowdStrike Holdings, Inc. | 2019-06-12~2026-10-23 | ✓ |
| 92 | 570535104 | MARKEL CORP | COM | 8 | 3.67 | MKL · MARKEL GROUP INC | Common Stock | MARKEL GROUP INC. | 2016-10-24~2026-10-23 | ✓ |
| 93 | 92556V106 | VIATRIS INC | COM | 8 | 3.67 | VTRS · VIATRIS INC | Common Stock | Viatris Inc | 2016-10-24~2026-10-23 | ✓ |
| 94 | 464287242 | ISHARES TR | IBOXX INV CP E | 5 | 3.66 | LQD · ISHR IBX USD INVGD CB ETF-UI | ETP |  | 2016-10-24~2026-10-23 | ✓ |
| 95 | 46982L108 | JACOBS SOLUTIONS INC | COM | 8 | 3.64 | J · JACOBS SOLUTIONS INC | Common Stock | JACOBS SOLUTIONS INC. | 2016-10-24~2026-10-23 | ✓ |
| 96 | 922042858 | VANGUARD FTSE EMERGING MKT ETF | COM | 3 | 3.58 | VWO · VANGUARD FTSE EMERGING MARKE | ETP |  | 2016-10-24~2026-10-23 | ✓ |
| 97 | 60855R100 | MOLINA HEALTHCARE INC | COM | 8 | 3.57 | MOH · MOLINA HEALTHCARE INC | Common Stock | MOLINA HEALTHCARE, INC. | 2016-10-24~2026-10-23 | ✓ |
| 98 | 74967X103 | RH | COM | 12 | 3.53 | RH · RH | Common Stock | RH | 2016-10-24~2026-10-23 | ✓ |
| 99 | 46434G103 | ISHARES INC | CORE MSCI EMKT | 4 | 3.52 | IEMG · ISHARES CORE MSCI EMERGING | ETP |  | 2016-10-24~2026-10-23 | ✓ |
| 100 | 337738108 | FISERV INC | COM | 8 | 3.51 | FISV · FISERV INC | Common Stock | FISERV INC | 2016-10-24~2026-10-23 | ✓ |
| 101 | N00985106 | AERCAP HOLDINGS NV | SHS | 6 | 3.49 | AER · AERCAP HOLDINGS NV | Common Stock | AerCap Holdings N.V. | 2016-10-24~2026-10-23 | ✓ |
| 102 | 893641100 | TRANSDIGM GROUP INC | COM | 10 | 3.49 | TDG · TRANSDIGM GROUP INC | Common Stock | TransDigm Group INC | 2016-10-24~2026-10-23 | ✓ |
| 103 | 36467W109 | GAMESTOP CORP NEW | CL A | 6 | 3.41 | GME · GAMESTOP CORP-CLASS A | Common Stock | GameStop Corp. | 2016-10-24~2026-10-23 | ✓ |
| 104 | 00846U101 | AGILENT TECHNOLOGIES INC | COM | 8 | 3.40 | A · AGILENT TECHNOLOGIES INC | Common Stock | AGILENT TECHNOLOGIES, INC. | 2016-10-24~2026-10-23 | ✓ |
| 105 | 37940X102 | GLOBAL PMTS INC | COM | 9 | 3.39 | GPN · GLOBAL PAYMENTS INC | Common Stock | GLOBAL PAYMENTS INC | 2016-10-24~2026-10-23 | ✓ |
| 106 | 538034109 | LIVE NATION ENTERTAINMENT IN | COM | 12 | 3.34 | LYV · LIVE NATION ENTERTAINMENT IN | Common Stock | Live Nation Entertainment, Inc | 2016-10-24~2026-10-23 | ✓ |
| 107 | 13646K108 | CANADIAN PACIFIC KANSAS CITY | COM | 10 | 3.29 | CP · CANADIAN PACIFIC KANSAS CITY | Common Stock | CANADIAN PACIFIC KANSAS CITY L | 2016-10-24~2026-10-23 | ✓ |
| 108 | 78462F103 | SPDR S&P 500 ETF TRUST - US ETP | COM | 5 | 3.28 | SPY · SS SPDR S&P 500 ETF TRUST-US | ETP | SPDR S&P 500 ETF TRUST | 2016-10-24~2026-10-23 | ✓ |
| 109 | 34959J108 | FORTIVE CORP | COM | 9 | 3.22 | FTV · FORTIVE CORP | Common Stock | Fortive Corp | 2016-10-24~2026-10-23 | ✓ |
| 110 | 23331A109 | D R HORTON INC | COM | 12 | 3.20 | DHI · DR HORTON INC | Common Stock | HORTON D R INC /DE/ | 2016-10-24~2026-10-23 | ✓ |
| 111 | 531229607 | LIBERTY MEDIA CORP DEL | COM C SIRIUSXM | 5 | 3.19 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 112 | 40434L105 | HP INC | COM | 9 | 3.18 | HPQ · HP INC | Common Stock | HP INC | 2016-10-24~2026-10-23 | ✓ |
| 113 | G3643J108 | FLUTTER ENTMT PLC | SHS | 12 | 3.17 | FLUT · FLUTTER ENTERTAINMENT PLC-DI | Common Stock | Flutter Entertainment plc | 2016-10-24~2026-10-23 | ✓ |
| 114 | 36828A101 | GE VERNOVA INC | COM | 11 | 3.13 | GEV · GE VERNOVA INC | Common Stock | GE Vernova Inc. | 2024-03-27~2026-10-23 | ✓ |
| 115 | 35137L105 | FOX CORP | CL A COM | 8 | 3.12 | FOXA · FOX CORP - CLASS A | Common Stock | Fox Corp | 2019-03-12~2026-10-23 | ✓ |
| 116 | 910047109 | UNITED AIRLS HLDGS INC | COM | 9 | 3.11 | UAL · UNITED AIRLINES HOLDINGS INC | Common Stock | United Airlines Holdings, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 117 | 15135B101 | CENTENE CORP DEL | COM | 7 | 3.10 | CNC · CENTENE CORP | Common Stock | CENTENE CORP | 2016-10-24~2026-10-23 | ✓ |
| 118 | 50155Q100 | KYNDRYL HLDGS INC | COMMON STOCK | 5 | 3.08 | KD · KYNDRYL HOLDINGS INC | Common Stock | Kyndryl Holdings, Inc. | 2021-10-22~2026-10-23 | ✓ |
| 119 | 98980L101 | ZOOM VIDEO COMMUNICATIONS IN | CL A | 13 | 3.07 | ZM · ZOOM COMMUNICATIONS INC | Common Stock | Zoom Communications, Inc. | 2019-04-18~2026-10-23 | ✓ |
| 120 | 26884L109 | EQT CORP | COM | 10 | 3.06 | EQT · EQT CORP | Common Stock | EQT Corp | 2016-10-24~2026-10-23 | ✓ |
| 121 | 110122108 | BRISTOL-MYERS SQUIBB CO | COM | 8 | 3.06 | BMY · BRISTOL-MYERS SQUIBB CO | Common Stock | BRISTOL MYERS SQUIBB CO | 2016-10-24~2026-10-23 | ✓ |
| 122 | 00724F101 | ADOBE SYSTEMS INCORPORATED | COM | 10 | 3.05 | ADBE · ADOBE INC | Common Stock | ADOBE INC. | 2016-10-24~2026-10-23 | ✓ |
| 123 | N3167Y103 | FERRARI NV | COM | 6 | 3.03 | RACE · FERRARI NV | Common Stock | Ferrari N.V. | 2016-10-24~2026-10-23 | ✓ |
| 124 | 25754A201 | DOMINOS PIZZA INC | COM | 10 | 2.99 | DPZ · DOMINO'S PIZZA INC | Common Stock | DOMINOS PIZZA INC | 2016-10-24~2026-10-23 | ✓ |
| 125 | 40415F101 | HDFC BANK LTD | SPONSORED ADS | 10 | 2.98 | HDB · HDFC BANK LTD-ADR | ADR | HDFC BANK LTD | 2016-10-24~2026-10-23 | ✓ |
| 126 | 670100205 | NOVO-NORDISK A S | ADR | 10 | 2.96 | NVO · NOVO-NORDISK A/S-SPONS ADR | ADR | NOVO NORDISK A S | 2016-10-24~2026-10-23 | ✓ |
| 127 | 84615Q103 | SPACE EXPLORATION TECHN CORP | CLASS A COM ST | 11 | 2.94 | SPCX · SPACE EXPLORATION TECHN-CL A | Common Stock | SPACE EXPLORATION TECHNOLOGIES | 2026-06-12~2026-10-23 | ✓ |
| 128 | 94419L101 | WAYFAIR INC | CL A | 9 | 2.91 | W · WAYFAIR INC- CLASS A | Common Stock | Wayfair Inc. | 2016-10-24~2026-10-23 | ✓ |
| 129 | 29273V100 | ENERGY TRANSFER L P | COM UT LTD PTN | 4 | 2.91 | ET · ENERGY TRANSFER LP | MLP | Energy Transfer LP | 2016-10-24~2026-10-23 | ✓ |
| 130 | 40412C101 | HCA HEALTHCARE INC | COM | 11 | 2.91 | HCA · HCA HEALTHCARE INC | Common Stock | HCA Healthcare, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 131 | 26614N102 | DUPONT DE NEMOURS INC | COM | 10 | 2.90 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 132 | 59156R108 | METLIFE INC | COM | 7 | 2.90 | MET · METLIFE INC | Common Stock | METLIFE INC | 2016-10-24~2026-10-23 | ✓ |
| 133 | 92206C870 | VANGUARD FDS INT TERM CORP | COM | 2 | 2.89 | VCIT · VANGUARD INT-TERM CORPORATE | ETP |  | 2016-10-24~2026-10-23 | ✓ |
| 134 | 70614W100 | PELOTON INTERACTIVE INC | CL A COM | 12 | 2.87 | PTON · PELOTON INTERACTIVE INC-A | Common Stock | PELOTON INTERACTIVE, INC. | 2019-09-26~2026-10-23 | ✓ |
| 135 | 00507V109 | ACTIVISION BLIZZARD INC | COM | 14 | 2.86 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 136 | 742718109 | PROCTER AND GAMBLE CO | COM | 5 | 2.82 | PG · PROCTER & GAMBLE CO/THE | Common Stock | PROCTER & GAMBLE Co | 2016-10-24~2026-10-23 | ✓ |
| 137 | 550021109 | LULULEMON ATHLETICA INC | COM | 9 | 2.82 | LULU · LULULEMON ATHLETICA INC | Common Stock | lululemon athletica inc. | 2016-10-24~2026-10-23 | ✓ |
| 138 | 10806X102 | BRIDGEBIO PHARMA INC | COM | 6 | 2.81 | BBIO · BRIDGEBIO PHARMA INC | Common Stock | BridgeBio Pharma, Inc. | 2019-06-27~2026-10-23 | ✓ |
| 139 | 071813109 | BAXTER INTL INC | COM | 7 | 2.81 | BAX · BAXTER INTERNATIONAL INC | Common Stock | BAXTER INTERNATIONAL INC | 2016-10-24~2026-10-23 | ✓ |
| 140 | 88023U101 | TEMPUR SEALY INTL INC | COM | 11 | 2.81 | SGI · SOMNIGROUP INTERNATIONAL INC | Common Stock | SOMNIGROUP INTERNATIONAL INC. | 2016-10-24~2026-10-23 | ✓ |
| 141 | 80105N105 | SANOFI | SPONSORED ADR | 6 | 2.78 | SNY · SANOFI-ADR | ADR | Sanofi | 2016-10-24~2026-10-23 | ✓ |
| 142 | 674599105 | OCCIDENTAL PETROLEUM CORP. | COM | 2 | 2.76 | OXY · OCCIDENTAL PETROLEUM CORP | Common Stock | OCCIDENTAL PETROLEUM CORP /DE/ | 2016-10-24~2026-10-23 | ✓ |
| 143 | 45784P101 | INSULET CORP | COM | 9 | 2.74 | PODD · INSULET CORP | Common Stock | INSULET CORP | 2016-10-24~2026-10-23 | ✓ |
| 144 | 00187Y100 | API GROUP CORP | COM STK | 8 | 2.71 | APG · API GROUP CORP | Common Stock | APi Group Corp | 2020-04-29~2026-10-23 | ✓ |
| 145 | 95082P105 | WESCO INTL INC | COM | 7 | 2.69 | WCC · WESCO INTERNATIONAL INC | Common Stock | WESCO INTERNATIONAL INC | 2016-10-24~2026-10-23 | ✓ |
| 146 | 552953101 | MGM RESORTS INTERNATIONAL | COM | 9 | 2.68 | MGM · MGM RESORTS INTERNATIONAL | Common Stock | MGM Resorts International | 2016-10-24~2026-10-23 | ✓ |
| 147 | 934423104 | WARNER BROS DISCOVERY INC | COM SER A | 11 | 2.66 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 148 | 02043Q107 | ALNYLAM PHARMACEUTICALS INC | COM | 8 | 2.65 | ALNY · ALNYLAM PHARMACEUTICALS INC | Common Stock | ALNYLAM PHARMACEUTICALS, INC. | 2016-10-24~2026-10-23 | ✓ |
| 149 | 101137107 | BOSTON SCIENTIFIC CORP | COM | 11 | 2.64 | BSX · BOSTON SCIENTIFIC CORP | Common Stock | BOSTON SCIENTIFIC CORP | 2016-10-24~2026-10-23 | ✓ |
| 150 | 25243Q205 | DIAGEO PLC | SPON ADR NEW | 8 | 2.59 | DEO · DIAGEO PLC-SPONSORED ADR | ADR | DIAGEO PLC | 2016-10-24~2026-10-23 | ✓ |
| 151 | 874054109 | TAKE-TWO INTERACTIVE SOFTWAR | COM | 9 | 2.52 | TTWO · TAKE-TWO INTERACTIVE SOFTWRE | Common Stock | TAKE TWO INTERACTIVE SOFTWARE  | 2016-10-24~2026-10-23 | ✓ |
| 152 | 81730H109 | SENTINELONE INC | CL A | 7 | 2.47 | S · SENTINELONE INC -CLASS A | Common Stock | SentinelOne, Inc. | 2021-06-30~2026-10-23 | ✓ |
| 153 | G06242104 | ATLASSIAN CORP PLC | CL A | 11 | 2.45 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 154 | 256677105 | DOLLAR GEN CORP NEW | COM | 10 | 2.40 | DG · DOLLAR GENERAL CORP | Common Stock | DOLLAR GENERAL CORP | 2016-10-24~2026-10-23 | ✓ |
| 155 | 19247G107 | COHERENT CORP | COM | 9 | 2.34 | COHR · COHERENT CORP | Common Stock | COHERENT CORP. | 2016-10-24~2026-10-23 | ✓ |
| 156 | 90184L102 | TWITTER INC | COM | 9 | 2.33 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 157 | 888787108 | TOAST INC | CL A | 10 | 2.31 | TOST · TOAST INC-CLASS A | Common Stock | Toast, Inc. | 2021-09-22~2026-10-23 | ✓ |
| 158 | 00650F109 | ADAPTIVE BIOTECHNOLOGIES COR | COM | 5 | 2.31 | ADPT · ADAPTIVE BIOTECHNOLOGIES | Common Stock | Adaptive Biotechnologies Corp | 2019-06-27~2026-10-23 | ✓ |
| 159 | 65336K103 | NEXSTAR MEDIA GROUP INC | CL A | 6 | 2.29 | NXST · NEXSTAR MEDIA GROUP INC | Common Stock | NEXSTAR MEDIA GROUP, INC. | 2016-10-24~2026-10-23 | ✓ |
| 160 | 771049103 | ROBLOX CORP | CL A | 9 | 2.29 | RBLX · ROBLOX CORP -CLASS A | Common Stock | Roblox Corp | 2021-03-10~2026-10-23 | ✓ |
| 161 | G0177J108 | ALLERGAN PLC | SHS | 6 | 2.29 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 162 | 75734B100 | REDDIT INC | CL A | 11 | 2.29 | RDDT · REDDIT INC-CL A | Common Stock | Reddit, Inc. | 2024-03-21~2026-10-23 | ✓ |
| 163 | 942622200 | WATSCO INC | COM | 6 | 2.27 | WSO · WATSCO INC | Common Stock | WATSCO INC | 2016-10-24~2026-10-23 | ✓ |
| 164 | 923454102 | VERITIV CORP | COM | 2 | 2.26 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 165 | 78410G104 | SBA COMMUNICATIONS CORP NEW | CL A | 7 | 2.25 | SBAC · SBA COMMUNICATIONS CORP | REIT | SBA COMMUNICATIONS CORP | 2016-10-24~2026-10-23 | ✓ |
| 166 | 163851108 | CHEMOURS CO | COM | 9 | 2.23 | CC · CHEMOURS CO/THE | Common Stock | Chemours Co | 2016-10-24~2026-10-23 | ✓ |
| 167 | 881624209 | TEVA PHARMACEUTICAL INDS LTD | SPONSORED ADS | 7 | 2.23 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 168 | 22266L106 | COUPA SOFTWARE INC | COM | 13 | 2.23 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 169 | 21871N101 | CORECIVIC INC | Equity | 3 | 2.23 | CXW · CORECIVIC INC | Common Stock | CoreCivic, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 170 | G76279101 | ROIVANT SCIENCES LTD | SHS | 6 | 2.20 | ROIV · ROIVANT SCIENCES LTD | Common Stock | Roivant Sciences Ltd. | 2020-12-08~2026-10-23 | ✓ |
| 171 | G05320109 | ASHTEAD GROUP PLC | COM | 1 | 2.19 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 172 | 252131107 | DEXCOM INC | COM | 9 | 2.17 | DXCM · DEXCOM INC | Common Stock | DEXCOM INC | 2016-10-24~2026-10-23 | ✓ |
| 173 | 655844108 | NORFOLK SOUTHN CORP | COM | 10 | 2.16 | NSC · NORFOLK SOUTHERN CORP | Common Stock | NORFOLK SOUTHERN CORP | 2016-10-24~2026-10-23 | ✓ |
| 174 | 009066101 | AIRBNB INC | COM CL A | 12 | 2.14 | ABNB · AIRBNB INC-CLASS A | Common Stock | Airbnb, Inc. | 2020-12-10~2026-10-23 | ✓ |
| 175 | 707569109 | PENN ENTERTAINMENT INC | COM | 6 | 2.12 | PENN · PENN ENTERTAINMENT INC | Common Stock | PENN Entertainment, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 176 | G7997R103 | SEAGATE TECHNOLOGY HLDNGS PL | ORD SHS | 11 | 2.09 | STX · SEAGATE TECHNOLOGY HOLDINGS | Common Stock | Seagate Technology Holdings pl | 2016-10-24~2026-10-23 | ✓ |
| 177 | 459506101 | INTERNATIONAL FLAVORS&FRAGRA | COM | 10 | 2.09 | IFF · INTL FLAVORS & FRAGRANCES | Common Stock | INTERNATIONAL FLAVORS & FRAGRA | 2016-10-24~2026-10-23 | ✓ |
| 178 | 55616P104 | MACYS INC | COM | 6 | 2.07 | M · MACY'S INC | Common Stock | Macy's, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 179 | 369550108 | GENERAL DYNAMICS CORP | COM | 6 | 2.06 | GD · GENERAL DYNAMICS CORP | Common Stock | GENERAL DYNAMICS CORP | 2016-10-24~2026-10-23 | ✓ |
| 180 | 18915M107 | CLOUDFLARE INC | CL A COM | 8 | 2.05 | NET · CLOUDFLARE INC - CLASS A | Common Stock | Cloudflare, Inc. | 2019-09-13~2026-10-23 | ✓ |
| 181 | 46266C105 | IQVIA HLDGS INC | COM | 13 | 2.05 | IQV · IQVIA HOLDINGS INC | Common Stock | IQVIA HOLDINGS INC. | 2016-10-24~2026-10-23 | ✓ |
| 182 | 049164205 | ATLAS AIR WORLDWIDE HLDGS IN | COM NEW | 4 | 2.04 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 183 | 91680M107 | UPSTART HLDGS INC | COM | 7 | 2.04 | UPST · UPSTART HOLDINGS INC | Common Stock | Upstart Holdings, Inc. | 2020-12-16~2026-10-23 | ✓ |
| 184 | 469814107 | JACOBS ENGR GROUP INC | COM | 4 | 2.04 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 185 | 03768E105 | APOLLO GLOBAL MGMT INC | COM CL A | 5 | 2.03 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 186 | 15912K100 | CHANGE HEALTHCARE INC | COM | 5 | 2.02 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 187 | 09061G101 | BIOMARIN PHARMACEUTICAL INC | COM | 10 | 2.02 | BMRN · BIOMARIN PHARMACEUTICAL INC | Common Stock | BIOMARIN PHARMACEUTICAL INC | 2016-10-24~2026-10-23 | ✓ |
| 188 | 91332U101 | UNITY SOFTWARE INC | COM | 8 | 2.02 | U · UNITY SOFTWARE INC | Common Stock | Unity Software Inc. | 2020-09-18~2026-10-23 | ✓ |
| 189 | 115637100 | BROWN-FORMAN CORP CL A | COM | 3 | 2.00 | BF/A · BROWN-FORMAN CORP-CLASS A | Common Stock | BROWN FORMAN CORP | 2016-10-24~2026-10-23 | ✓ |
| 190 | G0403H108 | AON PLC | SHS CL A | 9 | 1.98 | AON · AON PLC-CLASS A | Common Stock | Aon plc | 2016-10-24~2026-10-23 | ✓ |
| 191 | 69047Q102 | OVINTIV INC | COM | 10 | 1.97 | OVV · OVINTIV INC | Common Stock | Ovintiv Inc. | 2016-10-24~2026-10-23 | ✓ |
| 192 | 256746108 | DOLLAR TREE INC | COM | 8 | 1.95 | DLTR · DOLLAR TREE INC | Common Stock | DOLLAR TREE, INC. | 2016-10-24~2026-10-23 | ✓ |
| 193 | 647581107 | NEW ORIENTAL ED & TECHNOLOGY | SPON ADR | 9 | 1.94 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 194 | H42097107 | UBS GROUP AG | SHS | 8 | 1.93 | UBS · UBS GROUP AG-REG | Common Stock | UBS Group AG | 2016-10-24~2026-10-23 | ✓ |
| 195 | 05352A100 | AVANTOR INC | COM | 9 | 1.92 | AVTR · AVANTOR INC | Common Stock | Avantor, Inc. | 2019-05-17~2026-10-23 | ✓ |
| 196 | 88337F105 | THE ODP CORP | COM | 4 | 1.92 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 197 | G1890L107 | CAPRI HOLDINGS LIMITED | SHS | 9 | 1.90 | CPRI · CAPRI HOLDINGS LTD | Common Stock | Capri Holdings Ltd | 2016-10-24~2026-10-23 | ✓ |
| 198 | 88339J105 | THE TRADE DESK | COM CL A | 7 | 1.90 | TTD · TRADE DESK INC/THE -CLASS A | Common Stock | Trade Desk, Inc. | 2016-10-24~2026-10-23 | ✓ |
| 199 | 13645T100 | CANADIAN PAC RY LTD | COM | 9 | 1.88 |   |  |  | 없음 | — (OpenFIGI 티커 없음) |
| 200 | 92345Y106 | VERISK ANALYTICS INC | COM | 8 | 1.88 | VRSK · VERISK ANALYTICS INC | Common Stock | Verisk Analytics, Inc. | 2016-10-24~2026-10-23 | ✓ |

표 E의 201위 아래(400개)도 같은 방법으로 판정했습니다. 600개 중 OpenFIGI US 티커가 있는 499개 가운데 498개를 채택했고(CTRA는 야후
이력 없음), 101개는 티커가 없어 매핑하지 않았습니다 — 상장폐지·인수된 증권(Twitter·Activision 등)과, 역분할·합병으로 CUSIP이 바뀐
뒤의 옛 CUSIP(DuPont 26614N102 등, OpenFIGI가 현재 티커를 주지 않음)입니다. 외국 발행사 CUSIP(CINS, 영문자로 시작)은 `ID_CINS`로
다시 물어 53개를 더 풀었습니다(Spotify·ASML·Aon·Ferrari 등). 채택 498개 = 티커 498종(지금 `EQUITY_MAP`과 겹치는 티커 포함).
그중 9개는 장외(OTC) 라인입니다(NSRGY·TCEHY·LVMUY ADR, Richemont CFRHF 등 원주, 파산한 FTCHQ) — 같은 증권이라 그대로 씁니다.

**판정 방법** — ① OpenFIGI `v3/mapping`(ID_CUSIP)의 US 합성(`exchCode=US`) 티커·이름·증권 종류, ② SEC `company_tickers.json`의 등록 이름,
③ 야후 10년 일봉의 첫·마지막 날짜. 세 출처의 이름을 토큰으로 대조해 점수가 낮은 5개(IAC→People Inc, Altice USA→Optimum
Communications, ETF 3개)는 같은 증권임을 따로 확인했고, 446행을 에이전트 4개가, CINS로 푼 53행을 에이전트 1개가 "다른 증권인 행 찾기"로 검토했습니다(문제 1건 =
CTRA 가격 없음). OpenFIGI는 지금 상장된 증권에만 US 합성 티커를 주어, 티커 재사용(옛 회사의 티커를 새 회사가 씀) 위험이 낮습니다.

## 5. 10년 가격 저장본 크기·응답 시간 (QA 스택)

| 저장본 | 종목 | JSONB(`pg_column_size`) | 텍스트 | 백엔드 메모리(측정 뒤) |
|---|---:|---:|---:|---:|
| 지금 `equity.price_history` 5년 | 138 | 2.26MB | 5.74MB | 367MiB |
| 같은 종목 10년 | 138 | 4.49MB | 11.45MB | 496MiB(+130MiB) |
| (추정) 매핑 확장 뒤 10년 | 약 553 + ETF | 약 18MB | 약 46MB | 힙(약 700MB) 초과 예상 |

| 경로(콜드 = 저장본 시각을 바꾼 직후 첫 호출, 둘째 회차) | 5년 | 10년 |
|---|---:|---:|
| `/api/guru/risk?cik=0001067983&years=1` | 188ms | 139ms |
| `/api/guru/risk?cik=0000850529&years=3` | 81ms | 229ms |
| `/api/stock/scorecard?symbol=AAPL&years=1` | 55ms | 82ms |
| `/api/analytics/regime/track-record` | 25ms | 24ms |
| `/api/guru/holders?q=APPLE` | 17ms | 15ms |

- [사실] 138종목 10년은 16MB 아래이고 응답 시간도 비슷합니다. 그러나 백엔드가 큰 저장본을 JSON 트리로 파싱해 들고 있어(StoreRepository
  캐시) 텍스트 1바이트당 힙 약 20바이트가 늘었습니다.
- [해석] 트랙레코드에 필요한 종목(약 550)을 같은 저장본에 넣으면 16MB 기준과 백엔드 메모리를 모두 넘습니다. 기존 화면(구루 위험·
  스코어카드·국면 성과)도 10년 이력을 받게 되어 결과가 바뀝니다(국면 성과 응답 8,056 → 8,067바이트).
- 결정 변경(D23): `equity.price_history`는 5년·138종목 그대로 두고, ① 트랙레코드·모멘텀용 10년 일별 종가는 `timeseries`(데이터셋
  `equity_close`, 종목별 행)에, ② 장부 관측치는 작은 시간별 저장본 `paper.quotes`(최근 3개월, 모의 매매 유니버스)에 둡니다. 설계 §0-6·§3-1.

## 6~7. Sonnet 5.5 호출 · SDK 스키마 주입

- [사실] `claude-sonnet-5-5`·`claude-haiku-5-5` 모두 호출됩니다(구조화 출력, effort high, 사고 기본값, `temperature` 없음): 4.6초·2.4초,
  입력 44 / 출력 151·128 토큰, `stop_reason=end_turn`, 응답이 스키마대로 파싱됨.
- [사실] Jackson 3로 읽은 `Map`을 `JsonOutputFormat.Schema.builder().putAdditionalProperty(키, JsonValue.from(값))`로 넣으면 됩니다.
- [사실] 그러나 API가 숫자 `minimum`·`maximum`을 400으로 거절합니다(`output_config.format.schema: For 'number' type, properties maximum,
  minimum are not supported`). 공식 문서상 문자열 `minLength`·`maxLength`, 배열 크기 제한도 지원하지 않고, 모든 객체에
  `additionalProperties: false`가 필요합니다. `const`·`enum`·`pattern`·`["number","null"]`은 통과했습니다.
- 결정 변경: 스키마 파일은 전체 제약을 담고, API에 보낼 때는 지원하지 않는 키를 걷어 냅니다. 범위·길이·개수는 응답을 받은 뒤 코드가
  같은 스키마 파일로 검사하고, 어기면 "응답 형식 오류"(C3)입니다. 설계 §5-1·§5-3.
- 거절 시 서버 쪽 대체 모델(`fallbacks`)은 쓰지 않습니다 — D5 "자동 전환 없음".

## 8. 2026-10-23 FRED·환율 값

| 값 | 결과 |
|---|---|
| `DGS10` | 10-23 값은 아직 없음(FRED는 다음 영업일 게시, 마지막 10-22 = 4.96%). 10-19~21: 5.15·5.12·5.13 |
| `DGS2`·`DGS30`·`DGS3MO`·`DFII10`·하이일드·IG | 마지막 10-22 |
| `T10Y3M`·`T10YIE` | 10-23까지 있음 |
| `macro.fx_history` `usdjpy` | 10-23 = 156.814 |
| SPY 10-23 종가(수정) | 759.97 |

- 영향: 없음. 초기 패킷은 `PointInTime.asKnownOn`(다음 영업일 게시)으로 10-23에 알 수 있었던 값 = 10-22 관측치를 씁니다. 10-23 값은
  "값 없음"으로 두지 않고 "10-22 관측(10-23에 알려진 최신)"으로 적습니다.

## 그 밖에 찾은 것

- 기존 `feature/insight/TrackRecordService`(국면 판정 성과)와 이름이 겹칩니다. 스프링 빈 이름이 같아지므로 새 클래스는
  `PaperSelectionService`로 합니다.
- 규칙 계좌·Claude 계좌는 사용자가 "시작"을 눌러야 첫 결정을 하므로(L2), 계좌 상태에 `NOT_STARTED`를 둡니다.

---

## 단계 0-b. SEC XBRL 측정 (2026-10-25)

> 명세 D28(미국 종목 재무를 Claude 계좌 패킷에)의 근거입니다. 요약과 영향은 설계 §13 마지막 행, 설계는 §4-5입니다.
>
> - 측정 방법: 운영 수집기 컨테이너 안에서 `app.http.get_sec_session()` + `sec_rate_limit()`에 요청마다 0.2~0.25초를 더 쉬며 **순차** 호출(초당 4건 이하).
>   목록 2 + companyfacts 47(표본) + 70(해외 발행사 확인) + 대안 API 11 ≈ 130건. 원본은 컨테이너 `/tmp`에만 두었다가 지웠고, DB·저장소 파일은 건드리지 않았습니다.
> - 표본 47곳: 초대형(AAPL MSFT NVDA AMZN GOOGL META)·은행(JPM BAC WFC)·보험(PGR BRK-B CB)·리츠(PLD SPG EQIX)·에너지(XOM EPD)·재고 유통(WMT COST)·
>   산업재(CAT HON GE UNP)·해외(TSM ASML BABA SHOP SAP NVO TM CNQ)·소형(SPWH GPRO SEER)·무작위 13(seed 20261025).

### A. 유니버스 → CIK

| 항목 | 값 |
|---|---|
| 주식 후보 | `paper_universe.tradable()` 615 − `PAPER_ETFS` 19 = **596** |
| `company_tickers.json` | 10,425행 · 798KB · 0.1초 |
| 매핑 성공 | **571**(모두 그대로 일치 — SEC도 `BRK-B`·`BF-B`·`HEI-A` 표기라 `.`↔`-` 변형은 0), 서로 다른 CIK 565(같은 CIK 묶음: BF-A/B·BRK-A/B·BUD/BUDFF·FOX/FOXA·GOOG/GOOGL·LBTYA/K) |
| 매핑 실패 25 | 13F 매핑표에서 온 ETF 19(`company_tickers_mf.json`에 있음, 재무 없음) + 장외 해외주·파산 6(CFRHF FTCHQ LVMUY NSRGY PDRDF TCEHY) |
| 매핑됐지만 재무 없음 | SLV(실물 신탁), IBN(companyfacts **404**) → 실제 대상 운영회사 CIK 약 **564** |
| 이전 법인 CIK | [사실] XOM은 새 지주회사 CIK 0002115436에 2026-08-03 10-Q 하나(사실 280개)뿐이고, 10년 이력은 옛 CIK 0000034088에 있습니다. 새 CIK의 `formerNames`가 비어 자동 연결이 안 됩니다. CIK ≥ 1,990,000(최근 등록) 매핑 9곳: GEV SW FERG **BLK** CBRS PRMB MDLN SUNB **XOM**. [해석] BLK·FERG도 지주회사 재편으로 보입니다 — [확인 필요] |

### B. companyfacts 크기·시간 (전부 gzip 전송)

| 묶음 | n | 전송 KB 평균 | JSON MB 평균 | 초 평균 | 비고 |
|---|---:|---:|---:|---:|---|
| 전체 | 47 | 227 | 3.40 | 0.345 (p90 0.58, 최대 1.13) | 합계 전송 10.9MB · JSON 160MB |
| 국내(해외·XOM 제외) | 38 | 266 | 3.97 | 0.362 | 은행이 가장 큼: JPM 530KB / 7.8MB |
| 해외 | 8 | 68 | 1.12 | 0.287 | 20-F는 연간 자료뿐이라 작음 |
| 무작위 | 13 | 213 | 3.19 | 0.534 | |

- [사실] JSON 파싱 평균 0.024초(최대 0.064초), 필요한 개념 추출은 1ms 미만입니다. 분류체계: `dei` 47, `us-gaap` 42, `ifrs-full` 6.

### C. 개념별 최신성 (최신 `end` ≥ 2025-12-31인 곳 수, 표본 47 — IFRS 6은 따로)

| 필드 | 요청 개념으로 | 대체 개념으로 | IFRS | 최신값 없음 |
|---|---:|---|---:|---|
| 매출 | 40 | WFC=`RevenuesNetOfInterestExpense` | 4 | TSM TM |
| 순이익 | 38 | SPG·CAT·OXY=`ProfitLoss` | 4 | TSM TM |
| 영업현금흐름 | 41 | — | 4 | TSM TM |
| 설비투자 | 25 | `PaymentsToAcquireProductiveAssets`(NVDA AMZN GE SPG EQIX EPD SW), PLD=`PaymentsToAcquireRealEstate`, HAIN=`…OtherPropertyPlantAndEquipment` | 2 | 은행·보험(JPM BAC WFC CB FNF), BABA SAP CNQ RUN, TSM TM |
| 자산 | 41 | — | 4 | TSM TM |
| 자본 | 39 | EPD=`PartnersCapital`, CAT=`…IncludingPortionAttributableToNoncontrollingInterest` | 4 | TSM TM |
| 매출채권 | 23 | 6곳=`ReceivablesNetCurrent` | 4 | 은행·보험·리츠·MLP 전부, SEER DAR, TSM TM |
| 재고 | 25 | NKE=`InventoryFinishedGoodsNetOfReserves` | 3 | 금융·리츠·소프트웨어·서비스 — 해당 없음 |
| 장기부채 | 32 | JPM=`…IncludingCurrentMaturities`, PGR=`DebtInstrumentCarryingAmount`, XOM·PODD·DAR=`LongTermDebtAndCapitalLeaseObligations` | 4 | BRK-B BABA SHOP SEER TSM TM |
| 자사주 매입 | 33 | — | 4 | AMZN PGR PLD EQIX SPWH SEER HAIN RUN — 대개 '매입 안 함' |
| 배당 | 24 | 4곳=`PaymentsOfOrdinaryDividends`, EPD=`DistributionMadeToLimitedPartnerCashDistributionsPaid` | 4 | 무배당 회사, SPG(2019 이후 없음), TSM TM |
| 희석 주식수 | 37 | — | 3 | BRK-B STZ SEER XOM(새 CIK) BUDFF TSM TM |
| `dei:EntityCommonStockSharesOutstanding` | 37 | `us-gaap:CommonStockSharesOutstanding`·희석 가중평균 | — | **복수 주식 종류**(GOOGL META BRK-B SPG NKE STZ SNAP GPRO SHOP) + NVO |

- [사실] `SalesRevenueNet`은 어느 회사에서도 2019-03 이후 사실이 없어 후보에서 뺍니다.
- [해석] 복수 주식 종류 회사의 dei 주식수가 빠지는 것은 companyfacts가 회사별로 나뉜(dimensional) 사실·회사 확장 태그를 싣지 않기 때문으로 봅니다(관측과 맞는 추정).

### D. 형태의 함정

| 함정 | 확인한 것 | 설계에서 |
|---|---|---|
| 10-Q 현금흐름은 연초부터 누계 | AAPL 최신 10-Q의 영업현금흐름은 272일(9개월) 누계와 전년 비교 둘뿐. 국내 표본 대부분이 6·9개월치만 냄(MSFT·SHOP·SNAP은 3개월치도, AMZN은 364일 TTM도). COST는 12/12/12/16주라 9개월 누계가 251일 | 누계 차감, 기간 길이 분류에 52/53주 폭 |
| 4분기 3개월 사실 없음 | 손익은 보통 3개월 사실이 있지만 10-K에는 4분기 3개월치가 없음 | Q4 = 연간 − 9개월 |
| `fy`·`fp`는 공시 기준 | AAPL 2025-06-28 분기 매출이 fy 2025(2025-08-01 공시)와 fy 2026(2026-07-31 공시의 비교 열)로 두 번 나옴 | 기간은 start/end로만 |
| `frame`은 그 시점 값이 아님 | 사실의 38%에만 있고(회사별 28~60%), 6·9개월 누계에는 없음. 가장 늦게 낸 값에 붙어 정정이 있으면 옮겨 감(GPRO `CY2025Q3` 순이익: 10-K/A −27.4M, 원래 10-Q −21.25M) | `frame` 쓰지 않음 |
| 중복 | 사실 수 / 서로 다른 (start, end) 수 = 평균 2.07배(최대 2.42배) — 당해 공시와 다음 해 비교 열 | 처음 낸 값 + 값이 바뀐 행만 저장 |
| 정정 공시(/A) | 47곳 중 24곳, 1,141개: 같은 값 789(69%), **값이 다름 53(5%)**(GPRO 2025년 9개월 순이익 −84.4M → −90.5M 등), 원본에 없는 기간 299(26%) | 같은 기간은 기준일까지 낸 것 중 가장 늦은 값 |

**그 시점에 알 수 있었던 값(`filed ≤ 2026-10-23`)**

| 종목 | 최신 기간 end | 공시·filed | 그날 알 수 있던 값(예) |
|---|---|---|---|
| AAPL | 2026-06-27 (FY2026 Q3) | 10-Q · 2026-07-31 | 매출 3개월 109.417B / 9개월 누계 364.357B, 순이익 3개월 29.789B, 영업현금흐름 9개월 누계 116.996B, 자산 383.266B |
| JPM | 2026-06-30 (2026 Q2) | 10-Q · 2026-08-06 | 순이익 3개월 21.155B / 6개월 37.649B, 자산 5.015T, 장기부채(`…IncludingCurrentMaturities`) 460.5B. `Revenues`는 10-K(FY2025)에만 있고 분기 매출은 `RevenuesNetOfInterestExpense` |

- [사실] 10-24~25에 낸 사실은 두 회사 모두 없습니다(AAPL FY2026 10-K·JPM 3분기 10-Q 제출 전).
- [사실] 실적 보도자료(8-K)는 XBRL 재무 사실로 들어오지 않습니다. 실적 발표 뒤 10-Q가 나올 때까지 몇 주 동안 패킷은 직전 분기 값입니다(보도자료 날짜는 확인하지 않음).

### E. 해외 발행사·IFRS (표본 9 + 추가 확인 70 = 79곳)

| 항목 | 결과 |
|---|---|
| IFRS(`ifrs-full`) 사용 | 약 **40 CIK**(유니버스의 약 7%) |
| 20-F 연간만 내는 US-GAAP 해외 발행사 | 22곳(중국 ADR 다수, ASML BABA ARM SE AER WIX 등) |
| 이미 10-K/10-Q로 바꾼 곳 | 16곳(SHOP CNR CP BAM CPNG MELI FLUT CRH FERG JHX CNH QSR SDRL HUT LILAK ONC) |
| IFRS 최신 연보가 companyfacts에 없음 | **13곳**: TSM TM SONY HMC BHP DEO PBR BAP NU STNE XP TME RYAAY |
| 통화 | EUR·GBP·JPY·CAD·CNY·BRL·INR·PEN·ARS 등. 중국 ADR은 US-GAAP이라도 CNY로 내고 USD 환산값을 함께 둠. 20-F 발행사 다수는 `dei` 주식수 없음 |
| 6-K 중간 재무 | NVO BUD TSM UBS CVE BHP 등이 6-K에도 싣지만 추출 범위(10-Q/10-K/20-F/40-F)에서 뺌 |

- [사실] 2026-03-27 이전에 낸 IFRS 연보(RIO SHEL SAP NVO CNQ BUD VALE YPF…)는 들어 있고, **2026-04-09 이후에 낸 IFRS 연보에는 `ifrs-full` 사실이 없습니다**.
  같은 공시의 `dei` 사실은 들어와 있습니다(예: TSM 20-F 2026-04-16). US-GAAP 20-F는 2026-04 이후 제출분도 있습니다(PDD 04-29, TCOM 04-28).
- [해석] SEC API가 IFRS 2026 분류체계를 아직 처리하지 못하는 것으로 추정합니다 — [확인 필요]. 설계는 최신 기간 end가 15개월 넘게 앞서면 `isStale`로 둡니다.

### F. 대안 API와 1회 비용

| API | 크기(전송/JSON) | 판단 |
|---|---|---|
| companyconcept(개념 하나에 요청 하나) | 3~4KB / 26~51KB, 0.3~0.4초 | 회사당 20건 이상 → 564곳이면 1만 건 이상, 8 rps로도 24분 넘음. 전체 수집에 부적합 |
| frames(`CY2025Q2` 등) | 156KB / 816KB, 5,322행 | **`filed`가 없고** 가장 늦게 낸 값만이라 그 시점 값이 아님, 누계 현금흐름 빠짐 → 부적합 |
| submissions | AAPL 28KB, **JPM 475KB / 4.66MB** | 은행은 companyfacts만큼 커서 '새 공시 감지용'으로 싸지 않음 |
| 일괄 `companyfacts.zip` | **1.41GB**(매일 갱신) | 회사별 전체 수집의 10배 → 부적합 |

| 항목(대상 약 567건 — 운영회사 564 + 이전 법인 약 3) | 추정 |
|---|---|
| 내려받기 | **약 120~140MB/회** |
| 압축 푼 JSON | 약 1.9GB/회(한 번에 하나만 메모리에, 최대 약 8MB 문서, 파싱 합계 약 14초) |
| 시간(순차) | **약 3.5~5.5분**(0.37초 × 567 = 210초 ~ 무작위 평균 0.56초면 320초) |
| 저장(필드마다 개념 하나·중복 제거) | 회사당 평균 25.5KB(최대 44KB GE) → **전체 약 15MB** |
| 저장(대체 개념 전부·중복 제거 / 중복 그대로) | 약 20MB / 약 37MB |

### G. 측정 권장안과 D28에서 정한 것

| 권장안(측정) | D28(설계 §4-5) |
|---|---|
| companyfacts만 회사별로. companyconcept·frames·zip 쓰지 않음 | 그대로 |
| `weekly` 속도군(상한 1,800초), 1회 200 CIK — slow(600초)는 전체 1회에 재시도가 겹치면 상한에 가까움 | 그대로(`FUNDAMENTALS_FETCH_BUDGET`, 1~600) |
| 우선순위 ① 보유·당일 후보 ② 기간 end + 40일(10-Q)·+ 60~90일(10-K) 지나고 아직 안 받음 ③ 가장 오래전 | ① 한 번도 안 받은 종목 ② end + 40일 / 10-K + 75일 ③ 가장 오래전, 같은 순위는 티커 순 |
| 회사별 행 저장(스냅샷 하나는 약 15MB라 16MB 기준에 걸림), 수집기 소유 | 기존 `observations`(`us.fundamentals`, entity = 티커, `obs_date = filed`) — 새 테이블 없음 |
| 같은 기간은 처음 낸 값 + 값이 바뀐 행만 | 그대로 |
| 시점: `filed < D`(날짜뿐이라 하루 보수) | **`filed ≤ d`** — 13F `filingDate ≤ asOf`와 같게(공시일 d는 동부 17:30 전 접수라 KST 다음 날 아침 결정 전에 공개) |
| 기간은 start/end로만, 52/53주 폭, 누계 차감, TTM = 직전 연간 + 당해 누계 − 전년 누계 | 그대로 |
| 대체 개념은 고정 순서가 아니라 가장 최근 end 후보, 한 시계열 안에서 섞지 않음, 쓴 개념 이름 표시. 없으면 `null` | 그대로(필드별 후보 표는 설계 §4-5 ⑤) |
| IFRS 포함, 통화 저장, USD 아니면 비율만, 15개월 넘으면 `isStale` | 그대로(금액 지표 `null`) |
| CIK 별칭표(수동 소량, XOM 확인·BLK·FERG 확인 필요) | `FUNDAMENTALS_CIK_ALIASES` — CIK ≥ 1,990,000 9곳을 구현 때 submissions로 확인 |
| 패킷은 보유·후보 종목에만 파생 지표(종목당 1~2KB 추정) | 섹션 `8b_fundamentals` 최대 25종목 ≈ 3,000토큰, 패킷 목표 25,000 → 30,000토큰 |
