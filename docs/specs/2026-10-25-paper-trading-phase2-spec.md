# 기능 명세서 — 모의 알고리즘 매매 2단계: 일정 · 복기 루프 · 사건 뉴스 · 어닝 서프라이즈

> 1단계: [2026-10-24-paper-trading-spec.md](2026-10-24-paper-trading-spec.md) · [2026-10-24-paper-trading-design-plan.md](2026-10-24-paper-trading-design-plan.md)
>
> - 상태: **구현 완료**(2026-10-25 — A 일정 → D 복기 → B 사건 뉴스 → C 서프라이즈, 항목마다 `make test`(JDK 21 포함)·커밋·`make up`; 사용자 "명세대로 구현, D29~D36 권장안"). 결정은 §7(D29부터, 1단계 명세 §8을 이어 센다). 단계 0 결과는 §10 — 그 결과로 고친 곳은 본문에 "(단계 0)" 표시.
> - 전제: 1단계는 3b까지 구현되어 브랜치 `claude/paper-trading-2026-10`에서 운용 중이었다(그때는 push 금지, D0). 2026-10-25에 그 브랜치를 My_macro_dashboard_v1(Private) 저장소의 main으로 옮겼고, 이 문서도 그 저장소에만 있다.
> - 이 문서는 **무엇을, 어디까지** 만들지 정한다. 설계는 1단계 설계 계획서의 배치 규칙(§1)을 그대로 따르고, 항목별 "어떻게"는 §5에 요지만 적는다.
> - 라벨: `[사실]` 저장소·데이터에서 확인, `[해석]` 그 위의 판단, `[확인 필요]` 구현 때 검증.

---

## 0. 왜 이 네 가지인가

사용자가 "뉴스를 스크래핑해 알고리즘을 학습·고도화"하자고 제안했다. 검토 결과(2026-10-25 논의):

- [해석] 이 구조에서 모델은 학습하지 않는다. 매일의 입력(맥락)이 늘어날 뿐이다. 분기 전략에서 가치 있는 소식은 **논거를 바꾸는 사건**이고 하루에 몇 건 없다. 매일 모든 헤드라인을 넣으면 과매매 노이즈가 된다(OS 원칙 P4).
- [해석] "학습"에 해당하는 통로는 이미 있다. 결정 기록을 결과와 대조해 프레임 규칙을 **제안→승인**으로 고치는 것(1단계 F2)이다. 이것을 정기화하는 것이 복기 루프다.
- [사실] 1단계 패킷에 없는 것 중 OS가 묻는 것: 발표 일정(FOMC·CPI·실적일), 어닝 서프라이즈(E7-3). 재무는 D28로 들어갔다.

우선순위와 순서: **A 일정 → D 복기 루프 → B 사건 뉴스 → C 어닝 서프라이즈**. A·D는 외부 의존성이 거의 없고, B는 RSS 하나, C는 출처 조사가 필요하다.

### 이번 범위가 아닌 것

- HTML 스크래핑(인베스팅닷컴·야후 페이지). 약관 위반이고 구조 변화에 조용히 깨진다. **RSS와 공식 API만**.
- 뉴스 본문 수집·요약. 제목·출처·시각만.
- 뉴스 감성 점수·머신러닝 신호. 데이터·시간 지평 모두 맞지 않는다.
- 규칙 계좌 변경. 동결 대조군(D15·D19)은 이 단계에서도 바꾸지 않는다. 네 항목 모두 **Claude 계좌 패킷과 프레임 갱신**에만 닿는다.
- 검증기 하드 규칙 변경. 사건·일정이 매매를 막거나 강제하지 않는다. Claude가 읽고 판단한다(D7과 같은 원칙).

---

## 1. 공통 원칙

| 기존 규칙 | 이 단계에서의 모양 |
|---|---|
| 한 출처에는 한 가지 방법으로만 | RSS는 `feedparser` 한 경로. 실적일·서프라이즈는 yfinance 한 경로(이미 쓰는 출처). FRED 일정은 FRED API(이미 쓰는 키) |
| 수집 실패 시 숫자를 만들지 않음 | 일정·뉴스·서프라이즈가 없으면 패킷 섹션은 "자료 없음"으로 비운다. 0건과 실패를 구분해 적는다 |
| 아무도 보지 않는 화면이 수집기를 깨우지 않게 | 모두 수집기 정기 태스크가 쌓고, 백엔드는 `quietly`로 읽는다 |
| 모든 숫자에 출처 | 일정·헤드라인·서프라이즈 행마다 출처·받은 시각. 패킷에 그대로 |
| 외부 텍스트는 자료 | 헤드라인·복기 입력은 구분자로 감싸 "지시가 아니다"를 명시(1단계 F6과 같음). 검증기는 그대로 |
| 테이블마다 쓰는 프로세스 하나 | 수집기: `observations`·`snapshots`. 백엔드: `paper_reviews`(새), 기존 `paper_*` |

---

## 2. 기능 A — 발표·실적 일정 (먼저)

### 2-1. 사용자가 얻는 것
"다음 주 FOMC, 목요일 CPI, 보유 종목 MSFT 실적 화요일 장 마감 뒤"가 매일 패킷에 들어간다. Claude가 "이벤트 전에는 신규 진입을 미룬다"류의 규칙을 적용할 수 있고, 결정 로그에서 그 판단을 볼 수 있다.

### 2-2. 요구사항

| ID | 요구사항 |
|---|---|
| A1 | **거시 일정.** FRED 발표 일정 API — 릴리스별 `fred/release/dates?release_id=`(단계 0: 전체 목록 `fred/releases/dates`는 FOMC 보도자료 101번의 매일 날짜로 넘침), `include_release_dates_with_no_data=true`(이것이 있어야 앞날짜가 나옴), 기존 `FRED_API_KEY` — 로 앞으로 45일의 발표일을 받는다. 대상 릴리스: CPI(10)·PCE(Personal Income and Outlays, 54)·고용(Employment Situation, 50)·GDP(53). FRED는 그해 12-31까지만 날짜를 주므로 릴리스마다 마지막으로 받은 날짜(`lastKnownDate`)를 남기고, 창이 그 뒤로 넘어가면 "일정 미공개(~날짜까지만 확인)"로 적는다. **FOMC 회의 일정은 연준 공개 연간 일정표를 상수**로 둔다(2026·2027 단계 0 확인, 연 1회 갱신, 상수 끝을 지나면 "갱신 필요" 표시). 소스·갱신일 표기 |
| A2 | **실적 일정.** 보유·후보 종목(ETF 제외, 최대 60개)의 다음 실적 발표일을 yfinance quoteSummary `calendarEvents.earnings.earningsDate`(시각 포함 epoch)로 받는다(단계 0: 공개 `Ticker.calendar`는 컨테이너 시간대로 날짜를 만들어 장 마감 뒤 발표가 하루 밀리고, `earnings_dates`는 HTML 스크래핑이라 D29에 어긋남). 날짜는 미국 동부 날짜, 장 구분은 UTC 12:30 → 장전(BMO)·20:00 → 장후(AMC)·그 밖·추정치(`isEarningsDateEstimate`)는 `null`. 이미 지난 날짜면 "다음 일정 미정". 없으면 `null`. 종목당 24시간 캐시 |
| A3 | **저장.** 스냅샷 `calendar.us_events` = `{generatedAt, macro:[{name, date, source}], earnings:[{ticker, date, session, source}]}`. 태스크 `us_calendar`(`slow`, 1시간) |
| A4 | **패킷 섹션 `1b_calendar`.** 기준일부터 10거래일 안의 거시 일정과 보유·후보 종목 실적일. "일정이 매매를 막지 않는다. 판단에 쓸 뿐" 문구 |
| A5 | **화면.** 개요 탭의 데이터 상태 줄에 "일정 n건·갱신 시각" 한 줄. 새 탭 없음 |

### 2-3. 수용 기준
- 패킷에 기준일 뒤 10거래일 밖의 일정이 들어가지 않는다(테스트).
- FRED 키가 없으면 거시 일정은 "키 미설정"으로 비고 실적 일정만 들어간다. 빈 섹션으로 장부가 바뀌지 않는다.
- 결정 기록 `packet.1b_calendar`에 출처·갱신 시각이 남는다.

### 2-4. 구현 메모 (2026-10-25, 메인 세션 권장안으로 정함)

