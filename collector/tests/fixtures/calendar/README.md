# 미국 발표·실적 일정 테스트 입력 (`us_calendar`, 2단계 명세 A·§10)

키·연락처·쿠키(crumb)는 들어 있지 않습니다. 날짜는 2026-10-25 수집기 컨테이너에서 받은 값입니다.

- `fred_release_dates_cpi.json` — **실제 응답 그대로**(단계 0). `fred/release/dates?release_id=10`(CPI),
  `include_release_dates_with_no_data=true`, `realtime_start=2026-10-25`, `realtime_end=2026-12-08`, `sort_order=asc`.
- `fred_release_dates_step0.json` — 위 응답과 **같은 모양**에 단계 0에서 받은 날짜를 넣어 만든 릴리스 54(PCE)·50(고용)·53(GDP)
  응답(키 = release_id). 12-23은 45일 창(10-25 기준 12-09까지) 밖이라 일정에서는 빠지고 `lastKnownDate`(FRED가 아는 마지막 날짜)로만 남아야 합니다. 실제 응답 원문이 아닙니다.
- `quote_summary_calendar_events.json` — **실제 응답 그대로**. yfinance 1.7.0 `yf.Ticker(t)._quote._fetch(['calendarEvents'])`의
  반환값(키 = 티커). AAPL(2026-11-02 20:00 UTC → AMC, 추정 아님), PANW(2026-11-19 20:00 UTC, `isEarningsDateEstimate` true →
  장 구분 없음), JPM(2027-01-14 12:30 UTC → BMO). ETF(SPY)·없는 종목은 Yahoo가 404를 주고 yfinance가 `None`으로 바꿔 돌려주므로
  원문이 없습니다(시험에서 `None`으로 둠).

## 미국 지표 컨센서스 (`us_calendar_consensus`, v2 2단계 명세 §4-12·K22·B9)

키가 없는 출처입니다. 2026-10-26 23:3x UTC에 수집기 공용 세션(브라우저 UA)으로 받은 `api.nasdaq.com/api/calendar/economicevents?date=…` 응답을
줄인 것입니다 — 행의 `description`(제3자 설명문, 저장하지 않음)은 "(생략)"으로 바꿨고, 나머지 칸의 글자(`' '`·`'&nbsp;'`·단위가 붙은 값)는 원문 그대로입니다.

- `nasdaq_economicevents_date_2026-10-23.json` — `date=2026-10-23` 응답에서 미국 행 11개 전부 + 다른 나라 행 2개. **행은 목요일 10-22의 것**입니다
  (실업수당 청구·천연가스 재고·KC 연은) — Nasdaq은 `date=D`에 미국 동부 D−1의 행을 줍니다(같은 날 date=10-22·10-28·10-29로도 확인).
- `nasdaq_economicevents_date_2026-10-29.json` — `date=2026-10-29` 응답의 미국 행 22개 중 10개(MBA·무역수지·원유 재고·FOMC 성명·금리 결정 등 —
  **수요일 10-28의 행**) + 다른 나라 행 1개를 옮겨 적은 것. 칸 모양은 위와 같고 행의 값은 그 응답 그대로입니다.