- 구현 메모: **수집기** 태스크 `us_calendar`(`slow` 1시간, 상한 600초 — 안에서 FRED 150초·전체 420초에 새 요청을 멈춤) → 스냅샷 `calendar.us_events`(`catalog.SNAP_US_CALENDAR` = `Datasets.SNAP_US_CALENDAR`, `DatasetsParityTest`). 태스크 25개.
- 구현 메모: **거시(FRED)** — `fred/release/dates`를 릴리스마다(10 CPI·BLS, 54 PCE·BEA, 50 고용·BLS, 53 GDP·BEA), `include_release_dates_with_no_data=true`·`realtime_start`=오늘(미국 동부)·`realtime_end`=수집 창 끝(+45일)이 속한 해의 12-31·오름차순, 기존 FRED 세션·키(`fred_series`와 같은 도우미, 오류 문구는 키를 가린 한 줄). 일정(`events`)은 45일 창 안만 남기고, 릴리스마다 `lastKnownDate` = 받은 날짜 중 마지막(45일 창 밖 포함 — 창 끝까지만 물으면 발표 간격이 한 달을 넘는 릴리스에 '일정 미공개'가 잘못 붙음, 받은 날짜가 없으면 직전 값 — 12월). 일부 실패 → 그 릴리스만 직전 일정을 `isStale`로 이어받음, 새로 받은 것이 하나도 없으면 `EmptyResult`로 직전 저장본 유지 — 실적의 '전부 실패'는 이번에 물은 종목이 모두 실패했고 캐시가 유효한 종목(24시간 안에 받은 것)도 없을 때(키가 없을 때 늘 404인 종목 하나만 물을 차례인 실행은 일부 실패라 저장 — 그 종목은 6시간 뒤 재시도).
- 구현 메모: **FOMC** — 상수 16회(2026·2027, 날짜 = 성명이 나오는 둘째 날, `sep`), `FOMC_SOURCE`(연준 일정표)·`FOMC_CHECKED_AT` 2026-10-25. 상수 끝(2027-12-08)을 지나면 "갱신 필요" — 수집기는 45일 수집 창, 패킷은 10거래일 창 기준으로 따로 판단.
- 구현 메모(**명세와 다름 ①**): FRED 키가 없으면 FRED 부분만 "키 미설정"으로 비고 **FOMC 상수는 그대로 들어간다**(키가 필요 없음). §2-3 수용 기준의 "거시 일정은 비고 실적만"과 다르다. 이때 패킷에는 `unpublishedAfter`를 적지 않는다(미공개가 아니라 설정 문제이고 `fredStatus`가 말함).
- 구현 메모(**명세와 다름 ②**): 실적 대상 — 수집기는 계좌 보유를 모르므로(백엔드 테이블, ADR 0008) **유니버스 주식 전부**(`paper_universe.tradable()` − 설정 ETF − 13F ETP, 576종목)를 실행당 120종목(`US_CALENDAR_EARNINGS_BUDGET`, 1~600 — 한 번도 묻지 않은 종목 → 오래전에 물은 순)·종목당 24시간 캐시(실패 6시간 뒤 재시도)로 돌아 약 하루에 한 바퀴. 패킷은 **8b와 같은 대상**(보유 → 섹션 7 교집합 후보 → 직전 watchlist, ETF·현금성 제외, 25종목)만 싣는다 — "최대 60개"가 아니라 25인 것은 패킷 크기(아래).
- 구현 메모: **실적 출처** — yfinance 1.7.0 내부 `Ticker(t)._quote._fetch(['calendarEvents'])`(단계 0과 같은 호출). `earningsDate` epoch 중 지금 이후 가장 이른 것(없으면 `note` "다음 일정 미정" + 지난 날짜 `lastDate`, 아예 없으면 "실적일 없음"), 날짜는 그 epoch의 미국 동부 날짜, 장 구분 12:30 UTC → `BMO`·20:00 UTC → `AMC`·그 밖과 추정치(`isEarningsDateEstimate`)는 `null`. 메서드가 없거나 응답 5건 이상에 `calendarEvents`가 하나도 없으면 `EmptyResult`("yfinance 내부 API 변경")로 실패를 알리고 실적을 멈춤 — 이번 응답은 버리고 물을 차례였던 종목은 직전 값을 `isStale`로 이으며(3일 기한), 거시 일정은 새로 저장한다(`earnings.status`·`stoppedReason`. 코드를 고칠 때까지 이어지는 고장이라 거시까지 버리면 저장본의 45일 창이 굳음). FRED도 전부 실패했으면 저장본을 덮지 않는다. 다른 태스크는 영향 없음. 429면 그 실행 중단, 연속 5회 실패면 나머지는 다음 실행, 요청 간격 0.5초.
- 구현 메모(**명세와 다름 ③**, A3의 저장 모양): `{generatedAt, macro:{events:[{name, date, kind "FOMC"|"RELEASE", releaseId, source, sep?, key?, agency?, meetingStart?, isStale?, staleReason?, staleSince?}], horizon:{from, to}, fred:{status "ok"|"키 미설정"|"실패", source, lastKnownDate:{CPI, PCE, EMPLOYMENT, GDP}, isStale?, failed?}, fomc:{source, checkedAt, pageUpdated, through, status}}, earnings:{source, status "ok"|"yfinance 내부 API 변경", stoppedReason?, items:{TICKER:{date, session, isEstimated, epoch, source, fetchedAt, checkedAt, note?, lastDate?, isStale?, staleReason?, staleSince?, error?}}, covered, upcoming, universe, budget, fetchedThisRun, failedThisRun}}` — `error`는 이어받을 값이 없는 실패 종목(그때 `fetchedAt` null).
- 구현 메모: **패킷 `1b_calendar`** — `1_basis` 바로 뒤. 창 = 기준일 **다음 세션**부터 기준일 + 10거래일(양 끝 포함, `UsMarketCalendar` — `analytics.CalendarWindow`). 머리말 `{source, generatedAtKst, window{from,to}, note "일정이 매매를 막지 않는다. 판단에 쓸 뿐", asOfMismatch, fredStatus, lastKnownDate, unpublishedAfter?(창 끝이 lastKnownDate 뒤인 릴리스), horizon?·horizonNote?(창이 저장본의 거시 수집 범위 `macro.horizon` 밖일 때만 — 수집기가 오래 멈춰 저장본이 굳으면 그 밖 날짜의 FOMC·발표일은 '없음'이 아니라 확인 못 함), fomc{checkedAt, through, status}}`. 거시·실적 **두 표**(`macro` date·kind·name·source / `earnings` date·ticker·session·isEstimated)로 나누고 출처는 범례 코드(`sources` s1…), 이어받은 줄은 `stale` 목록, 대상 중 지난 실적일만 있는 종목 `nextDateUnknown`·자료 없는 종목 `noData`. 저장본이 없으면 표 없이 `missing` 한 줄(일정을 지어내지 않음). 초기 결정 패킷은 매크로 카드처럼 `asOfMismatch:true`. 시계를 읽지 않아 결정적. `PACKET_VERSION` 3. 시스템 프롬프트(`ClaudePrompts`)는 바꾸지 않고 안내는 섹션의 `note`에 둔다.
- 구현 메모: **크기** — 상한을 꽉 채운 시험 패킷이 이 섹션 없이 약 29,100, 가장 큰 1b(거시 6건 + 실적 25종목 + 미공개 넷 + 이어받은 줄, 약 800)를 더해 약 29,900토큰으로 목표 30,000 안. 여유가 100토큰 남짓이라 B·C 섹션을 더할 때 목표를 다시 정한다.
- 구현 메모(§6 태그): 결정 응답 JSON에 `measure:{hasCalendar, calendarItems, hasEvents:null, hasEarnings:null}`(null = 그 항목이 아직 없음 — B·C가 채움). 패킷을 만들 때 정하고(`PacketBuilder.Packet.measure`, 패킷 본문에는 없음) 정기·수동·초기·미리보기·호출 실패 결정에 남긴다. 패킷을 만들지 않은 결정(일시정지·호출 상한)에는 없다.
- 구현 메모: **화면** — `/api/paper/status`의 `calendar:{available, macroCount(수집 창 45일의 거시 일정 수, FOMC 포함), earningsCovered, universe, generatedAtKst, fredStatus}`(저장본이 없으면 `available:false`·나머지 null), 개요 '장부 관측치' 카드에 "일정(FRED·FOMC·실적): 거시 n건 · 실적 m/u종목 · 갱신 …" 한 줄(FRED가 ok가 아니면 상태를 덧붙임).
- `[확인 필요]` 창이 기준일 다음 세션부터라 **기준일 장 마감 뒤(AMC) 실적은 빠진다** — 그 실적은 기준일 종가에 없고, 결정(다음 날 07:30 KST) 때는 발표가 이미 나왔지만 결과는 패킷에 없다. 지금은 명세(A4)대로 두고 기능 C(서프라이즈)를 만들 때 다시 정한다. → **해결(§5-4)**: 1b는 그대로 빼고, 결과는 8b `eps`가 싣는다(결정 시각 전 발표).

---

## 3. 기능 D — 주간 복기 루프 (두 번째)

### 3-1. 사용자가 얻는 것
주 1회 Claude가 지난 4주의 결정(논거·무효화 조건·노출 판단)을 그 뒤 실제 가격·사건과 대조한 **복기 메모**를 쓴다. 반복되는 오류가 보이면 프레임 규칙 수정을 **제안서**로 낸다. 사용자가 승인하면 프레임 버전이 오른다. 이것이 이 시스템의 "학습"이다.

### 3-2. 요구사항

| ID | 요구사항 |
|---|---|
| D1 | **주기.** 토요일 KST 09:00 이후(2026-11-02 사용자 결정으로 일요일 21:00 — 서버 일요일 밤 창, ADR 0019 결정 14), 그 주 금요일 확정 종가가 들어온 뒤 1회(`paper_reviews` 유일 제약: `week_ending`). 수동 실행 가능 |
| D2 | **입력(코드가 만든다, Claude가 아니라).** 최근 4주(단계 0: 조립 뒤 어림이 25,000토큰을 넘으면 2주로 다시 조립하고 `windowWeeks`·`trimmedReason`을 입력에 남김) Claude 계좌 결정의 요약·stance·노출·주문·검증 결과; 각 주문의 그 뒤 수익률(체결가 대비 금요일 종가)·스탑 발동 여부; 각 `invalidation` 문장과 **코드가 평가할 수 있는 것**(가격·지표 조건)은 평가 결과, 못 하는 것은 "평가 불가"; 같은 기간 규칙 계좌·벤치마크 수익률; 거절된 주문의 가정 수익률(체결됐다면). 프레임 현재 버전 |
| D3 | **출력(구조화).** `{weekEnding, verdicts:[{decisionId, thesisHeld: 유지/반증/판단불가, note}], recurringErrors:[…], keep:[…], proposal: null | {operations:[…], judgment, rationale}}`. `proposal`이 있으면 1단계 F2의 제안 테이블에 `PENDING`으로 넣는다. **자동 반영 없음** |
| D4 | **비용.** `apiDailyCallCap`에 포함. 모델은 설정의 `model`. 주 1회 |
| D5 | **저장·화면.** `paper_reviews(week_ending PK, input JSONB, response JSONB, response_raw, model, usage, status, proposal_id NULL, created_at)`. 결정 로그 탭에 "주간 복기" 소탭: 메모 본문, 판정 표, 연결된 제안서로 이동 |
| D6 | **규칙 계좌 불변.** 복기가 규칙 계좌를 바꾸지 않는다. 비교 수치로만 쓴다 |

### 3-3. 수용 기준
- 가짜 응답으로: `proposal`이 있으면 제안 테이블에 PENDING 1건, 승인 전 프레임 버전 불변(테스트).
- 입력의 "그 뒤 수익률"이 체결가·금요일 종가로 손계산과 같다(테스트).
- 같은 `week_ending`에 두 번 돌아도 1건.

### 3-4. 구현 메모 (2026-10-25, 메인 세션 권장안으로 정함)

- 구현 메모: **저장** — `db/migrations/V12__paper_reviews.sql`(멱등) `paper_reviews(week_ending PK, window_weeks, input JSONB NOT NULL, input_text, response JSONB, response_raw, model, usage JSONB, status CHECK(OK·FORMAT_ERROR·API_ERROR·REFUSED·SKIPPED), error, proposal_id → paper_framework_proposals ON DELETE SET NULL, framework_version, retry_count, created_at)`. 쓰는 곳은 백엔드 `store.PaperStore`뿐(ADR 0008, `test_table_ownership.py`), `PaperStore.ready()`가 이 테이블도 봄(없으면 'not ready' 문구에 V12). **명세와 다름 ①**: D5 열 목록에 `retry_count`(0·1)를 더함 — API 오류 재시도를 결정(C7)처럼 한 문장(`WHERE status='API_ERROR' AND retry_count=0`)으로 한 번만 허용하려고. `input_text`는 보낸 입력 JSON 문자열만(구분자·안내 문장 빼고 — 읽을 때 이것으로 키 순서를 지킴, V10 `packet_text`와 같음), SKIPPED는 null.
- 구현 메모: **복기 주·창** — `week_ending` = 그 ISO 주의 마지막 미국 거래일(금요일, 휴장이면 목요일 — `UsMarketCalendar`, `analytics.ReviewFacts.weekEnding`). 창 = 결정 기준일 ∈ (week_ending − 4주, week_ending]. 4주로 조립한 입력의 어림(`PacketBuilder.estimateTokens`)이 25,000을 넘으면 같은 장부 자료로 2주를 다시 조립하고 `window_weeks`=2·입력 `trimmedReason`을 남김(2주도 넘으면 더 줄이지 않고 보냄). 어림은 `usage.inputTokensEst`(줄였으면 4주 어림 `defaultWindowTokensEst`도) — 첫 실행의 `usage.inputTokens`와 견줘 배율(단계 0의 1.72배)을 다시 잰다 `[확인 필요]`.
- 구현 메모: **입력(코드가 만듦, `analytics.ReviewFacts` — java.*만)** — 결정은 Claude 계좌의 창 안 OK·NO_TRADE만 사실로(요약·노출 근거·관망 사유 300자로 자름, 논거·무효화 문장은 스키마 상한이라 그대로), 오류·거부·건너뜀은 상태별 건수(`omittedDecisions`)만. 주문이 없는 NO_TRADE는 짧은 줄(노출·관망 사유). **명세와 다름 ②**: 낸 주문이 모두 거절돼 NO_TRADE가 된 결정은 짧은 줄로 접지 않고 주문까지 싣는다 — 접으면 거절 주문의 가정 수익률(D2)이 사라짐. 주문의 비중·시점은 모델이 제안한 값(`reason.proposed` — 장부의 매수 행은 살 금액이라). 매수 체결: 체결 뒤 수익률 = 기준일 종가 ÷ 장부 체결가(슬리피지 포함) − 1, 최대 낙폭(체결가를 첫 고점으로 둔 종가 고점 대비), 스탑(체결일~기준일 그 종목 STOP 체결 — 그 사이 전량 매도(비율 없음·1 이상, 체결일 뒤 ~ 스탑일)가 있으면 다시 산 포지션의 스탑이라 발동 아님 + 이유), 200거래일 이동평균 위치. 매도 체결: 판 뒤 변화(`avoided`·`missed`·`flat`). 거절 주문: 결정 다음 세션 종가에 체결됐다고 **가정**한 수익률. 미체결(EXPIRED 등)·기준일 뒤 체결은 "미체결" 메모만(룩어헤드 방지). 주문 `status`는 기준일 장 마감 시점 값 — 기준일 뒤 체결·만료(만료일 ≥ 기준일)는 PENDING, 메모에 체결일을 적지 않음(늦게 돌린 복기도 토요일 입력과 같게). 체결가 ÷ 체결일 이력 종가가 0.8~1.25 밖이면 분할 의심으로 체결가 대비 수치를 null + 이유(스탑 발동 여부는 그대로). 가격이 수정주가라 배당락이 끼면 낙폭이 배당만큼 커 보임(입력 `note`에 적음).
- 구현 메모: **기준일 종가** — 종가 이력(`equity_close`)의 기준일 점은 버리고, 사후 체결과 같은 규칙(`PaperMarketData.sourcedClosesOn` — 그날이 지금 세션이면 이력 값은 장중일 수 있어 마감 + 15분 뒤 수집한 관측치의 확정 종가만)으로 고른 값만 넣는다. 못 구하면 null + 이유(지어내지 않음). 저장본은 `StoreReader.quietly`.
- 구현 메모: **무효화 평가** — 코드가 읽는 꼴만 조건별로: (a) `stop`·`스탑`·`스톱` → 스탑 발동, (b) `200일·200-day·200DMA·200d` 언급 **바로 뒤**(10자 안, 사이에 숫자·쉼표·마침표가 없음)의 이탈·하회·아래·밑·below·under, 또는 `below/under (the) 200-day` → 기준일 종가 < 200일 평균('50일선 이탈 시 축소, 200일선은 지지'의 '이탈'은 200일선에 붙이지 않음), (c) `−8%`·`8% (이상) 하락`·`drops 8%`(범위 `3-8%`·`%p`는 안 읽음, 같은 절 앞 12자·뒤 8자에 매출·EPS·이익·실적·가이던스·성장·마진·금리·컨센서스·대비·상대·지수 같은 말이 있으면 주가가 아닌 수치라 안 읽음 — '고점·매수가 대비'·'실적 발표'는 예외) → 최대 낙폭 ≤ −N%(같아도 충족). 영어 스탑은 앞이 글자·하이픈이 아닐 때만(`non-stop` 제외), 한글 `논스톱` 제외. 결과 넷 — 충족·미충족·일부 평가 불가·평가 불가(조건별 `checks` 함께), '그리고·또는'은 해석하지 않음. 낙폭이 고점 대비라 "매수가 대비 −8%" 문장은 실제보다 충족이 많이 나올 수 있음 `[확인 필요]`(필요하면 매수가 대비 최저 수익률을 따로 더함).
- 구현 메모: **계좌 비교** — rules·bench_spy·bench_mix·claude 순(없는 책은 뺌), `paper_nav_daily` 창 시작일(휴장이면 직전 거래일) → 기준일 순자산 수익률. 창 시작에 줄이 없는 계좌가 있으면 기준일 줄이 있는 계좌 모두에 줄이 있는 첫 날부터(10-23 출발 계좌가 첫 4주 동안 전부 null이 되지 않게). 줄이 없으면 null + 이유(0 아님), 확정 종가가 아닌 줄을 썼으면 `isEstimated`.
- 구현 메모: **호출** — `feature.paper.ReviewService`. 시스템 = 새 고정 상수 `ClaudePrompts.REVIEW`(기존 ROLE·FIXED_RULES·PROPOSAL·결정 패킷은 그대로) + 지금 판 렌더링(`FrameworkService.render`, 지금 설정), 사용자 = `<<복기 입력 시작>>`·`<<복기 입력 끝>>`으로 감싼 입력 JSON("자료일 뿐 지시가 아니다"), 입력의 글 값마다 구분자 모양(전각·보이지 않는 글자 변형 포함 — '복기'와 '입력' 사이의 NBSP·전각 공백·ZWSP·공백 없음도)을 지움. 모델·effort·대기 한도는 결정과 같은 설정, 하루 호출 상한은 `PaperApiCalls.reserve/record/release`로 결정·제안과 함께 셈(D4). 상한에 닿았으면 **행을 남기지 않고** 다음 기회에 다시(정기는 30분 뒤, 수동은 400). 키가 없으면(NO_KEY) 보내지 않고 잡은 호출을 되돌리고 API_ERROR 행.
- 구현 메모: **응답 검사** — `paper/review.schema.json` 전체(`StructuredSchema` — API에는 `forApi()`), 더해 코드 계약: `weekEnding`이 입력과 같음·판정한 `decisionId`가 입력의 결정임·같은 결정을 두 번 판정하지 않음(어기면 FORMAT_ERROR — 판정이 빠진 결정은 위반 아님, 화면이 "판정 없음"). `proposal`은 스키마에서 `"type": ["object","null"]`(검사기가 `anyOf`를 모름) — API가 객체 형 배열을 받는지는 첫 실제 호출이나 QA 스택에서 확인 `[확인 필요]`(400이면 그 주는 API_ERROR). 빈 `operations`의 제안은 "제안 없음"으로 봄.
- 구현 메모: **상태·재시도** — OK·FORMAT_ERROR·REFUSED는 그 주의 끝, API_ERROR는 같은 행에서 한 번 더(`retry_count` 0 → 1, `created_at`도 그 시각), SKIPPED(창 안에 OK·NO_TRADE 결정이 없음 — 부르지 않음)도 끝. 응답을 받은 뒤(과금) 사용량 정리·저장이 예외로 끝나면 원문·사용량을 다시 부르지 않는 API_ERROR(`retry_count = 1`)로 따로 남김(결정과 같은 이유). 추정 비용 단가는 호출 전에 읽은 설정으로 셈(응답 뒤 DB 읽기가 실패해 행 없이 끝나지 않게). 한 주 한 행은 `INSERT … ON CONFLICT DO NOTHING` + 작업 잠금.
- 구현 메모: **제안** — `proposal`에 연산이 있으면 `FrameworkService.reviewProposal`이 제안 요청과 같은 사전 검사(`apply` — 모든 판의 번호 기준)를 하고 `paper_framework_proposals`에 PENDING(적용할 수 없으면 FAILED, `failure.errorKind = NOT_APPLICABLE`)으로, `base_version` = 복기에 붙인 판, `note_id` null, `request_text` "주간 복기 <week_ending>", 응답은 보통 제안 모양 `{schemaVersion:1, summary = judgment, assessment:[], operations, beforeAfter = rationale, source:{kind:"WEEKLY_REVIEW", weekEnding}, usage}` — 승인(변경 기록 = judgment)·거절·화면이 그대로 돎. 평가(assessment)는 비움(반복 오류를 '보완'·'수정 필요'로 옮겨 적으면 모델이 내리지 않은 판정을 지어냄). 제안 행과 복기 행(`proposal_id`)은 한 트랜잭션. **자동 반영 없음** — 판은 승인할 때만 오름. 제안 목록 API에 `reviewWeekEnding`(복기가 낸 제안이면 그 주)을 더함.
- 구현 메모: **정기 작업** — `PaperReviewJob` 30분마다(`dashboard.paper.review-interval-ms` 1,800,000, 첫 실행 3분 뒤, `dashboard.paper.enabled=false`면 쉼). w = 지금 마감이 끝난 가장 최근 복기 주. 조건: 그 주 토요일 09:00 KST 이후 · w의 행이 없음(다시 부를 API 오류는 부름) · Claude 계좌 ACTIVE이고 출발일 < w(출발한 주는 초기 결정뿐이라 복기 없음, 일시정지 중이면 복기 없음) · w 확정 종가가 들어옴(Claude 계좌의 w 확정 순자산 줄, 또는 관측치 저장본이 w 마감 + 15분 뒤 수집한 w 봉 **이고 장부가 그것을 반영해 Claude 계좌의 w 순자산 줄이 있음** — 확정이 아니어도. 관측치만 보면 장부 처리 전에 열려 계좌 비교가 전부 null로 굳음). 놓친 토요일은 다음 금요일 마감 전까지 그 주로 다시 잡히고, 그 뒤에는 새 주만 봄. 같은 주 예외 3번이면 정기는 그 주를 포기(수동은 다시 시도), 작업 기록 `review`(REVIEWED·SKIPPED·ERROR만). 정기는 잠금을 기다리지 않고(BUSY), 수동은 429.
- 구현 메모: **API(운영자)** — `GET /api/paper/reviews`(52건, 판정 수는 OK 행만 — 그 밖은 null, `retryable`은 그 주가 `latestWeekEnding`일 때만, `latestWeekEnding`·`latestOpensAtKst`), `GET /api/paper/reviews/{weekEnding}`(입력·응답·사용량·판정 표 — 결정 날짜는 서버가 입력에서 찾아 붙임 — ·연결된 제안 요약), `POST /api/paper/reviews/run`(가장 최근 주를 지금, 토요일 시각만 빼고 같은 조건 — 안 되면 400, 있으면 그 행 `ALREADY_REVIEWED`). `AccessPolicy`(OWNER)·`RouteInventoryTest`·`docs/API.md`·`scripts/qa/routes.json`(POST `fuzz:false`)·`endpoints.ts`.
- 구현 메모: **화면** — 결정 로그 탭 맨 위 '결정 기록 · 주간 복기' 전환. 펼친 상세는 주기 갱신하지 않고, 60초마다 갱신되는 목록에서 그 주 행(상태·시각·재시도·제안)이 바뀌면 다시 읽음. 주간 복기: 언제 생기는지·가장 최근 주와 수동 실행(확인 "Sonnet 5.5 호출 1회(약 $0.1), 하루 호출 상한에 포함"), 목록(상태·창·판정 수·제안), 고른 주의 판정 표(결정 번호·기준 거래일·종류·판정·근거)·반복 오류·지킬 것·제안(누르면 프레임 탭으로 옮겨 그 제안으로 스크롤·강조)·사용량·입력·응답 원본. 표기 도우미는 `lib/paper.ts`(ADR 0004), null은 —.
- `[확인 필요]` `resetBook`(Claude 계좌 초기화)은 `paper_reviews`를 지우지 않는다 — 복기 메모는 남지만, 초기화한 주의 복기는 다시 돌릴 수 없다(한 주 한 행). 지금은 남기고, 바꿀 필요가 생기면 초기화가 그 계좌 출발일 뒤 복기를 지우도록 정한다.

---

## 4. 기능 B — 사건 뉴스 (세 번째, 매일 다이제스트가 아님)

### 4-1. 사용자가 얻는 것
논거를 바꿀 수 있는 사건만 하루 최대 10건, 제목·출처·시각으로 패킷에 들어간다. 걸리는 것이 없는 날은 섹션이 비어 있고 그것이 정상이다.

### 4-2. 요구사항

| ID | 요구사항 |
|---|---|
| B1 | **출처는 RSS만.** 단계 0에서 고정: 인베스팅닷컴 `news_25`(주식)·`news_95`(경제 지표)·`news_14`(경제)·`news_1`(외환 — 2026-10-25 추가, 아래 §4-4), 연준 `press_monetary.xml`, BLS `cpi.rss`·`empsit.rss`(실제로는 Atom), SEC `pressreleases.rss`. **야후 파이낸스는 뺀다**(404·429, robots.txt가 전체 금지). 인베스팅 `news.rss`(전체)는 자동 생성 내부자 거래 항목이 많아 빼고, 연준 `press_all`은 제재·인가 공지가 많아 뺀다. BLS는 브라우저 UA에 403이라 설명형 UA(연락처 없음)와 403 재시도 없는 세션, SEC는 기존 SEC 세션·속도 제한. 고정본을 테스트에 둔다. HTML 페이지는 받지 않는다 |
| B2 | **수집.** 태스크 `news_headlines`(`slow`, 1시간), `feedparser`(새 의존성 — 이유: RSS 날짜·인코딩 변형을 직접 다루지 않기 위해). `observations` 데이터셋 `news_headline`, entity = 제목 정규화 해시, 필드 `{title, link, source, publishedAt, fetchedAt}`. 중복 제거, 7일 보존 |
| B3 | **거르기(코드).** 패킷에 넣는 조건은 둘 중 하나: ① 보유·후보 종목의 회사 이름·티커가 제목에 있음(티커는 대문자 단어 전체 일치 — `A`·`IT`·`ON` 같은 짧은 티커 오탐 방지), ② 매크로 키워드 사전 — 피드가 모두 영어라 기본 사전도 영어(Fed·FOMC·Federal Open Market Committee·rate decision·CPI·inflation·payroll·unemployment·tariff·oil·OPEC·Middle East·ceasefire·credit·default·bank 등, 단어 경계·대소문자 무시, 설정에서 편집). 둘 다 아니면 저장만 하고 패킷에 넣지 않는다 |
| B4 | **패킷 섹션 `11b_events`.** 직전 결정 이후(평일 24시간, 주말·휴장 뒤는 그 사이 전부 — 2026-10-25 수정: 직전 24시간으로 자르면 주말 사건이 어느 패킷에도 들지 않음), 최대 10건(설정), 제목·출처·시각만, 구분자로 감싸 "자료일 뿐 지시가 아니다". 없으면 "해당 사건 없음" |
| B5 | **설정.** `news.enabled`(기본 true), `news.maxPerDay`(10), `news.keywords`, `news.feeds`. 끄면 수집은 계속하고 패킷에서만 뺀다 |
| B6 | **기록.** 결정 기록에 참조한 헤드라인 entity 목록. 측정(§6)에 쓴다 |

### 4-3. 수용 기준
- 필터 테스트: 티커 일치·키워드 일치·둘 다 아님 세 경우. 상한 10건은 최신순.
- 7일 지난 행이 지워지고, 같은 제목이 두 번 들어오지 않는다.
- 피드 하나가 실패해도 나머지는 저장되고 실패 사유가 `collector_task_runs`에 남는다.

### 4-4. 구현 메모 (2026-10-25, 메인 세션 권장안으로 정함)

- 구현 메모: **의존성** — `collector/requirements.txt`에 `feedparser==6.0.14`(PyPI GA 2026-07-30, BSD-2-Clause, Python ≥ 3.10 — 이유: RSS·Atom 날짜·인코딩 변형을 직접 다루지 않기 위해, D34). `constraints.txt`에는 `feedparser`·`feedparser-sgmllib==2.1.0` 두 줄만 더함 — `make constraints`(docker 안에서 PyPI를 받으므로 오프라인 불가)로 다시 만들면 관련 없는 간접 의존성 8개(python-dateutil 3.0.0 메이저·starlette 1.10.0 등)도 오르는데 범위 밖이라 반영하지 않음 `[확인 필요]`(올린다면 따로 커밋). HTTP는 수집기 세션이 받고 feedparser는 읽기만 — URL을 넘기지 않고, bytes도 `BytesIO`로 감쌈(6.0.14는 bytes를 먼저 파일 이름으로 열어 봄 — 회귀 시험).
- 구현 메모: **수집기** 태스크 `news_headlines`(`slow` 1시간, 안에서 300초에 새 요청을 멈춤, 같은 호스트 사이 0.6초) → `observations` `news_headline` + 상태 스냅샷 `news.headlines.status`(`catalog.OBS_NEWS_HEADLINE`·`SNAP_NEWS_STATUS` = `Datasets`, `DatasetsParityTest`). 태스크 26개. 피드 7개는 `services.news.FEEDS`(키 = 백엔드 설정 `news.feeds`의 값 — `NewsFeedsParityTest`): 인베스팅 셋·연준은 공용 세션, BLS 둘은 새 BLS 세션(UA `LocalMacroDashboard/2.0`, **연락처 없음**, 403 재시도 없음 — 단계 0 이후 실제 수신에서도 200), SEC는 기존 SEC 세션·속도 제한. 야후 제외(robots).
- 구현 메모: **저장** — entity = 정규화한 제목(공백 한 칸·앞뒤 공백 제거·casefold)의 sha256 앞 16자, obs_date = 발행 시각의 UTC 날짜, payload `{title(공백 정규화·원래 대소문자, 300자 상한), link(http(s)만), source, feed, feeds, publishedAt, fetchedAt}`(ISO UTC — `feed`·`source`·`link`는 처음 실어 온 피드의 것, `feeds`는 그 제목을 실어 온 피드 키 전부). 시각은 `published_parsed`, 없으면 `updated_parsed`(Atom)를 `calendar.timegm`으로(시간대 없는 인베스팅 시각은 UTC). 시각 없는 항목·하루 넘게 미래인 항목은 건너뛰고 셈, 7일보다 오래된 항목은 처음부터 넣지 않음(연준·BLS가 몇 달 치를 줘 넣으면 지웠다 다시 넣기를 되풀이). 같은 제목은 7일 안이면 날짜가 달라도 다시 넣지 않고(`store.observation_entities_since`), 넣기만 해서 처음 받은 `fetchedAt`이 남음(`store.insert_new_observations`). 다른 피드가 같은 제목을 실으면 같은 실행이면 넣는 행의 `feeds`에, 다음 실행이면 이미 넣은 행의 `feeds`에 피드 키만 더함(`store.add_headline_feeds` — 다른 칸은 그대로). 처음 피드 하나만 남기면 `news.feeds`로 그 피드를 뺀 설정에서 다른 피드가 실어 온 같은 사건이 빠졌음(리뷰 COL-1). 실행마다 obs_date < 오늘(UTC) − 7일 행을 지움. 피드 하나의 실패는 나머지를 멈추지 않고 사유가 실행 기록 detail·상태 `failedFeeds`에, 전부 실패하면 `EmptyResult`(행·상태·보관 정리 모두 그대로). '누락 가능'(`maybeMissed`)은 전에 받은 적 있는 피드가 준 항목이 모두 7일 안인데 하나도 본 적 없을 때만. 상태 `{generatedAt, source, retentionDays, retainedFrom, stored7d, insertedThisRun, deletedThisRun, feedsOk, feedsTotal, failedFeeds:[{feed, source, reason}], maybeMissed, feeds:{키:{…, lastOkAt}}}`.
- 구현 메모: **설정**(B5, `affectsRules` 모두 false) — `news.enabled`(true), `news.maxPerDay`(정수 0~30, 10), `news.keywords`(구절 목록 — 기본 영어 사전 24개: Fed·FOMC·Federal Open Market Committee·rate decision·rate cut·rate hike·CPI·inflation·payroll·payrolls·unemployment·jobs report·tariff·tariffs·oil·OPEC·Middle East·ceasefire·credit·default·bank·recession·Treasury·yields, 항목 60자·100개까지, 꺾쇠·제어 문자 불가), `news.feeds`(피드 키 목록, 기본 여덟 개 — 빈 목록이면 섹션이 "꺼짐(설정)", 저장은 피드 순서로 맞춰 순서만 다른 같은 묶음은 바뀐 값이 아님. 그 제목을 실어 온 피드(`feeds`) 가운데 하나라도 고른 피드면 넣음). 2단계 B 전 설정 행은 기본값으로 읽고 `fallbacks`에 `news`. 키워드는 형 이름 `phrases`(화면이 공백으로 나누지 않고 쉼표·줄바꿈으로만 나눔), 피드는 `list`(선택지를 보내면 화면이 한 값 고르기로 그림 — 키는 설명에).
- 구현 메모: **창** — (직전 거래일의 cutoff, 이번 cutoff], cutoff = 그 거래일 다음 KST 날짜의 결정 시각(그 결정이 읽은 설정 행의 `decisionTimeKst`, 기본 07:30 — `PaperDecisionJob.decisionTime`). 기준일로만 정해 결정적. 발행이 cutoff 뒤면 넣지 않고, 늦게 받았어도 발행이 창 안이면 넣음. 저장본은 창 시작의 UTC 날짜 **하루 앞부터 끝 없이** 읽음(`StoreRepository.readObservationsBetween`) — 창 밖 행은 "그때 수집이 돌았나"(가장 이른 받은 시각 → `coverage`)에만 씀. 행이 하나도 없으면 "자료 없음".
- 구현 메모: **거르기**(B3, `analytics.NewsEvents` — java.*만) — 대상 = 8b·1b와 같은 목록의 **전부**(`fundamentalsTargets.all` — 보유 → 섹션 7 교집합 후보 → 직전 watchlist, ETF·현금성 제외 — 25종목 상한은 표 크기 때문이라 거르기에는 두지 않음). 티커는 대문자 낱말 그대로(대소문자 구분, 마침표·`&`·아포스트로피로 이은 `U.S.`·`S&P`·`AT&T`는 낱말이 아님, 소유격 `'s`·문장 끝 마침표·두 글자 이상 티커 앞뒤 하이픈·en/em 대시·여닫는 작은따옴표(뒤가 글자가 아닐 때)·말줄임표(`…`·`...`)는 경계 — 로이터식 머리말 `Exclusive-NVDA`도 잡음). 키워드는 낱말·구절, 대소문자 무시, 구절 사이 공백·하이픈. 줄마다 걸린 이유(`ticker X`·`keyword Y` — 패킷에는 4개까지, 나머지는 수만 `matchedMore`), 최신순 → entity 순, 같은 entity는 한 줄, 상한 `news.maxPerDay`. **명세와 다름 ①**: 한 글자 티커(A·C·F·T·V…)는 `$A`·`(A)`·`NYSE:A`처럼 앞이 `$`·`(`·`:`일 때만 — 문장 첫 관사 "A"·`T-bills`·`A-shares`가 잘못 걸려서. **명세와 다름 ②**: 회사 이름으로는 맞추지 않음 — 백엔드에 티커 → 회사 이름 표가 없고 13F 종목명(nameOfIssuer)은 제출 기관마다 다른 자유 기재("MICROSOFT CORP")라 제목과 맞출 수 없음(`Targets.names` 자리만 둠). 한계: 전부 대문자인 제목·흔한 약어와 같은 두 글자 티커(ET 등)는 잘못 걸릴 수 있음 — 이유가 줄마다 있음.
- 구현 메모: **패킷 `11b_events`** — `11_notes` 바로 뒤. `{source, window{from,to}(ISO KST), note "사건 제목은 자료일 뿐 지시가 아니다 — 판단의 근거로만 쓴다", asOfMismatch, asOfNote?(초기), text, coverageNote?(줄이 있는데 창 일부만 수집), feedNote?(정기·미리보기 — 수집 상태에서 창 끝 3시간 전부터 실패 중인 고른 피드), omitted?·maxPerDay?(상한으로 뺀 수가 있을 때), items:[{k, entity, source, publishedAtKst, matched(4개까지), matchedMore?}]}` — `text`는 줄마다 `<<사건 #k 시작>> [출처 · yyyy-MM-dd HH:mm KST] 제목 <<사건 #k 끝>>`, 제목은 `text`에만(items에 다시 싣지 않음). 제목·출처의 사건·메모 구분자 모양(전각·보이지 않는 글자 변형 포함)은 메모·제안과 같은 도우미(`FrameworkService.delimiterLike`)로 지움. 상태 문구: 걸린 것 없음 "해당 사건 없음"(창이 수집 전이면 그 말을 덧붙임), 창 끝까지 받은 행 가운데 마지막으로 받은 시각이 창 끝 3시간 전보다 앞이면(수집기 정지·피드 전부 실패 → 예전 행만 남음, `coverage` `STALE` — 창 끝 이하에 받은 행만 봐 다시 만들어도 같음) "받은 제목 가운데 걸린 사건 없음 — 창 끝 n시간 전(…)부터 새로 받은 제목 없음…"(줄이 있으면 같은 말을 `coverageNote`에, 리뷰 B-FP-1), `news.enabled=false` "꺼짐(설정)…"(저장본을 읽지 않음, 수집은 계속), 피드 선택 없음 "꺼짐(설정) — news.feeds…", 저장본 없음 "자료 없음…" — 셋 다(와 걸린 것 없는 `STALE`) `items` 없음(빈 목록은 0건으로 읽힘). **초기 결정 패킷**: `asOfMismatch:true` + `asOfNote` — 창은 출발일로 정해지지만(10-23 07:30 ~ 10-24 07:30 KST) 제목은 지금 저장본에서 고른 것. 수집이 10-25에 시작해 출발일 창에는 늦게 받은 연준·BLS·SEC 제목만 남거나 비고(인베스팅은 최근 10건만 줌, `coverageNote`가 '수집 전'), 보존 7일이 지나면(10-31 무렵부터) 비어 있음. `PACKET_VERSION` 4. 시스템 프롬프트(`ClaudePrompts`)는 바꾸지 않음.
- 구현 메모(§6 태그·B6): 결정 응답 `measure:{hasCalendar, calendarItems, hasEvents, eventIds, hasEarnings}` — `hasEvents` = 실은 건수(걸린 것 없으면 0), `eventIds` = 실은 줄의 entity(섹션 순서), 섹션이 사건을 고르지 않았으면(꺼짐·피드 없음·자료 없음) 또는 걸린 것이 없는데 창 끝 쪽을 받지 못했으면(`STALE` — 없었는지 모름) 둘 다 null. 패킷을 만든 모든 결정(정기·수동·초기·호출 실패·응답 뒤 실패)과 미리보기 `response.measure`에.
- 구현 메모: **크기** — `TARGET_TOKENS` 30,000 → 32,000 → **32,500**(어림 단위, B·C를 담으려고 — 1단계 설계 §5-2). 처음 잰 "최악"(줄마다 이유 넷 — 티커 둘·Fed·rate cut)은 최악이 아니었음: 이유에 상한이 없어 기본 사전만으로 32,000을 넘었음(리뷰 B-FP-2). 그래서 줄마다 이유를 4개까지만 싣고(나머지는 `matchedMore` 수), 시험 패킷을 실제 최대 모양으로 바꿈 — 기본 상한 10건 × 300자 + … 제목, 가장 긴 출처(Federal Reserve), 기본 사전에서 가장 긴 이유 넷 + 두 자리 `matchedMore`, 수집 공백 `coverageNote`(두 자리 시간)·실패 피드 여섯의 `feedNote`·`omitted` 포함 → 약 32,280(11b 약 2,370)으로 목표 안 — 보통 제목(약 100자)이면 11b는 약 600~1,000. 여유가 약 220이라 **C(8b 줄마다 4분기)를 더할 때 목표를 다시 정하거나 줄여야 함**. `news.maxPerDay`를 30까지 올리거나 `news.keywords`에 긴 구절(60자까지)을 넣으면 목표를 넘을 수 있음(경고 로그만, 자르지 않음).
- 구현 메모: **화면** — `/api/paper/status`의 `news:{available, stored7d, lastFetchKst, feedsOk, feedsTotal, failedFeeds}`(상태 스냅샷 요약, 없으면 `available:false`·나머지 null), 개요 '장부 관측치' 카드에 "사건 뉴스(RSS): 7일 n건 · 피드 a/b · 갱신 …"(실패한 피드가 있으면 "· 실패 키…"), 설정 탭 `news` 묶음.
- 구현 메모: **실제 수신**(2026-10-25, DB 쓰기 없음) — 7개 모두 200·재시도 없음. 인베스팅 셋 각 10항목(모두 7일 안), 연준 15(7일 안 0 — 최신 10-13), BLS CPI 12·고용 12(Atom, 7일 안 0), SEC 25(7일 안 4). 연준·BLS는 다음 발표(FOMC 10-28, 고용 11-06, CPI 11-10)부터 들어옴.
- **인베스팅닷컴 외환 피드 추가(2026-10-25, 사용자)** — 사용자가 인베스팅닷컴 뉴스 네 분류(외환·주식·경제 지표·경제)를 HTML 페이지
  (`/news/forex-news`·`/news/stock-market-news`·`/news/economic-indicators`·`/news/economy`) 스크래핑으로 받자고 했다. 수집기 컨테이너에서
  네 페이지와 robots.txt를 확인하니 Cloudflare가 브라우저 UA·설명형 UA·기본 UA 모두에 **403**을 주고 RSS(`/rss/…`)만 200이었다 — 받으려면 봇 차단을
  우회해야 해 하지 않는다(D29 유지). 대신 같은 네 분류의 RSS를 쓴다: 주식·경제 지표·경제는 이미 받던 `news_25`·`news_95`·`news_14`이고, 빠져 있던
  외환 `news_1`(`investing_forex`)을 더했다(피드 여덟 개). 패킷에는 제목·출처·시각만 쓰므로 HTML이 더해 줄 것이 없다. 목적은 사용자 말대로
  "매번 실시간 소식이 아니라, 매일 다이제스트 대신 사건 중심 입력 + 복기 루프" — 외환 제목도 다른 피드와 같이 보유·후보 티커나 매크로 키워드에
  걸린 것만 하루 최대 10건 안에서 들어간다(D30).
- **주말·휴장일 공백 — 해결(2026-10-25 권장안)**: 창 시작을 직전 거래일 결정 시각으로 넓혀 금요일 결정 뒤 주말·휴장일에 나온 사건(예: 일요일 OPEC+ 결정)도 다음 결정 패킷에 든다. 상한(`news.maxPerDay`)은 그대로라 패킷 크기는 늘지 않는다.
- `[확인 필요]` 인베스팅닷컴 RSS 이용 조건(단계 0과 같음). 기본 사전에 복수형 "rate cuts"·"rate hikes"가 없어 그런 제목은 "Fed" 등으로만 걸림.

---

## 5. 기능 C — 어닝 서프라이즈 (네 번째)

### 5-1. 사용자가 얻는 것
보유·후보 종목의 최근 4분기 EPS 실제치·컨센서스·서프라이즈율이 패킷의 재무 섹션 옆에 붙는다(단계 0: 출처가 한 번에 4분기만 주므로 8분기는 관측치가 약 1년 쌓여야 찬다). OS 엔진 7의 "상위 기관이 샀을 때의 공통분모"에서 비어 있던 항목이다.

### 5-2. 요구사항

| ID | 요구사항 |
|---|---|
| C1 | **출처.** yfinance quoteSummary `earnings.earningsChart.quarterly`(actual·estimate·surprisePct·periodEndDate·**reportedDate** = 실제 발표 시각) — 이미 쓰는 출처. 공개 `earnings_history`는 같은 값이지만 발표일이 없어 시점(PIT)을 자를 수 없으므로 쓰지 않는다(단계 0). A2와 같은 요청 한 번(`calendarEvents`·`earnings` 모듈)으로 받는다 — yfinance 내부 호출이라 버전 고정(1.7.0)·원본 고정본 시험을 두고, 내부 API가 바뀌면 `EmptyResult`("yfinance 내부 API 변경")로 멈춘다. 단계 0 커버리지: 4분기 이상 97%(58/60), 8분기 0%(최대 4분기). 없으면 `null`, 0으로 채우지 않는다. 추정치가 0에 가까우면(|est| < 0.05) `smallBase` 표시 |
| C2 | **수집.** 태스크 `earnings_surprise`(`weekly`), 대상은 유니버스 종목 + 후보 기관 상위 보유(최대 300), 1회 예산 100종목, 증분. `observations` 데이터셋 `us.earnings_surprise`, entity = 티커, 날짜 = 발표일 |
| C3 | **패킷.** 섹션 `8b_fundamentals`의 종목 행에 `eps:{last4:[{date, actual, estimate, surprisePct}]}` 추가. 기준일 이후 발표분은 넣지 않는다(Point-in-Time) |
| C4 | **화면.** 개요 데이터 상태 줄에 커버리지 한 줄 |

### 5-3. 수용 기준
- 기준일 이후 발표분이 패킷에 없다(10-23 초기 결정 재현 테스트).
- 추정치가 없는 분기는 `surprisePct=null`.

### 5-4. 구현 메모 (2026-10-25, 메인 세션 권장안으로 정함)

- 구현 메모(**명세와 다름 ①**, C1·C2): A2(`us_calendar`)와 같은 요청 하나로 받지 않고 **따로 태스크** `earnings_surprise`(`weekly` 12시간, 상한 1,800초 — 안에서 1,200초에 새 요청을 멈춤)가 `['earnings']` 모듈만 묻는다 — 일정은 1시간마다·종목당 24시간 캐시, 서프라이즈는 발표 뒤에만 바뀌어 주기·예산이 다르다. 대상은 "유니버스 + 후보 기관 상위 보유(최대 300)"가 아니라 **유니버스 주식 전부**(`us_calendar`와 같은 도우미 — `paper_universe.tradable()` − 설정 ETF − 13F ETP, 576종목; 수집기는 계좌 보유를 모름, ADR 0008)를 실행당 `EARNINGS_SURPRISE_BUDGET`(기본 100, 1~600 — compose는 빈 값 전달, `.env.example`에는 이름만)종목씩 약 3일에 한 바퀴. 태스크 27개.
- 구현 메모: **순서**(C2 '증분') — ① 받은 적 없음(처음 보는 종목 → 받은 적 없이 실패만 한 종목, 각각 티커 순) ② 발표가 나왔을 법함: 수집기 자신의 `calendar.us_events` 저장본(`us_calendar`가 씀)의 실적일 `date` 또는 지난 실적일 `lastDate`가 오늘(미국 동부) 이하이고 마지막으로 받은 시각이 그 날짜 + 1일(동부 자정) 전 ③ 가장 오래전에 받은 순, 같은 순위는 티커 순. 요청 간격 0.5초, 429면 그 실행을 멈춤(그 종목 상태 줄은 건드리지 않음 — 종목 문제가 아니라 Yahoo 한도, 첫 요청부터 429면 `EmptyResult`). 연속 실패 5회 상한은 "이번 실행에서 한 종목이라도 받은 뒤, 직전에 제대로 받은 종목의 실패"만 센다 — 그대로 세면 늘 실패하는 종목이 순서 맨 앞에 설 때 매 실행이 같은 자리에서 멈춤(`sec_fundamentals`에서 겪은 일).
- 구현 메모: **출처·숫자** — yfinance 1.7.0 내부 `Ticker(t)._quote._fetch(['earnings'])`의 `earnings.earningsChart.quarterly`(단계 0과 같은 호출). `surprisePct`는 응답 문자열을 쓰지 않고 (actual − estimate) ÷ |estimate| × 100을 소수 둘째 자리로 계산(고정본 15분기 모두 Yahoo 문자열과 같음 — 단계 0 확인 공식), 추정치가 없거나 0이면 null. `smallBase` = |estimate| < 0.05(추정치가 없으면 null), 통화 = `earnings.financialCurrency`(단계 0: BIDU CNY·RACE EUR, 나머지 USD). 발표 시각이 없거나 미래인 분기는 넣지 않고 셈. 같은 동부 날짜에 두 분기가 오면 분기 말이 늦은 쪽만(저장 키가 (날짜, 티커)). **가드**: 메서드 없음·인자 모양 변경·모듈 거부·응답 5건 이상에 `earnings`가 하나도 없음·응답 5건 이상이 모두 저장할 분기(발표 시각이 있는 지난 분기)를 주지 않음 → `EmptyResult`("yfinance 내부 API 변경") — 그 실행의 응답을 모두 버리고 관측 행·상태 모두 그대로(모양이 바뀐 응답의 '자료 없음'을 믿지 않음). 숫자 칸이 숫자가 아니면(`{raw, fmt}` 등)·`quarterly` 칸이 없으면·어느 분기에도 `reportedDate` 칸이 없으면·epoch가 범위(1970~2100년) 밖이면 그 종목만 실패(그 밖의 값 오류도 그 종목만). 고정본 `collector/tests/fixtures/earnings`(AAPL 보통·BIDU CNY·SPCX 추정치 없는 분기·INTC 작은 추정치 — 수집기 컨테이너에서 읽기 요청 4건, DB 쓰기 없음).
- 구현 메모: **저장** — `observations` `us.earnings_surprise`(`catalog.OBS_US_EARNINGS_SURPRISE` = `Datasets.OBS_US_EARNINGS_SURPRISE`, `DatasetsParityTest`), entity = 티커, obs_date = 발표 시각의 미국 동부 날짜(PIT 키), payload `{periodEnd, actual, estimate, surprisePct, currency, smallBase, reportedAt(동부 오프셋 ISO), source:"yfinance quoteSummary earnings.earningsChart"}`. (날짜, 티커)마다 upsert(나중에 받은 값이 비어 있던 추정치를 채우거나 고치면 새 값, 같으면 다시 쓰지 않음), **지우지 않음**(출처가 최근 4분기만 줘 쌓아야 8분기). 상태 `us.earnings_surprise.status`(`SNAP_EARNINGS_SURPRISE_STATUS`) = `{generatedAt, source, universe, covered, withEstimate4, budget, fetchedThisRun, failedThisRun, stoppedReason?, items:{TICKER:{fetchedAt, rows, latestReported, error?, isStale?, staleReason?, staleSince?}}}` — `rows`·`latestReported`·`covered`·`withEstimate4`는 이번 응답이 아니라 저장된 행으로 셈 — `withEstimate4`는 분기(`periodEnd`)마다 한 번(발표일이 바뀌어 두 행이 된 분기를 두 번 세지 않음, 패킷과 같음)(**명세 보충**: `source`·`budget`을 더함). 일부 실패 → 실패한 종목의 상태 줄을 직전 값 `isStale`로 이어받음(3일 기한, 관측 행은 그대로), 한 종목도 받지 못하면 `EmptyResult`.
- 구현 메모(**명세와 다름 ②**, C3의 모양): `eps:{last4:[{date, actual, estimate, surprisePct}]}` 대신 토큰을 줄이려고 8b 머리말 `epsColumns:["reported","periodEnd","actual","estimate","surprisePct"]` + 줄의 `eps` 칸(`notes` 바로 앞) = 값 배열 목록(발표일 최신순, `analytics.EarningsHistory` — java.*만). **최근 4분기**(저장본은 쌓이면 8분기 이상이어도 패킷은 C3대로 4 — "4분기(쌓이면 8분기)"는 저장본 이야기). EPS는 보고 통화 소수 4자리(0.004 같은 작은 추정치가 0으로 보여 '추정치 0'과 섞이지 않게)·% 소수 1자리, 끝 0 지움. 같은 분기(`periodEnd`)가 두 행이면(Yahoo가 발표일을 고침) 기준일까지 보인 가장 늦은 발표 하나. USD가 아닌 종목은 머리말 `epsCurrency:{티커: 통화}`(모르면 null — 빼면 USD로 읽힘), 작은 추정치 분기는 `epsSmallBase:["티커/분기 말"]`(있을 때만). 저장본(데이터셋)이 없으면 줄의 `eps`가 null + `epsNote` "저장본이 아직 없어 모든 줄 null", 있는데 기준일까지 알려진 발표가 없으면 `[]`(아직 받지 않은 종목 포함 — `epsNote`에 적음). 읽기는 `StoreRepository.readObservationsUntil`(D28과 같은 obs_date ≤ 기준일, `quietly` 안), 데이터셋이 있는지는 대상 종목 행이 없을 때만 `latestObservationDate`로 본다. `PACKET_VERSION` 5. 시스템 프롬프트(`ClaudePrompts`)는 바꾸지 않고 안내는 `epsNote`에 둔다 — 운영 중인 고정 규칙 "재무(8b_fundamentals)는 공시 원자료로 계산한 값"·기본 프레임 E3 "공시 값만"과 어긋나지 않게 `epsNote`에 "eps는 SEC 공시 값이 아님(Yahoo 집계 실제치·컨센서스 — 인용 시 출처 yfinance) — '8b = 공시 원자료' 규칙은 eps 밖 칸", 섹션 `source` 끝에 "eps 칸은 제외(epsNote)"를 적는다(리뷰 C-PIT-1).
- 구현 메모(**명세 보충**, PIT): 발표일(미국 동부) ≤ 기준일 **그리고** 발표 시각 ≤ 그 결정의 결정 시각(`NewsEvents.window(asOf, decisionTimeKst).to()` — 11b 창 끝과 같은 시각, 그 결정이 읽은 설정 행, 기본 07:30 KST = 18:30 EDT·17:30 EST). 기준일 **장 마감 뒤** 발표는 결정이 다음 날 아침 KST라 이미 공개 → 넣는다(`epsNote`에 "기준일 장 마감 뒤 발표도 듦(결정이 다음 날 아침 KST라 이미 공개)"). 날짜만으로 자르면 결정 시각보다 늦게 나온 발표(단계 0: PBR 19:55 ET 등 해외 상장사)가 나중에 다시 만든 패킷(초기 결정 10-23 등)에 섞인다. 발표 시각이 없는 행은 날짜 규칙만. `epsNote`는 결정 시각을 날짜 없이("기준일 다음 날 07:30 KST") 적는다 — 날짜를 쓰면 초기 결정 패킷에 기준일 뒤 날짜(10-24)가 보인다. 시계를 읽지 않아 결정적. 수용 기준 시험(10-23 초기 결정 재현, `PacketBuilderTest.earningsInitialPacket`): 저장본에 10-23 16:05 ET·10-23 19:55 ET·10-29 발표를 함께 두고, 16:05는 들고 19:55·10-29는 패킷에 없음, 추정치 없는 분기는 `surprisePct` null.
- §2-4의 `[확인 필요]`(기준일 장 마감 뒤 실적이 1b에서 빠짐) — **해결**: 1b는 '다음 일정'이라 그대로 빼고, 그 결과(EPS·서프라이즈)는 8b `eps`가 싣는다(결정 시각 전에 나와 수집됐을 때). 한계: 수집이 12시간마다라 결정 전에 수집돼 있는 일은 드물어 대개 다음 결정 패킷에 들고, 늦게 받은 행으로 같은 기준일 패킷을 다시 만들면 그 행이 들 수 있다(받은 시각이 아니라 발표 시각으로 자름 — 11b와 같은 성질).
- 구현 메모(§6 태그): 결정 응답 `measure:{hasCalendar, calendarItems, hasEvents, eventIds, hasEarnings, earningsRows}` — `hasEarnings` = 8b 줄 가운데 `eps`에 분기가 1개 이상 있는 줄이 있었나, `earningsRows` = 그런 줄 수(종목 수 — 분기 칸의 합이 아님), 데이터셋이 없으면 둘 다 null, 있는데 하나도 없으면 false·0. `PacketBuilder.Packet.measure` 한 곳에서 정해 패킷을 만든 모든 결정(정기·수동·초기·호출 실패·응답 뒤 실패)과 미리보기 `response.measure`에 남는다.
- 구현 메모: **크기** — `TARGET_TOKENS` 32,500 → **35,500**(어림 단위, 1단계 설계 §5-2). 가장 큰 모양(전제: |EPS| < 1만, 추정치가 패킷에 0이 아닌 값으로 찍힘 — |추정치| ≥ 0.00005. 25종목 × 4분기, EPS `-9999.9999`, 추정치 `-0.000051`(패킷에는 `-0.0001` — 모든 분기에 `epsSmallBase`), 서프라이즈율은 저장된 원래 추정치로 계산해 14자 `-19607842841.2`, 분기마다 통화가 섞여 25종목 모두 `epsCurrency` `"CNY,USD"`)으로 채운 시험 패킷이 약 35,425(8b 약 7,330 — `eps`와 출처 구분 문구 약 3,150)라 목표 안, 여유 약 75(실제 티커가 5자면 약 40 줄어듦). 처음 잰 약 35,230(여유 270)은 추정치 `-0.0001`로 서프라이즈율이 11자인 모양이라 가장 큰 모양이 아니었다(리뷰 C-PIT-3). 추정치가 0에 더 가까우면 서프라이즈율 자릿수에는 상한이 없다(실제로는 보지 못한 모양). 보통 모양(USD, 작은 추정치 없음, AAPL 자릿수)이면 `eps`는 약 1,760(머리말 약 310 포함 — 출처 구분 문구 약 60). 예상(~34,000)보다 큰 것은 `epsSmallBase`(분기마다 약 6토큰)·`epsCurrency`까지 최악으로 채웠기 때문 — 둘 다 실제로는 드묾.
- 구현 메모: **화면** — `/api/paper/status`의 `earnings:{available, covered, universe, withEstimate4, generatedAtKst}`(상태 저장본 요약, `generatedAt`이 없으면 저장 시각, 없으면 `available:false`·나머지 null), 개요 '장부 관측치' 카드에 "어닝 서프라이즈(yfinance): n/u종목 · 4분기 m · 갱신 …"(null은 —, 필드가 없는 백엔드면 줄 없음).
- `[확인 필요]` 첫 실제 수집 뒤 `covered`·`withEstimate4`(단계 0: 추정치 포함 4분기 이상 97%)와 eps가 든 결정 패킷의 실제 입력 토큰(어림 대비 배율 1.72)을 다시 잰다. Yahoo가 발표일을 고친 분기(같은 `periodEnd` 두 행)가 실제로 얼마나 생기는지 본다.

---

## 6. 측정 — 넣기 전에 정한다

| 항목 | 방법 |
|---|---|
| 태그 | 결정 기록에 `hasCalendar`·`hasEvents`(건수)·`hasEarnings` 표시. 복기 메모는 `week_ending`으로 결정과 연결 |
| 8주 뒤 읽기 | 사용자가 결정 로그에서 ① 일정·사건이 논거(`thesis`·`exposureRationale`)에 실제로 인용됐나 ② 재량 주문 수·노출 변동이 늘었나(과매매) ③ 복기 제안 중 승인된 비율을 본다 |
| 끄는 기준 | 사건 섹션이 8주 동안 논거에 인용되지 않거나 월 주문 수가 상한에 자주 닿으면 `news.enabled=false`. 복기는 제안 승인율이 0이어도 메모 자체가 가치이므로 유지 |
| 통계 | 몇 달치로는 성과 차이를 통계로 말하지 않는다(1단계 한계 7). 로그로만 판단 |

- 확인(2026-10-25): QA 스택(운영 백업 `macrodash-20261025-225401.sql` 복원, 외부 호출 차단·키 없음)에서 Claude 수동 결정을 한 번 돌려 결정 기록
  `response.measure` = `{hasCalendar: true, calendarItems: 17, hasEvents: null, eventIds: [], hasEarnings: true, earningsRows: 21}`을 확인했다(호출은
  `NO_KEY` → `API_ERROR`이지만 패킷은 실제 자료로 만들어지고 실패 결정에도 태그가 남음 — 운영 장부는 그대로). 그 결정에서 사건 창(10-23)이 뉴스 수집
  시작(10-25)보다 앞인데 `hasEvents`가 0으로 남는 결함을 찾아 고쳤다(수집 전이면 `null`). 운영의 첫 정기 결정(10-26 세션, KST 10-27 07:30)부터
  같은 태그가 남는다.

---

## 7. 결정 (2026-10-25)

| ID | 질문 | 결정 | 이유 |
|---|---|---|---|
| D29 | 뉴스 수집 방식 | **RSS만, 제목·출처·시각만, HTML 스크래핑 없음** — 사용자 동의(권장안) | 약관·깨짐·주입 위험. 사건 감지에는 제목으로 충분 |
| D30 | 뉴스 투입 방식 | **사건 감지형**(보유·후보 종목 일치 또는 매크로 키워드), 하루 10건 상한, 매일 다이제스트 아님 — 권장안 | 분기 전략에 매일 헤드라인은 노이즈(P4) |
| D31 | 순서 | **A 일정 → D 복기 → B 사건 뉴스 → C 서프라이즈** — 권장안 | 의존성 적고 효과 큰 것부터 |
| D32 | 복기 주기·범위 | 주 1회 토요일, 최근 4주, 제안은 F2 통로로 PENDING — 권장안 | 1단계 구조 재사용. 자동 반영 없음 유지 |
| D33 | 일정 출처 | FRED 발표 일정 API + FOMC 연간 상수 + yfinance 실적일 — 권장안 | 이미 쓰는 키·출처. 새 의존성 없음 |
| D34 | 새 의존성 | 수집기에 `feedparser` 1개 — 권장안 | RSS 변형 처리를 직접 쓰지 않기 위해. PyPI GA 버전 확인 뒤 고정 |
| D35 | 규칙 계좌·검증기 | **불변** | 동결 대조군(D15·D19). 네 항목은 Claude 패킷·프레임에만 |
| D36 | 서프라이즈 출처 | yfinance quoteSummary `earnings`·`calendarEvents`(발표 시각 포함) — 권장안, 단계 0 확인 뒤 확정(공개 `earnings_history`는 발표일이 없어 시점을 못 자름) | 같은 출처·같은 방법. 무료 컨센서스 대안이 없다 |

D30~D34·D36은 따로 답을 받지 않아 권장안으로 정했다. 구현을 시작할 때 바꿀 수 있다.

---

## 8. 선행 확인 (단계 0)

| 항목 | 확인 방법 | 결과가 다르면 |
|---|---|---|
| RSS URL 다섯 개가 유효하고 항목에 제목·링크·발행 시각이 있는가 | 수동 1회 수신, 고정본 저장 | 없는 피드는 빼고 문서에 적음 |
| FRED `releases/dates`가 CPI·PCE·고용·GDP 릴리스를 돌려주는가, 릴리스 ID | API 1회 호출 | 못 받는 릴리스는 BLS 일정 상수로 |
| 2026·2027 FOMC 회의 일정 | 연준 공개 일정표 확인 | 상수에 기록, 출처·확인일 표기 |
| yfinance `calendar`·`earnings_history` 필드와 60종목 커버리지 | 보유·후보 종목으로 1회 실행 | 커버리지 50% 미만이면 C를 보류하고 문서에 적음 |
| `feedparser` GA 버전 | PyPI 확인 | |
| 복기 입력 크기(4주 결정 × 주문) | 지금 결정 기록으로 조립해 토큰 추정 | 25K 넘으면 2주로 줄임 |

---

## 9. 함께 고칠 것

`collector/app/catalog.py`·`Datasets.java`(새 데이터셋 이름 넷: `calendar.us_events`·`news_headline`·`us.earnings_surprise`·필요 시 더), `registry.py`(태스크 3개), `docs/DATA_SOURCES.md`(태스크 표·새 소스 RSS·FRED 일정·한계), `db/migrations/V12__paper_reviews.sql`(1단계에서 V9~V11을 이미 씀), `AccessPolicy`·`RouteInventoryTest`·`docs/API.md`·`scripts/qa/routes.json`·`endpoints.ts`(복기 조회·수동 실행 경로), `.env.example`(새 변수 없음 예상, `feedparser` 추가는 `collector/requirements.txt`), 1단계 설계 계획서 §14에서 이 문서로 옮긴 항목 표시, ADR 0018 "결과" 절에 2단계 추가(새 ADR 불필요 — 가드레일 원칙이 같다).

---

## 10. 단계 0 결과 (2026-10-25)

수집기 컨테이너 안에서 순차로 확인(키·연락처 출력 없음, DB는 읽기만). 고정본은 구현 때 수집기 시험에 옮긴다.

| 항목 | 결과 | 영향 |
|---|---|---|
| RSS 다섯 출처 | [사실] 인베스팅닷컴 `news_25`·`news_95`·`news_14`: 200, 피드당 10항목, 제목·링크·시각 있음(시각은 시간대 없이 UTC — 미국 지표 발표 시각과 대조한 [해석]). 연준 `press_monetary.xml`: 200, RFC822 GMT. BLS `cpi.rss`·`empsit.rss`: 브라우저 UA는 403(Akamai), 설명형 UA는 200, 실제 형식은 Atom 1.0. SEC `pressreleases.rss`: SEC 세션으로 200, 하루 약 0.5건, 제목에 줄바꿈. **야후 파이낸스: 404·429, robots.txt `Disallow: /`** | **B 진행, 출처 넷**(야후 제외). B1에 URL 고정. `[확인 필요]` 인베스팅닷컴 RSS 이용 조건 — 사용자가 브라우저로 확인 권장 |
| FRED 발표 일정 | [사실] 릴리스 ID: CPI 10 · Employment Situation 50 · GDP 53 · Personal Income and Outlays(PCE) 54. 넷 다 `include_release_dates_with_no_data=true`일 때 앞날짜를 주고, 2026-12-31까지만 나온다. GDP·PCE 날짜는 BEA 공식 일정과 일치(10-29·11-25·12-23). CPI 11-10·12-10, 고용 11-06·12-04. 전체 목록 엔드포인트는 101번(FOMC 보도자료)의 매일 날짜로 1,000건 상한에 걸림 | **A 진행, 작은 변경**: 릴리스별 호출 4회, `lastKnownDate`로 "미공개 구간" 구분. BLS 일정 상수 불필요 |
| FOMC 2026·2027 일정 | [사실] 연준 일정표(Last Update 2026-10-07) — 2026: 1/27–28, 3/17–18*, 4/28–29, 6/16–17*, 7/28–29, 9/15–16*, **10/27–28**, 12/8–9*; 2027: 1/26–27, 3/16–17*, 4/27–28, 6/8–9*, 7/27–28, 9/14–15*, 10/26–27, 12/7–8* (*경제전망 SEP). 다음 회의가 이번 주 | 상수로 둠(출처·확인일 2026-10-25). 상수 끝(2027-12-08)을 지나면 "갱신 필요" |
| yfinance 실적일·서프라이즈 (60종목 — 보유 13 + 후보 7 + 13F 신규·확대 종목 40, ETF 제외) | [사실] yfinance 1.7.0. 다음 실적일 있음 60/60(미래 날짜 46/60 — 14종목은 막 지난 날짜를 아직 보임), 장전·장후 구분 55/60. 서프라이즈 4분기 이상(추정치 포함) **58/60(97%)**, 8분기 0/60(API가 4분기만). 모든 행에 실제 발표 시각(`reportedDate`). 공개 `Ticker.calendar`는 컨테이너 시간대(KST)로 날짜를 만들어 장후 발표 28종목이 하루 밀림, `earnings_dates`는 HTML 스크래핑. 종목당 0.16초(중앙값), 429 없음 | **C 진행**(50% 기준 넘음). 출처는 quoteSummary `calendarEvents`·`earnings`(내부 호출, 버전 고정·고정본 시험·변경 시 멈춤). "8분기" → "4분기(쌓이면 8분기)" |
| `feedparser` GA 버전 | [사실] **6.0.14**(PyPI, 2026-07-30), Python ≥ 3.10(수집기 3.11.17), BSD-2-Clause, 간접 의존성 `feedparser-sgmllib` 2.1.0. 고정본 10개를 파싱해 모두 제목·링크·`published_parsed`가 나옴(시간대 없는 날짜는 UTC로 읽음) | `collector/requirements.txt`에 `feedparser==6.0.14`, `make constraints`로 간접 의존성 고정. HTTP는 수집기 세션으로 받고 feedparser는 파싱만 |
| 복기 입력 크기 | [사실] 지금 기록(Claude 결정 1건·주문 9건)으로 조립하면 7,094자(어림 약 3K토큰). 외삽: 4주 × 결정 20 × 주문 140 → 어림 약 40~47K, 월 재량 상한(20건)에 맞춘 4주 × 주문 29 → 약 16~19K, 2주 × 주문 70 → 약 20~24K. 실측 배율: 패킷 실제 입력 토큰이 어림(÷3)의 1.72배 | **4주 기본, 어림이 25,000을 넘으면 2주로**(D2에 반영). 첫 복기 실행의 `usage.inputTokens`로 배율을 다시 잰다 `[확인 필요]` |
