# 체결 시점 자유화 명세 (2026-11-05)

결정은 [ADR 0027](../adr/0027-free-fill-timing.md)에 있고, 이 문서는 구조·숫자·단계와 단계마다 함께 고쳐야 하는 곳을 적습니다.
코드 줄 번호는 2026-11-05 조사 때의 값이라 구현하는 커밋에서 다시 확인합니다. 브랜치는 `claude/free-fill-timing-2026-11`입니다.

## 0. 사용자 결정 (2026-11-05)

| 번호 | 질문 | 결정 |
|---|---|---|
| P1 | 체결 범위 | 분 단위 지정 시각(전날 결정이 다음 세션의 임의 분을 지정) + 장중 결정(그 시각 시장가로 당일 체결). 미국·한국 둘 다, 정규장 안에서만 |
| P2 | 장중 판단 | Claude가 시각을 분 단위로 고름. **세션당 계좌별 최대 2회**(승인 때 3 → 2로 수정) |
| P3 | 계좌2 실험 | ADR 0022의 체결 시점 실험은 '조건 변경으로 종료'로 기록하고 지금 적용. 주문 단위 반사실은 참고 지표로 계속 |
| P4 | 규칙 계좌 | 설정으로 체결 시각 지정(시가·임의 분·종가), 기본값은 지금 그대로 |
| 승인 | 호출 예산 | **하루 호출 상한 60, 예약 20**(승인 때 수정) |

묻지 않고 권장안으로 둔 것(이의 없음): 스위치는 계좌별·기본 꺼짐, 스키마는 더하기만, 켜는 저장은 그때 다시 확인.

## 1. 지금과 바뀐 뒤

| 계좌 | 지금 | 켠 뒤 |
|---|---|---|
| 미국 `rules` | `NEXT_OBSERVATION` | 설정 `rules.timing`: `NEXT_OBSERVATION`(기본)·`NEXT_OPEN`·`AT_MINUTE`(`rules.timingAtEt`)·`NEXT_CLOSE` |
| 한국 `kr_rules` | `NEXT_OPEN` | 설정 `kr.rules.timing`: `NEXT_OPEN`(기본)·`AT_MINUTE`(`kr.rules.timingAtKst`)·`NEXT_CLOSE` |
| 미국 `claude`(계좌1) | `NEXT_OBSERVATION`·`NEXT_CLOSE` + 장중 확인 1회(12:00 ET, 전체 결정) | 아침 결정 `NEXT_OPEN`·`AT_MINUTE`·`NEXT_CLOSE` + 장중 판단 최대 2회(`MARKET`·`AT_MINUTE`·`NEXT_CLOSE`) |
| 한국 `kr_claude`(계좌1) | `NEXT_OPEN`만, 장중 확인 없음 | 위와 같음(KST, 결정은 밤) |
| 미국 `claude2`·한국 `kr_claude2` | 시가·`AT_1000`~`AT_1500`·종가 + 장중 확인 1회(30분 격자, 요청한 적 없음) | 위와 같음 — 매시 정각이 분 단위로, 장중 확인 1회가 장중 판단 2회로 |
| 벤치마크 넷 | 그대로 | 그대로 |

- 장부 반영 시각은 지금 구조 그대로입니다. 미국은 다음 시간별 관측치가 오고 1분봉 기다림이 풀릴 때, 한국은 그날 밤. 체결가는 T 봉으로 정해지므로 늦게 반영돼도 값은 같습니다.
- 스위치를 끄면 그 계좌의 시스템 프롬프트·응답 스키마·패킷·검증 결과가 지금과 바이트까지 같습니다(기존 고정본이 그대로 통과해야 함).

## 2. 체결 시점 모델

- 새 값 `AT_MINUTE`, 시각은 `paper_orders.target_local`(TIME, 그 시장 현지 시각 — 미국 `America/New_York`, 한국 `Asia/Seoul`). 이름을 `AT_TIME`으로 하지 않는 이유:
  `PaperNotifications.timingName`이 'AT_'로 시작하는 7글자를 시·분으로 읽습니다(`AT_TIME` → 'TI:ME').
- 기준 시각 T = 목표 세션 E(기준 거래일 다음 거래일, 장중 판단 주문은 그 세션) + `target_local`. `ExecutionAudit.targetAt`(미국)·`KrTimedLadder.targetOn`(한국)이 주문을 받아 계산합니다.
  `targetOn`은 지금 주문의 시각을 받지 않는 시그니처라 호출부 다섯(체결 조건·예상 상태·실행 감사 둘·사다리)이 함께 바뀝니다.
- 받는 범위(검증기·규칙 계좌 주문 생성·설정 저장이 같은 함수로 판정):

  | | 결정의 `AT_MINUTE` | 장중 판단 시각 | 장중 판단의 `MARKET` 닫힘 |
  |---|---|---|---|
  | 미국 | 개장 + 10분 ~ 마감 5분 전 앞(보통 09:40~15:54 ET, 조기 폐장일 12:54까지) | 개장 + 10분 ~ 마감 − 30분(09:40~15:30 ET) | 마감 5분 전 뒤, 개장 + 10분 앞(켠 판) |
  | 한국 | 09:10 ~ 15:19 KST | 09:10 ~ 14:50 KST | 15:20(종가 단일가) 뒤, 09:10 앞(켠 판) |

  위 값은 [ADR 0031](../adr/0031-open-offset-window-intraday-budget.md)(2026-11-08 배포)부터입니다. 그 전(ADR 0027 그대로)은 결정의 `AT_MINUTE` 개장 + 1분(09:31·09:01), 장중 판단 개장 + 5분(09:35·09:05)이었고
  장중 시장가에는 개장 쪽 하한이 없었습니다(§17).

  조기 폐장일(예: 2026-11-27 13:00 ET)과 한국 개장 시각 변경일(`kr.calendar.openTimeOverrides`)은 그날의 개장·마감으로 계산합니다.
- 닫힌 시점: T ≤ 주문 생성 + 60초이거나 T가 범위 밖이면 그 주문은 `LATE_FOR_TIMING`(Claude 주문 — 거절 행) 또는 기본 시점으로 냄(규칙 주문 — §8).
- 룩어헤드 방지는 그대로입니다: 봉 시작 ≥ T, 완성된 봉, 거래량 > 0, 저장본 수집 시각이 주문 생성 뒤.
- 기존 값 `AT_1000`~`AT_1500`·`MARKET`·`NEXT_OPEN`·`NEXT_CLOSE`·`NEXT_OBSERVATION`·`IMMEDIATE`·`BACKFILL`과 그 행은 그대로 읽고 체결합니다.

## 3. 스키마 (더하기만)

**V22 `paper_orders`** — B1:

```sql
ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS target_local TIME;
-- timing CHECK: V18의 12값 + 'AT_MINUTE' (지운 뒤 같은 이름으로 다시 — V14·V17·V18 방식)
-- 시각은 AT_MINUTE에만
CHECK (target_local IS NULL OR timing = 'AT_MINUTE')
-- 시장에 나가는 AT_MINUTE 주문은 시각이 있어야 함. 거절 행은 받은 값 그대로(시각이 빠진 응답도 거절 행으로 남음)
CHECK (status = 'REJECTED' OR timing <> 'AT_MINUTE' OR target_local IS NOT NULL)
```

- 양방향 CHECK `(timing = 'AT_MINUTE') = (target_local IS NOT NULL)`로 두지 않는 이유: 결정 파이프라인은 검증기가 거절한 주문도 응답의 시점 값 그대로 넣습니다
  (`ClaudeDecisionPipeline` — 거절 행 insert). 스키마 검사기는 조건부 필수를 받지 않아 시각이 빠진 `AT_MINUTE` 응답이 스키마를 지나고, 그 거절 행이 CHECK에 걸리면 과금된 호출의 결정 기록 전체가 되돌려집니다.
- 테스트 DB는 마이그레이션 파일을 매번 번호 순으로 다시 실행하고 V14·V17·V18이 CHECK를 옛 값으로 좁혔다 넓히므로, `AT_MINUTE` 행을 쓰는 시험은 시작·끝에 지웁니다(`MARKET` 선례).
- `PaperStore.ready()`에 `columnExists("paper_orders", "target_local")`을 더합니다(QA-016 — 배포 직후 스키마 적용 전 구간에서 주문 조회가 SQL 오류를 내지 않게).

**V23 장중 판단** — B3:

```sql
-- 결정 종류: V18의 다섯 + 'INTRADAY_1', 'INTRADAY_2' (CHECK 확대만 — UNIQUE (book_code, as_of_trading_date, kind)는 그대로)
CREATE TABLE IF NOT EXISTS paper_intraday_plans (
    book_code                TEXT        NOT NULL REFERENCES paper_books (code) ON DELETE CASCADE,
    session_date             DATE        NOT NULL,                 -- 목표 세션 E(그 시장 거래일)
    slot                     SMALLINT    NOT NULL CHECK (slot BETWEEN 1 AND 2),  -- 그 세션의 몇 번째 판단인가 — 결정 종류 INTRADAY_<slot>
    at_local                 TIME        NOT NULL,                 -- 확인 시각(그 시장 현지 시각, 분 단위)
    feed                     TEXT        NOT NULL CHECK (feed IN ('MINUTE', 'HOURLY')),
    watch                    TEXT[]      NOT NULL DEFAULT '{}',
    question                 TEXT,
    variant                  TEXT        NOT NULL,                 -- 그 세션의 결정이 쓴 판 이름 — 장중 판단은 이 판으로 부름
    manual                   BOOLEAN     NOT NULL DEFAULT FALSE,   -- 운영자가 당기거나 넣은 행(수동 문턱으로 호출)
    source_decision_id       BIGINT      NOT NULL REFERENCES paper_decisions (id) ON DELETE CASCADE,   -- 늘 그 세션의 아침(밤) 결정
    requested_by_decision_id BIGINT      REFERENCES paper_decisions (id) ON DELETE SET NULL,           -- nextCheckpoint로 예약한 장중 판단
    intraday_decision_id     BIGINT      REFERENCES paper_decisions (id) ON DELETE SET NULL,           -- 응답 결정(부르기 전·놓침은 NULL)
    status                   TEXT        NOT NULL CHECK (status IN ('PLANNED', 'DONE', 'EXPIRED', 'SKIPPED', 'SUPERSEDED')),
    reason                   TEXT,
    lag_seconds              INTEGER,                              -- 모르면 NULL(0으로 채우지 않음)
    called_at                TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (book_code, session_date, slot)
);
```

- `paper_checkpoints`(PK 계좌·세션)와 종류 `CHECKPOINT`는 끈 판의 것으로 그대로 둡니다. 켠 판은 새 표와 새 종류만 씁니다.
- 순번(`slot`)이 세션당 횟수를 강제합니다 — 코드가 받는 순번은 1·2뿐이고 종류 값도 둘뿐입니다. 늘리려면 종류 값과 예약 값을 함께 올리는 새 결정이 필요합니다.
- `source_decision_id`를 늘 아침(밤) 결정으로 두는 이유: 장중 판단 패킷은 그 결정이 보낸 패킷에서 하드 규칙·가격·선정 기준일을 읽고, 한국은 그 결정 시각을 신선도 기준으로 씁니다(QA-172).
  장중 판단이 다음 판단을 예약해도 이 칸은 바뀌지 않고 `requested_by_decision_id`에 남깁니다.
- 쓰는 곳은 백엔드 `store.PaperStore`뿐입니다(ADR 0008 — `collector/tests/test_table_ownership.py`에 새 표를 더함). 수집기는 감시 범위를 정하려고 읽기만 합니다.
- 운영 적용기는 기록에 없는 번호를 순서와 상관없이 적용합니다. 번호는 V22·V23으로 고정하고 다시 매기지 않습니다(브랜치 판을 올린 QA·로컬 DB에서 번호를 바꾸면 '내용이 바뀜' 경고만 내고 건너뜀).

## 4. 미국 장부·수집

- 장부(`PaperLedgerService`·`UsTimedFills`)는 시각 지정 대기 주문을 계좌와 상관없이 사다리로 풉니다 — R1 `Y1M_AT`(T 봉) → R2 `Y1M_NEXT`(T+1~4분) → R2b `Y1M_LATE`(그날 T 뒤 첫 거래 봉, 대체)
  → R3 `QUOTES_FALLBACK`(1분봉 자체가 없을 때, 대체) → E 확정 종가. `AT_MINUTE`를 이 사다리에 태웁니다.
  - `UsTimedFills.TIMINGS`에 `AT_MINUTE`, `ExecutionAudit.fromBars`의 메뉴 가드(메뉴 값이 아니면 null → R1·R2를 건너뛰고 R2b로 풀림)를 주문의 T로,
    시점 이름만 받는 `targetAt` 호출부(`closedTimings`·`ExecutionSection`·`CheckpointPacket`)를 주문을 받는 쪽으로.
  - `Order` 레코드에 `targetLocal` 칸을 더하되 기존 17칸 생성자를 보조 생성자로 남깁니다(호출부가 main 11곳·시험 119곳 — `Fill` 선례).
- 수집기 `paper_bars`:
  - 범위(`store.timed_scope`, `TIMED_ORDER_BOOKS`·`TIMED_MARKET_BOOKS`·`TIMED_HOLDING_BOOKS`): 계좌2는 지금 그대로(그 책의 대기·최근 8일 주문 전부), 그 밖의 책은 **체결 시점이 시각 지정 값인 주문만**.
    스위치가 꺼진 동안 범위가 지금과 같다는 것을 시험으로 고정합니다. 매수 수량의 'T 시각 순자산'은 보유 종목의 T 창 가격을 쓰므로 보유 범위도 같은 규칙으로 넓힙니다.
  - `AT_MINUTE`의 창 키: 대기·최근 8일 `AT_MINUTE` 주문의 (기준 거래일, `target_local`)을 읽어, 그 시각을 **기준일 뒤 7일(달력일) 안의 세션**에 창·`firstTradeAfter` 키로 더합니다
    (`store.timed_minute_targets`·`paper_bars.minute_labels`). 미국 수집기에는 거래일 달력이 없어 목표 세션 하나를 고르지 못하므로 그 폭 안의 세션 모두에 더하고,
    E 뒤 세션의 창은 장부가 읽지 않습니다. 날짜 없이 모든 세션에 더하면 저장본이 주문 수에 비례해 커집니다. 창 키가 저장본에 없으면 장부가 그 주문을 '거래 없음'으로 잘못 만료시킵니다.
  - 장중 시장가(`MARKET`) 창도 계좌2만이 아니라 그 시장 책의 주문 모두에서 읽습니다(끈 판에서 `MARKET`을 내는 것은 계좌2뿐이라 지금 범위는 그대로).
- 스탑: 시간별 관측치에서 즉시(그대로). 'T가 지났는데 아직 풀리지 않은 주문의 종목은 그 관측치의 스탑 판정에서 뺀다'가 시각 지정 주문을 가진 모든 책에 적용됩니다 —
  규칙 계좌의 체결 시각이 기본이 아닐 때 그 종목의 스탑 판정이 한 관측치 늦을 수 있습니다.
- 1분봉 기다림 `claude2.barsWaitMinutes`는 장부가 이미 모든 미국 책에 읽습니다. 규칙 주문이 시각 지정이 되면 규칙 계좌의 처리 지연도 정하므로 이 키를 규칙 계좌 영향 키로 바꿉니다
  (`PaperSettingKeys`·`PaperSettingsServiceTest` — 키 이름은 그대로, 설명을 '시각 지정 주문이 있는 모든 미국 책'으로).

## 5. 한국 장부·수집

- `KrTimedLadder.timed()` 한 판정에 체결·결정 게이트 ①·확정 조정 제외가 걸려 있어 `AT_MINUTE`를 여기에 넣으면 함께 따라옵니다. 장부의 장중 시각 정렬(`PaperLedgerService` 한국 분기)에도 더합니다.
- 장중 체결에는 금융위 확정 조정이 없습니다(지금 계좌2와 같음 — `KrConfirmations`).
- 수집기 `kr_paper_timed`:
  - `KR_TIMED_BOOKS`를 한국 Claude 두 계좌와 규칙 계좌로 넓힙니다. 범위는 시점으로 갈리므로(매시·종가·장중 시장가) 계좌1·규칙 계좌의 시가 주문은 지금처럼 고르지 않습니다.
    `AT_MINUTE` 대기 주문은 `store.kr_minute_orders`가 (종목, 기준 거래일, 지정 시각)으로 따로 읽고, 그 시각을 그 종목·목표 세션의 창 키로 더합니다(`window_keys(extra)`).
    `KR_TIMED_TIMINGS`(메뉴 일곱 + MARKET)는 그대로입니다.
  - 실행당 호출 상한(지금 60)은 종목·세션 수로 정해집니다(창 수와 무관 — 한 번 받은 봉에서 창을 뽑음). 규칙 계좌가 재선정일에 낼 수 있는 주문 수가 가장 크므로,
    규칙 계좌 체결 시각을 여는 B4에서 다시 계산해 `docs/DATA_SOURCES.md`의 '한국 책 호출 예산' 줄과 같은 커밋에서 고칩니다(`test_toss_call_budget.py`가 문서 숫자와 대조).
  - 실행 감사가 체결된 `AT_MINUTE` 주문의 창을 다시 받게 하는 일(`kr_audit_orders`가 지정 시각을 읽음)은 B5입니다 — B5에서 하지 않아 2026-11-07 QA-301로 고쳤습니다(감사 몫의 지정 시각 주문은 상태와 상관없이 E에 그 시각 창).
- 결정 게이트 ①(1분봉이 FAILED면 그 계좌의 다음 결정을 보류)이 켠 계좌1과 시각을 지정한 규칙 계좌에도 걸립니다 — 받아들입니다.
- 한국 장중 판단의 검증은 지금 계좌2처럼 예상 상태(`KrExpectedState`)로 합니다. 감시 저장본의 창은 09:00과 매시뿐이라, 앞선 장중 판단이 낸 `MARKET`·`AT_MINUTE` 주문의 기준 분 창을
  감시 범위에 함께 싣습니다(없으면 예상 상태가 그 시각이 아닌 마지막 봉 종가로 어림).
- 한국 작업의 '기준 시각이 남은 주문' 판정을 `KrExpectedState.targetAt`과 같은 함수로 맞춥니다. 지금 `supersedePendingAfter`는 한국 작업에서도 미국용 표(`NEXT_OPEN` = 09:30)를 써서,
  09:05~09:30의 교체가 이미 체결된 것으로 본 시가 주문을 취소할 수 있습니다(지금은 격자가 10:00부터라 드러나지 않음). 이 수정이 한국 장중 판단 시각을 09:05까지 넓히는 것보다 먼저입니다.

## 6. Claude 계좌의 켠 판

- 프로필(`ClaudeBookProfile`의 새 칸 `freeTiming`) 넷: `US_CLAUDE_FT`·`US_CLAUDE2_FT`·`KR_CLAUDE_FT`·`KR_CLAUDE2_FT`(B2 — 끝). 장중 판단 응답 프로필은 B3에서 더합니다.
  계좌2의 c2 판처럼 결정 파이프라인 맵 밖의 따로 만든 파이프라인(`ClaudeBookService.freeTiming`)이고, 결정마다 그 실행 설정의 스위치(`FreeTimingSettings`)로 고릅니다(`variant`).
  미국 계좌1의 시작·미리보기·기존 장중 확인(종류 `CHECKPOINT`)은 늘 끈 판 파이프라인입니다.
- 응답 스키마(새 파일 둘 — 시장마다 하나, 그 시장의 두 계좌가 함께 씀): `paper/us-decision-ft.schema.json`·`paper/kr-decision-ft.schema.json`. `timing` enum {`NEXT_OPEN`, `AT_MINUTE`, `NEXT_CLOSE`}(ADR 0031 `ft-2`·`kr-ft-2`부터 시가를 뺀 둘),
  주문의 선택 칸 `atLocal`("HH:MM" pattern — `FreeTiming.CLOCK_PATTERN`), 주문마다 `executionNote`. B3에서 `checkpoints[]`(최대 2 — ADR 0031부터 3, 각 `{at, feed, watch, question}`)와
  장중 판단 스키마(`action` KEEP·REPLACE, 주문 `timing` enum {`MARKET`, `AT_MINUTE`, `NEXT_CLOSE`}, 선택 칸 `nextCheckpoint`)를 더합니다. 스키마 검사기(`StructuredSchema`)는 pattern을 받고 조건부 필수는 받지 않으므로
  '`AT_MINUTE`면 `atLocal` 필수'와 시각 범위는 검증 표의 닫힘으로, 30분 간격·남은 횟수·시각 순서는 의미 검사로 막습니다(어기면 그 주문·예약만 거절하고 사유를 남김).
- 고정 문단(새 판, 계좌별): 받는 시점 셋, 시각 범위, 'E 하루짜리', 장중 판단의 뜻(확인 시각 뒤 첫 수집본으로 부름 — 몇 분 뒤, 실시간 아님), 횟수.
  설정값(최대 횟수·남은 횟수)은 고정 문단이 아니라 패킷 칸에 싣습니다(고정 문단은 설정값 없는 상수 규칙).
  계좌2 켠 판 문단은 성향 절이 끼워지는 '출력 절 머리'를 하나만 가져야 합니다(`ClaudePrompts`·`FrameworkService.render`의 기동 때 치환 검사).
- 한국: 시스템 프롬프트의 하드 규칙 줄('체결 시점은 `NEXT_OPEN`뿐')이 프로필이 아니라 시장 묶음에서 옵니다. 렌더링이 이 줄도 프로필에서 받게 하고(끈 판은 시장 묶음 값 그대로 — 고정본 불변),
  `KrPacketBuilder`의 시점 문장(`0_instructions`·`12_hardRules`)을 계좌 코드가 아니라 프로필 판으로 가릅니다.
- 미국 계좌1 켠 판은 계좌2의 패킷 변형(`13_execution`)을 쓰고, 자기 체결 기록을 싣습니다.
- 지난 결정 목록(`10_recentDecisions`)에서 장중 판단 행(종류 `INTRADAY_*`)은 '직전 결정'이 아닙니다(자세·노출·관심 목록이 없는 응답 — QA-179). 계좌 코드가 아니라 행의 종류로 가르므로,
  미국 계좌1의 옛 `CHECKPOINT` 행(전체 결정 모양)은 지금처럼 목록에 남고 끈 판 패킷이 바뀌지 않습니다. 옛 `CHECKPOINT` 행이 있는 상태의 끈 판 고정본 시험을 더합니다.
- 검증기(`OrderValidator`)는 고치지 않습니다. 결정 파이프라인이 응답 주문의 시각마다 열쇠 `AT_MINUTE@HH:MM`을 만들어 그 결정만의 검증 표를 넘깁니다(`FreeTiming.validation` —
  순위는 기준 시각 순·같은 시각은 같은 순위, 범위 밖은 `MALFORMED`, 지금 + 60초 이전은 `LATE_FOR_TIMING`, 시각 없는 `AT_MINUTE`는 `MALFORMED`, 근거 문구의 이름은 '다음 세션 10:47 ET'·
  '다음 거래일 10:47 KST'). 주문 행·판정 기록에서는 열쇠를 `AT_MINUTE` + `target_local`(`atLocal`)로 되돌립니다. 고정본 `order-validator-us.txt`와 끈 판 고정본이 바이트 그대로인 것이 B2의 통과 조건입니다.
- 패킷: 미국 켠 판은 계좌2 변형의 줄기(`13_execution`)에 `1_basis.variant = freeTiming`·`executionMenuVersion 3`·`fixedRules ft-1`, 메뉴 셋(`AT_MINUTE` 줄은 범위)·`13_execution.atMinute`(그 세션의 첫 분·마지막 분),
  `12_hardRules`의 시점 문장 둘. 한국 켠 판은 `KrPacketBuilder.forFree` — `1_basis`의 `variant`·`fixedRules kr-ft-1`·`atMinute`, `0_instructions`의 시점 줄, `12_hardRules`의 매도 자리 줄·지정 시각 체결 줄·받는 시점.
- 결정 창 가드(계좌 코드 → 방식, B2 — 끝):
  - '그 계좌 장부가 이번 관측치를 처리했는가(1분봉 기다림 풀림)' — 켠 판 계좌1의 정기 결정에도(`PaperDecisionJob.freeTimingWait` — 처리하지 않았으면 그 주기는 건너뛰고 다음 주기에).
    없으면 결정의 `supersedePending()`이 T가 지났지만 아직 풀리지 않은 주문을 지웁니다.
  - 정규장 중 수동 결정 거절(400) — 켠 판 계좌1도 계좌2와 같은 창(확정 종가 처리 뒤 ~ 다음 세션 09:00 ET 전).
  - 정기 결정을 건너뛰는 개장 전 컷오프는 계좌2에만 그대로 둡니다(켠 판은 늦은 결정에서도 남은 시각의 주문을 낼 수 있고 지난 시각은 주문 단위로 닫힘).
  - 한국은 결정 게이트 ①과 결정 창이 같은 일을 합니다(계좌마다 따로 봄 — 켠 계좌1도 걸림).
  - 규칙 계좌는 체결 시각이 기본이 아닐 때 같은 확인(재선정일의 주차 주문 교체가 풀리지 않은 주문을 취소하지 않게) — B4.
- 미국 계좌1의 시작·미리보기는 늘 끈 판 프로필입니다(초기 배분은 출발일 종가 사후 체결 — 켠 판의 닫힌 시점 검사에 걸리지 않게).
- 계좌1 장중 확인 작업(`PaperClaude1CheckpointJob`)은 `claude.freeTiming`이 켜져 있으면 부르지 않습니다. 두 키를 함께 켜는 저장은 `PaperSettingsService.update`의 병합 뒤 검사에서 거절합니다(B2 — 끝).
- 스위치를 켤 때 남아 있는 끈 판의 대기 주문은 손대지 않습니다 — 다음 결정이 대신하고 그 전까지는 지금 경로로 체결됩니다.

## 7. 장중 판단

- 행 식별은 (계좌, 세션, 순번)입니다. 지금 작업의 세션당 한 행 전제(상태 바꾸기의 WHERE, '이미 부름' 지름길, 메모리 열쇠, 작업 기록의 키, 한 행 읽기, 정렬)는 새 표의 함수에서 모두 순번을 받습니다.
- 예약 규칙:
  - 결정의 `checkpoints[]`: 시각 순으로 순번 1·2. 범위·간격을 어긴 항목은 그 항목만 버리고 결정 기록에 사유.
  - 장중 판단 응답의 `nextCheckpoint`: 순번이 남았을 때만. 그 세션의 남은 `PLANNED` 행을 대신합니다(다음 순번 행을 새 시각으로 — `requested_by_decision_id`에 그 응답 결정). 없으면 남은 예약은 그대로.
    그 뒤 순번의 `PLANNED` 행(세션당 3일 때)은 그대로 남으므로 `nextCheckpoint`는 그 시각보다 20분 이상 앞이어야 합니다(어기면 버림 — 패킷 `nextCheckpoint.laterReserved`, QA-309).
  - 수동 실행: 가장 이른 남은 `PLANNED` 행의 시각을 '지금 + 1분'으로 당기고 `manual`을 켭니다. 예약이 없고 순번이 남았으면 새 행. 순번을 다 썼으면 409.
  - 뒤 결정(수동·재시도)이 앞 결정을 대신하면 그 세션의 `PLANNED` 행은 `SUPERSEDED`.
- 작업: 새 표를 읽는 장중 판단 작업(시장마다 하나 — 60초 주기, 자기 잠금, `config.enabled()`가 거짓이면 아무것도 하지 않음, 저장본은 `StoreReader.quietly`).
  - 창: 확인 시각 T + 2분 ~ T + 20분 안에, T 뒤에 수집된 감시 저장본이 있을 때 한 번 부릅니다. 놓치면 `EXPIRED`(재시도 없음 — 지금과 같음).
  - 호출은 그 행의 `variant` 프로필·스키마로. 응답 결정은 종류 `INTRADAY_<순번>`, 기준 거래일은 아침 결정과 같은 d.
  - 호출은 장부 잠금 밖, 쓰기만 장부 잠금 안(지금과 같음). 수동 행은 수동 문턱(상한 − 예약), 예약 행은 정기 문턱(상한)으로 셉니다.
  - 기존 `PaperCheckpointJob`·`PaperKrCheckpointJob`·`PaperClaude1CheckpointJob`은 끈 판의 것으로 그대로 둡니다(공통 부분은 떼어 함께 씀 — 옮기는 커밋과 고치는 커밋을 나눔).
- 감시 저장본 계약 2(`paper.watch.us`·`paper.watch.kr`): 지금은 시장마다 한 장에 확인 신원(계좌·세션·시각)이 하나뿐이고 범위 쿼리가 계좌 하나·정렬 없는 한 행이라, 계획이 여럿이면 뒤 시각 행이 잡혀 앞 확인이 놓칩니다.
  저장본에 `checkpoints` 목록(계좌·세션·순번·시각)과 범위 합집합을 싣고, `watch_scope`는 그 세션의 `PLANNED` 행 전부(옛 표 + 새 표)를 시각 순으로 돌려줍니다. 백엔드는 자기 행의 신원이 목록에 있을 때만 씁니다.
  계약 1을 읽는 기존 작업이 계약 2도 읽도록 같은 커밋에서 고칩니다.
- 새 경로 `POST /api/paper/run/intraday {book}`(운영자) — 새 컨트롤러(기존 둘은 생성자 인자 한도). 예약만 하고 '예약됨'을 돌려줍니다(호출은 작업이 자기 잠금 안에서 — 같은 창의 정기 주기와 겹쳐 두 번 과금되지 않게).
  `AccessPolicy`·`RouteInventoryTest`·`docs/API.md`·`scripts/qa/routes.json`(mutating, fuzz 제외 — `run/decision`과 같은 모양)·`endpoints.ts`.

- **B3에서 정한 것**(구현 뒤 — 위 문장과 다르면 이쪽이 맞습니다):
  - 예약 칸의 시각 이름은 두 시장 모두 `at`(그 시장 현지 시각 'HH:MM')입니다. 미국은 `feed`(`MINUTE`·`HOURLY`)가 필수, 한국은 피드 칸이 없고 늘 감시 1분봉입니다.
    의미 검사(`IntradayRequest`)는 어긴 항목만 버리고 사유(`CHECKPOINT_INVALID — …`)를 결정 기록 `intradayPlan.rejected`에 남깁니다. 이른 시각부터 받습니다.
  - 뒤 결정이 닫은 행(`SUPERSEDED`)은 부른 적이 없는 예약이라 그 순번을 다시 예약할 수 있습니다(끝난 판단 `DONE`·`EXPIRED`·`SKIPPED`는 되살리지 않음).
    끈 판 결정도 그 세션에 켠 판이 남긴 `PLANNED` 행이 있으면 닫습니다(스위치를 끈 뒤의 결정이 그 세션을 대신함). 반대로 켠 판 결정은 끈 판의 `PLANNED` 장중 확인 행을 닫습니다.
  - 감시 저장본은 **모양 판 1 그대로**이고 칸 하나(`checkpoints` — 창 안 계획 전부의 신원 `{book, sessionDate, atEt|atKst, slot}`)를 더했습니다. 예전 칸 `checkpoint`는 가장 이른 계획입니다.
    읽는 쪽(`WatchIdentity`)은 목록이 있으면 목록에서 자기 행을 찾고, 목록이 없는 예전 저장본은 순번 없는 계획(끈 판 장중 확인)으로만 봅니다. 수집기 범위는 `store.watch_plans`.
  - 작업은 계획 행을 쓴 결정의 판으로 부릅니다 — 결정 뒤에 스위치를 꺼도 그 세션의 남은 판단은 그 판으로 부릅니다. **멈추는 손잡이는 세션당 횟수 설정**
    (`intradayMaxPerSession`·`kr.intradayMaxPerSession`을 0으로, 미국 계좌2는 `claude2.enabled`)과 계좌 일시정지입니다 — 그 행은 창 뒤 `SKIPPED INTRADAY_OFF`.
  - 장중 판단 패킷은 장중 확인 패킷(`CheckpointPacket`·`KrCheckpointPacket`)에 자유 시점 판 칸을 더한 것입니다: `1_basis`의 계좌·순번·종류·`maxPerSession`·`manual`,
    남은 시점(`MARKET`·`AT_MINUTE`·`NEXT_CLOSE`)과 남은 지정 시각 범위 `atMinute`, 다음 예약 가능 여부 `nextCheckpoint`. `MINUTE` 피드는 그 계획의 종목만 싣습니다
    (저장본 한 장이 다른 계좌 계획의 종목도 실음).
  - 수동 경로는 '예약만'입니다(§7 본문 그대로): 가장 이른 남은 예약을 지금 + 1분으로 당기거나 새 행(미국 `HOURLY`·한국 `MINUTE`, 감시 목록 없음)을 넣습니다.
    새 행은 **오늘 세션의 결정이 자유 시점 판일 때만**(보낸 패킷 `1_basis.variant`) — 스위치를 결정 뒤에 켰으면 400입니다. `PAPER_ENABLED=false`인 서버는 부를 작업이 없어 400.
  - 한국 '기준 시각이 남은 주문' 판정(`supersedePendingAfter`)은 한국 주문이면 `KrExpectedState.targetAt`입니다(재현 시험: 09:14 교체가 시가 주문을 남김).
  - 화면에 장중 판단 줄·수동 단추를 보이는 일(상태 응답·알림 문구·`endpoints.ts`)은 B5입니다 — 지금 응답으로는 결정 기록의 `INTRADAY_<순번>` 행과 작업 기록(`intraday`·`kr.intraday`)으로 봅니다.

## 8. 규칙 계좌

- 설정 키 넷(규칙 계좌 영향 키 — 저장 전 확인 창): `rules.timing`·`rules.timingAtEt`, `kr.rules.timing`·`kr.rules.timingAtKst`. `AT_MINUTE`인데 시각이 없거나 범위 밖이면 저장 거절.
- 주문 생성(`RuleBookService`·`KrRuleBookService`): 설정 시점이 그 주문에 대해 닫혔으면(§2) 그 결정의 주문은 기본 시점으로 내고 결정 기록 `notes`에 사유. 시험: 조기 폐장일, E 장중의 수동 결정, 기한 뒤 진행.
- 다시 내기: 시각 지정 규칙 주문(출처 `RULE`)이 E에 체결되지 못하면(`NO_TRADE_AFTER_T`·`NO_BARS`·`NO_SESSION_BARS`·`HOLDING_UNVERIFIED`·`RECHECK_FAILED`) 그 행을 사유와 함께 `EXPIRED`로 닫고,
  같은 책 트랜잭션에서 같은 결정 번호·기본 시점·기준일 = E·만료 = 원래 `expires_on`인 새 대기 주문을 냅니다. 근거에 `reissuedFrom`(원래 주문 번호). 참고 지표에서는 따로 셉니다.
  한국도 같은 방식입니다(한국 책은 시각 지정이 아니어도 만료가 기준일 + 3거래일이라, E에 못 푼 `AT_MINUTE` 규칙 주문을 그대로 두면 사흘 동안 대기로 남음).
  스탑 주문(출처 `STOP`)은 대상이 아닙니다.
- 1분봉 자료가 아예 없을 때는 지금처럼 R3·E 확정 종가로 체결됩니다(만료가 아님).

- **B4에서 정한 것**(구현 뒤 — 위 문장과 다르면 이쪽이 맞습니다):
  - 지정 시각 키(`rules.timingAtEt`·`kr.rules.timingAtKst`)의 기본값은 '없음'이 아니라 `10:00`입니다(시점이 `AT_MINUTE`일 때만 읽음 — 시각 종류 키가 빈 값을 받지 않음).
    저장 검사는 보통 날 범위(미국 09:31~15:54 ET·한국 09:01~15:19 KST — ADR 0031부터 09:40~15:54 ET·09:10~15:19 KST)로 하고, 그날의 범위(조기 폐장·장 시간 변경)는 결정마다 `RuleTiming.choose`가 봅니다.
  - 설정 시점이 그 결정에서 닫혔으면(범위 밖·이미 지난 시가/지정 시각/마감) 그 결정의 주문 전부를 기본 시점으로 내고 사유를 결정 기록 `notes`에 남깁니다.
    기본이 아닌 설정이면 결정 기록에 `timing`(그 결정이 쓴 시점)·`timingSetting`(설정 값)이 더해지고, 기본 설정의 기록은 이 설정 전과 같습니다(미국은 그 칸이 없음, 한국은 `timing: NEXT_OPEN` 그대로).
  - 다시 내기는 **미국 시가·지정 시각**(1분봉 장부 `UsTimedFills.expire` — 그 세션 하루짜리로 만료되는 자리)과 **한국 지정 시각·종가**(장부가 '만료까지 체결하지 않음'으로 판정한 자리)에서 합니다.
    미국 종가(`NEXT_CLOSE`) 규칙 주문은 계좌1의 종가 주문처럼 만료일까지 다음 확정 종가를 기다리므로 다시 내지 않습니다. 원래 만료일이 그 세션 이하면(수명이 끝남) 다시 내지 않습니다.
    새 주문은 같은 결정 번호·같은 크기이고 근거에 `reissuedFrom`·`reissuedTiming`·`reissuedBecause`가 붙습니다. 원래 행의 사유 끝에 '… 주문 N으로 다시 냄'.
  - 결정 작업: 미국 규칙 계좌의 체결 시각이 기본이 아니면 규칙 계좌 장부가 그 관측치를 처리한 뒤에만 그날 결정을 냅니다(`PaperDecisionJob.ruleTimingWait` — 켠 판 계좌1과 같은 확인).
  - 한국 1분봉 수집 실행당 상한 60 → 180(`KR_TIMED_CALL_BUDGET` — 재선정일 최악 55종목 × 3쪽 = 165회, `docs/DATA_SOURCES.md` '한국 책 호출 예산').
  - `claude2.barsWaitMinutes`는 규칙 계좌 영향 키가 됐습니다(키 이름은 그대로 — 시각 지정 주문이 있는 모든 미국 책의 처리 지연).

## 9. 호출 예산·비용

- `ClaudeBookService.MAX_DAILY_CALL_CAP` 50 → 100(ADR 0020 결정 6의 문구와 그 문구를 단언하는 `PaperSettingsServiceTest`를 함께 고침). 값은 켜는 저장에서 상한 60·예약 20.
- 정기 호출의 하루 최대(평일): 미국 결정 2 + 재시도 2 + 미국 장중 판단 4 + 한국 결정 2 + 재시도 2 + 한국 장중 판단 4 = 16. 주간 복기는 세션이 없는 일요일입니다. 예약 20은 이보다 큽니다.
- 계좌2 소상한 `claude2.maxCallsPerCycle`: 같은 기준 거래일의 결정·재시도·장중 판단 합. 켠 판에서는 결정 1 + 재시도 1 + 장중 판단 2 = 4가 필요합니다(서버 값 3). 셈(`claude2CallsInCycle`)에 `INTRADAY_*` 행을 더합니다.
- 비용 어림(§16의 실측 단가 0.16~0.19달러): 네 계좌가 날마다 두 번씩 쓰면 하루 +8회 ≈ 1.3~1.5달러, 월 22거래일 ≈ 28~33달러. 상한 60 전부 ≈ 하루 11달러. 장중 호출은 캐시(5분)를 매번 다시 씁니다.
- ADR 0031(2026-11-08)부터: 상한 70·예약 30·소상한 5(결정 1 + 재시도 1 + 장중 판단 3). 장중 판단이 세션당 3회가 되어 정기 호출의 하루(KST) 최악은 EST 22·EDT 26회입니다(§17).

## 10. 참고 지표·복기

- 실행 감사(`ExecutionAudit`·`PaperExecutionAuditJob`·한국 `KrExecutionAudit`)는 계속 돕니다. 화면 카드 이름을 '체결 시점 참고 지표'로 바꾸고 판정 문구(M1 문턱)를 내립니다.
- 기준 반사실을 책 정의의 정적 값이 아니라 주문 단위로 정합니다 — 시각 지정 주문이면 관측치 사슬로 증명한 값(`fromObservation`), `NEXT_OBSERVATION`이면 체결에서(`fromFill`).
  관측치 사슬(`chainWanted`)은 '시각 지정 주문을 낼 수 있는 책이 있는가'로. → 2026-11-07 QA-300으로 구현: `ExecutionAudit.observationBaseline`(종가 주문은 만료일이 목표 세션 E인 하루짜리만),
  `chainWanted` = `claude.freeTiming` 또는 계좌2 조건. 덧붙인 가드 — 배포 전 코드가 기록한 고리는 계좌1 주문을 보지 않았으므로, 계좌1 주문의 증명은 E 개장 뒤 고리가 모두
  새 코드의 범위 표시(`scope = "order"`)를 가질 때만입니다(E 개장 전 저장본은 E 봉이 없어 ④를 통과할 수 없음 — 장부 `NEXT_OBSERVATION` 체결과 같은 가정). 계좌2 주문은 조건 없음.
- 감사 대상: Claude 계좌는 지금처럼, 규칙 계좌는 그 계좌의 체결 시각이 기본이 아닐 때부터(`auditedBooks`·주문 거름 `source = 'CLAUDE'`·수집기 `kr_audit_orders`·`requireAudited`).
- 주간 복기(`ReviewService`·`ReviewFacts`): 입력의 결정 목록에서 `INTRADAY_*` 행을 빼고 그 세션 결정의 사실 줄에 '장중 판단 n회(유지·교체)'만 남깁니다(복기 스키마는 해시로 잠겨 있고 상한 40건).
  켠 판 계좌의 복기 시스템 프롬프트는 그 계좌 프로필의 고정 문단으로. 거절 주문의 가정 진입(`Entry.NEXT_CLOSE` — '다음 세션 종가' 근사)은 그대로 두고 근사임을 적습니다.

## 11. 화면·API

- 시점 이름표: `AT_MINUTE` → 'HH:MM ET'·'HH:MM KST'(주문의 `targetLocal`), 텔레그램 알림(`PaperNotifications.timingName`)도 같은 글.
- 술어를 셋으로 나눕니다(지금은 `isTimedBook` 하나가 계좌 코드의 정적 표를 읽음 — 호출부 9곳):
  '계좌2인가'는 코드로, '시각 지정 칸을 보일까'는 주문·체결 행의 값(목표 시각·사다리 칸)으로, '이 계좌의 체결 방식 글'은 상태 응답의 새 칸으로.
- 상태·설정 응답: 기존 칸은 그대로 두고 새 칸을 더합니다 — 계좌별 `freeTiming`(지금 판), 방식이 바뀐 날, 장중 판단 목록(계좌별 여러 건).
  미국 상태 응답 고정본(`paper-status-us.json`)이 바뀌는 커밋은 따로 뗍니다.
- 계좌 정의 문장은 켠 판·끈 판 두 벌을 두고 설정 값으로 고릅니다. 성과 곡선에는 방식이 바뀐 날을 표시합니다.
- 결정 탭: 장중 판단 줄(계좌·세션마다 최대 2건 — 시각, 유지·교체, 다음 예약). 설정 화면: 새 키 묶음과 켜는 저장의 권장값 안내.
- 새 경로는 §7의 하나입니다.

## 12. 설정 키와 켜는 절차

### 12-1. 새 키

| 키 | 기본 | 규칙 계좌 영향 | 뜻 |
|---|---|---|---|
| `claude.freeTiming` · `claude2.freeTiming` · `kr.claude.freeTiming` · `kr.claude2.freeTiming` | 꺼짐 | 아니오 | 그 계좌의 다음 결정부터 자유 시점 판 |
| `intradayMaxPerSession` · `kr.intradayMaxPerSession` | 2 (0~2, ADR 0031부터 0~3) | 아니오 | 세션마다 계좌별 장중 판단 횟수. 0이면 장중 판단 없음(분 단위 지정만) |
| `intradayMinPerSession` · `kr.intradayMinPerSession`(ADR 0031) | 0 (0~1) | 아니오 | 1이면 세션 중간까지 예약이 없을 때 코드가 한 번 넣음(보장) |
| `intradayEvents` · `kr.intradayEvents`(ADR 0031) | 꺼짐 | 아니오 | 장중 사건이 장중 판단을 당김 — 그 시장 `stopWatch.mode`가 SHADOW·ON일 때만 자료가 있음 |
| `intradayEffort`(ADR 0031, 두 책 공통) | 없음(= `effort`) | 아니오 | 장중 판단 호출만의 effort |
| `stopWatch.mode` · `kr.stopWatch.mode`([ADR 0032](../adr/0032-paper-intraday-stop-watch.md)) | `OFF` | 예 | 장중 스탑 감시 `OFF`·`SHADOW`·`ON` |
| `rules.timing` · `rules.timingAtEt` | `NEXT_OBSERVATION` · 없음 | 예 | 미국 규칙 계좌 체결 시각 |
| `kr.rules.timing` · `kr.rules.timingAtKst` | `NEXT_OPEN` · 없음 | 예 | 한국 규칙 계좌 체결 시각 |
| `apiDailyCallCap`(기존) | 그대로 | 아니오 | 코드 최대 50 → 100 |
| `claude2.barsWaitMinutes`(기존) | 그대로 | 아니오 → 예 | 시각 지정 주문이 있는 모든 미국 책의 1분봉 기다림 |

### 12-2. 켜는 저장(시장별로 따로, 그때 사용자 확인)

- 공통(먼저 켜는 시장의 저장에 함께): `apiDailyCallCap` 60, `apiScheduledReserve` 20.
- 미국: `claude.freeTiming`·`claude2.freeTiming` 켬, `claude.checkpoint` 끔, `claude2.maxCallsPerCycle` 4 이상.
- 한국: `kr.claude.freeTiming`·`kr.claude2.freeTiming` 켬.
- 규칙 계좌의 체결 시각은 사용자가 값을 정할 때 따로 저장합니다(기본값이면 아무것도 바뀌지 않음).
- ADR 0031·0032 배포 뒤의 저장 값은 §17-3입니다.
- 판은 결정 때 정해지므로 저장 시각에 제약은 없지만, 결정이 도는 중(미국 06:30 KST 앞뒤, 한국 22:30 KST 앞뒤)은 피합니다.

### 12-3. 켠 뒤 확인

- 첫 결정: 켠 판 프로필·스키마로 불렀는가, 주문의 `timing`·`target_local`, 계획 행(순번·시각·`variant`).
- 첫 장중 판단: 감시 저장본 계약 2의 목록에 그 행이 있는가, 호출 시각(T 뒤 몇 분), 응답 종류 `INTRADAY_1`, 교체면 취소된 주문이 '기준 시각이 남은 것'뿐인가.
- 첫 `AT_MINUTE`·`MARKET` 체결: 사다리 칸(R1이 아니면 사유), 체결 봉 시각 ≥ T, 한국은 그날 밤 장부.
- 호출 수·비용(`paper_api_usage`)과 소상한.

### 12-4. 되돌리기

- 스위치가 꺼진 동안: V22·V23은 더하기만이라 옛 판 백엔드·수집기로 그대로 내릴 수 있습니다.
- 켠 뒤: 스위치를 끄고(다음 결정부터 끈 판), 남은 `AT_MINUTE` 대기 주문과 `PLANNED` 계획 행이 그 세션에서 체결·만료된 뒤에 내립니다. 옛 판 장부는 모르는 시점 값을 시간별 관측치로 체결하고
  (ADR 0022 '되돌리기'의 `AT_*`와 같은 이유), `INTRADAY_*` 결정 행을 직전 결정으로 읽을 수 있습니다.

## 13. 단계와 커밋 순서

| 단계 | 내용 | 상태 |
|---|---|---|
| B0 | 문서(ADR 0027·이 명세) + 읽기 전용 측정(§16) | 끝 |
| B1 | V22 + `AT_MINUTE` 장부(미국·한국)·수집 범위. 아직 어느 계좌도 쓰지 않음 | 끝 |
| B2 | Claude 켠 판(프로필·스키마·고정 문단·패킷·그 결정의 검증 표) + 결정 창 가드 일반화. 스위치 기본 꺼짐 | 끝 — 장중 판단 예약(`checkpoints[]`)과 켠 판의 장중 문장은 B3 |
| B3 | V23 + 장중 판단(새 표·새 종류·작업·감시 계약 2·수동 경로) + 호출 상한 | 끝 — 구현하며 정한 것은 §7 끝의 'B3에서 정한 것' |
| B4 | 규칙 계좌 설정 키·닫힌 시점·다시 내기 | 끝 — 구현하며 정한 것은 §8 끝의 'B4에서 정한 것' |
| B5 | 참고 지표·복기·응답·화면 | 끝(줄인 범위) — 주간 복기는 장중 판단을 그 세션 결정에 접어 넣음, 실행 감사 M1·메뉴 줄은 장중 판단 결정의 주문을 뺌, 주문 행 `targetLocal`·상태 `intraday`, 화면은 결정 탭의 장중 판단 줄·수동 단추와 시점·종류 이름. **하지 않은 것**: 실행 감사 카드 이름 바꾸기와 기준 반사실의 주문 단위화(§10 첫 두 항목), 규칙 계좌를 감사 대상에 넣기, `kr_audit_orders`의 지정 시각 — 스위치를 켠 뒤 자료가 쌓이면 따로. **뒤에 한 것**(2026-11-07, 브랜치 `claude/intraday-timing-2026-11`): 기준 반사실의 주문 단위화(QA-300)·`kr_audit_orders`의 지정 시각(QA-301). 카드 이름·규칙 계좌 감사는 그대로 남음 |
| B6 | QA 스택 확인(§14) → `main` 병합·CI → 서버 배포(꺼진 채) | 마이그레이션 확인은 QA 스택 대신 **로컬 postgres의 임시 DB**로 했습니다(2026-11-06 — 다른 세션의 QA 스택이 같은 포트로 떠 있어 건드리지 않음): V22 전 백업(11-04, 로컬 DB — 주문 23·결정 3·체결 23행)을 복원 → 모든 마이그레이션 적용 → 행 수 그대로·`target_local` 전부 NULL·새 표와 제약 확인 → 옛 판 백엔드의 문장 모양(`CHECKPOINT` 결정 넣기·`paper_checkpoints` ON CONFLICT)이 그대로 통함. 1분봉 고정본으로 장부 체결을 돌려 보는 일은 하지 않았습니다(장부 시험 `UsTimedFillsTest`·`KrLedgerTest`가 같은 경로). **병합·배포(스위치 꺼진 채)**: 2026-11-06 05:51 KST `main@2e9fd367` push — CI 6개 job 통과(첫 push `2470c8e7`은 비밀값 검사가 한국 켠 판 패킷 고정본의 지표 칸 키 `kospi200_night_scraped`를 오탐으로 잡아 `.gitleaksignore`에 지문 둘을 더함), JDK 21 컨테이너 `verify` 2,510개 통과. 06:00 KST Vultr 배포 — V23 적용(05:59:43), 계획 행 0·설정 v14 그대로(자유 시점 스위치·규칙 계좌 체결 시각 키 없음 = 꺼짐·기본값, 상한 40·예약 10), 컨테이너 여섯 정상·오류 0건. 배포 뒤 첫 미국 정기 결정(07:11~07:12 KST, 기준 거래일 11-05)은 세 계좌 모두 끈 판 그대로(계좌1 판 표시 없음, 계좌2 `c2-2`, 응답에 `intradayPlan` 없음). **켬**: 2026-11-06 07:28 KST 설정 v15(사용자 지시 — 미국·한국 네 Claude 계좌 모두. 바뀐 키 여덟: 스위치 넷·`claude.checkpoint` 끔·상한 60·예약 20·`claude2.maxCallsPerCycle` 4). 저장 때 남아 있던 것은 그대로입니다 — 한국 규칙 계좌 시가 대기 주문 2건, 그날 아침 끈 판 결정이 요청한 계좌2 장중 확인(11-06 세션 10:30 ET — 끈 판 작업이 그 판으로 부름). 켠 판의 첫 결정은 한국 11-06 22:30 KST(목표 세션 11-09), 미국 11-07 아침(기준 거래일 11-06, 목표 세션 11-09)이고 첫 장중 판단은 11-09 세션부터입니다. 그날(11-06) 미국 세션의 계좌1은 장중 확인이 없습니다(기존 12:00 ET 확인은 껐고, 켠 판의 장중 판단은 켠 판 결정이 예약해야 함). 첫 실행 확인 항목은 §12·§14 |
| 켜기 | 사용자 확인 뒤 시장별 저장 → §12-3 확인 | |
| ADR 0031 | 체결 창 개장 + 10분·켠 판 시가 제거(`ft-2`·`kr-ft-2`)·규칙 계좌 개장 10분 뒤·장중 판단 1~3회(보장·사건)·예산 70·30·5·장중 판단 effort | 구현 끝(2026-11-07, 브랜치 `claude/intraday-timing-2026-11`), 배포 2026-11-08 23:30 KST 예정 — §17 |

단계마다 같은 커밋에서 함께 고쳐야 `make test`가 통과하는 곳:

- **B1**: `DecisionTimingsLockTest`(마지막으로 timing CHECK를 다시 만드는 파일 — 번호를 글자로 박은 단언을 번호가 바뀌어도 되게, `UsTimedFills.TIMINGS`),
  `UsTimedFillsTest`·`UsPaperMarketTest`의 시점 목록(수집기 `store.TIMED_TIMINGS`와 대조 포함), `PaperStore.ready()`와 `PaperStoreDbTest`(거절 행 `AT_MINUTE` + NULL이 들어가는지 포함),
  `test_paper_bars.py`의 범위·장중 시장가 시험, `test_kr_paper_timed.py`, `PaperNotifyJobTest` 시점 이름, 주문을 복사하는 곳(`FakePaperStore`·`KrStartPipeline` — 지정 시각 칸을 떨어뜨리지 않게).
- **B2**: 끈 판 고정본 전부가 바이트 그대로(프롬프트·스키마·패킷·검증기), 키 목록을 단언하는 시험(`PaperSettingsServiceTest`·`PaperSettingsKrTest`·`PaperAdminKrInitTest`),
  켠 판 고정본(`render-us-ft-*`·`render-kr-ft-*`·`packet-us-ft-*`·`packet-kr-ft-scheduled.json`·`decision-schema-forapi-us-ft.json`), 켠 판 시험(`FreeTimingTest`·`FreeTimingDecisionTest`·
  `DecisionTimingsLockTest.freeTimingContextsAreLocked`·`KrStartTest.krFreeTimingDecisionsUseTheOnVariant`·`PaperDecisionJobClaude2Test`의 계좌1 가드 셋).
- **B3**: `test_table_ownership.py`(새 표), `PaperStore.ready()`(새 표), `test_paper_watch.py`·`test_paper_watch_kr.py`(계약 2), `RouteInventoryTest`·`AccessPolicyTest`·`docs/API.md`·`routes.json`·`endpoints.test.ts`,
  `PaperSettingsServiceTest`(상한 문구), ADR 0020 결정 6 문구.
- **B5**: `PaperQueryUsGoldenTest`(상태 응답 고정본 — 따로 뗀 커밋), `paperClaude2.test.ts(x)`·`paperAccount.test.ts`·`paperKrCheckpoint.test.ts`.

모든 커밋이 `make test`를 통과하고, 푸시 전에 CI와 같은 JDK 21 컨테이너로 백엔드를 한 번 더 돌립니다(`CLAUDE.md` '이 환경의 함정').

## 14. 시험·검증

- 장부: 미국·한국 `AT_MINUTE` 체결(사다리 칸마다), 닫힌 시점, 조기 폐장일, 서머타임 경계, 스탑 제외, 규칙 주문 다시 내기(수명 유지·감사 행 불변), 끈 판 계좌의 결과 불변.
- Claude 구간: 가짜 클라이언트로 결정 → 계획 행 → 장중 판단(유지·교체·`nextCheckpoint`·놓침·수동 당김·순번 소진 409·소상한·상한) → 주문·체결.
- 수집기: 스위치가 꺼진 동안 범위 불변, `AT_MINUTE` 창 키, 감시 계약 2(계획 둘·두 계좌가 겹치는 창), 한국 호출 상한.
- QA 스택(B6)에서 할 수 있는 것은 **장부·마이그레이션·되돌리기**까지입니다: 운영 백업 복원 → V22·V23 적용 → 1분봉 저장본 고정본과 주문 행 주입으로 장부 체결 → 옛 판 백엔드 기동(스위치 꺼짐).
  QA 스택은 Anthropic 키가 비어 있고 수집기 외부 호출이 차단 프록시라 Claude 호출과 1분봉 수집이 일어나지 않습니다 — **Claude 구간의 첫 실제 실행은 운영 서버입니다**(그래서 시장별로 켜고 첫 세션을 확인).

## 15. 모르는 것·위험

- Anthropic 구조화 출력이 새 스키마 모양(pattern이 붙은 선택 칸, 객체 배열 `checkpoints`)을 받는지 — B2에서 공식 문서로 확인합니다. 지금 근거는 저장소 검사기가 받는 키 목록뿐입니다.
- Yahoo 1분봉 `period="1d"`가 세션이 끝난 뒤·장 전에 어느 세션을 주는지(기존 미확인 X9). 세션이 끝난 뒤 생긴 `AT_MINUTE` 라벨이 그 세션 항목에 다시 계산되는지가 여기에 달려 있습니다.
- 미국 개장 + 5분 확인에서 1분봉 지연 때문에 '개장 뒤 세션 증거' 판정이 임시 휴장으로 잘못 떨어질 수 있는지(지연 분포 모름) — 켠 뒤 첫 주에 봅니다.
- 토스 1분봉의 숨은 하루 상한, 늘어난 호출이 한국 장부 입력(`kr_paper_quotes`)·실제 계좌 조회와 같은 래치·토큰을 공유하는지 — B1에서 코드로 확인합니다.
- 규칙 계좌 유니버스에서 Yahoo 1분봉의 빈 분 비율(대체 체결 비율).
- 규칙 주문을 다시 내는 방식이 결정별 주문 수 표시·알림·규칙 계좌 고정본에 주는 영향 — B4에서 끝까지 따라갑니다.

## 16. 읽기 전용 측정 (Vultr 서버, 2026-11-06 01:50 KST, main@7293d224)

- 설정 v14: `apiDailyCallCap` 40 · `apiScheduledReserve` 10 · 미국 결정 06:30 KST · 기한 12:00. `claude.checkpoint` 켬(12:00 ET), `claude2.enabled`·`claude2.checkpoints` 켬,
  `claude2.maxCallsPerCycle` 3, `kr.claude2.checkpoints`는 키 없음(코드 기본 켬). 설정 본문은 점 표기가 아니라 중첩 객체입니다.
- 프레임 v10(31,307자): 체결 시점 낱말이 든 줄은 고정 문단의 한 줄뿐이고 원칙·규칙 본문에는 `NEXT_*`·장중·시장가가 0번입니다.
- 계좌 열 개 모두 `ACTIVE`. 대기 주문은 `kr_rules`의 `NEXT_OPEN` 둘(규칙 1·스탑 1)과 `rules`의 `NEXT_OBSERVATION` 하나, Claude 계좌는 0건.
- `paper_checkpoints`는 0행 — 계좌2(미국·한국)는 장중 확인을 요청한 적이 없습니다. 미국 계좌1의 `CHECKPOINT` 결정은 3건(기준일 11-03까지).
- 최근 7일 체결: `claude2`는 `AT_1000`(R1 `Y1M_AT`) 8건뿐, `kr_claude2`·`kr_rules`는 `NEXT_OPEN`, `rules`는 `NEXT_OBSERVATION` 2건과 스탑 4건.
- Claude 호출: 11-03 6회 0.99달러, 11-04 6회 0.97달러, 11-05 7회 1.35달러 — 1회 약 0.16~0.19달러(제안·복기 포함 평균).

## 17. ADR 0031 개정 (2026-11-08 배포 예정)

결정은 [ADR 0031](../adr/0031-open-offset-window-intraday-budget.md)(구현에서 정한 것 포함)에 있고, 이 절은 숫자와 운영 순서만 적습니다. 위 절과 다르면 이 절이 맞습니다.

### 17-1. 바뀐 숫자

| | ADR 0027(2026-11-06 배포) | ADR 0031 | 바뀌는 때 |
|---|---|---|---|
| 결정의 `AT_MINUTE` 범위 | 미국 09:31~15:54 ET · 한국 09:01~15:19 KST | 09:40~15:54 ET · 09:10~15:19 KST(수능일 10:10~16:19) | 배포(켠 판 결정부터) |
| 켠 판 결정 메뉴 | `NEXT_OPEN`·`AT_MINUTE`·`NEXT_CLOSE`(`ft-1`·`kr-ft-1`, 메뉴 판 3) | `AT_MINUTE`·`NEXT_CLOSE`(`ft-2`·`kr-ft-2`, 메뉴 판 4) | 배포 |
| 켠 판 장중 시장가 | 개장 쪽 하한 없음 | 기준 시각 ≥ 개장 + 10분 | 배포 |
| 장중 판단 창·간격 | 개장 + 5분 ~ 마감 − 30분 · 30분 | 개장 + 10분 ~ 마감 − 30분 · 20분 | 배포 |
| 장중 판단 횟수 | 최대 2 | 최대 3(키 없으면 2)·최소 0~1·사건 | 설정 |
| 규칙 계좌 | 미국 다음 시간별 관측치 · 한국 다음 거래일 시가 | 설정으로 09:40 ET · 09:10 KST(개장이 늦은 날 그날 첫 분, 한국 대체·다시 내기는 다음 세션 첫 분) | 설정 |
| 호출 예산 | 상한 60 · 예약 20 · 소상한 4 | 70 · 30 · 5 | 설정 |
| effort | 모든 호출 `effort` | 장중 판단만 `intradayEffort` | 설정 |

- 정기 호출의 하루(KST) 최악: 한국 결정 2 + 재시도 2 + 장중 판단 6, 미국 결정 2 + 재시도 2, 미국 장중 판단은 자정을 걸친 두 세션 몫(EST 23:40~05:30 KST 창이라 하루에 8, EDT 22:40~04:30이라 12)
  → EST 22·EDT 26. 보장·사건은 최대 횟수 안이라 이 값을 늘리지 않습니다.
- 전환: 배포 전 `ft-1` 결정이 낸 대기 주문(`NEXT_OPEN`, `AT_MINUTE` 09:31~09:39 ET·09:01~09:09 KST)은 낸 그대로 체결되고, 그 결정이 예약한 장중 판단 09:35 ET·09:05 KST는 `SKIPPED OUT_OF_RANGE`입니다.

### 17-2. 새 칸

- V27: 결정 종류 `INTRADAY_3`, 계획 순번 1~3, 계획 행 `origin`(`RESERVED`·`NEXT`·`MANUAL`·`GUARANTEE`·`EVENT` — 기존 행은 한 번 채움)·`trigger`(JSONB — `{originalAt, events:[{type, ticker, …}]}`).
- 패킷(켠 판만): 장중 판단 `1_basis.origin`·`remainingJudgments`, 요청 `trigger`, `nextCheckpoint.replaces`·`laterReserved`. 결정 미국 `13_execution.intraday`·한국 `1_basis.intraday`의 `minPerSession`·`guarantee`·`events`.
- 상태 응답 `intraday`: `minPerSession`·`events`와 행마다 `origin`·`trigger`([API](../API.md)).

### 17-3. 배포 뒤 저장(시장별로 따로, 저장 때마다 사용자 확인, 요청에 Origin 헤더)

1. 미국 Claude: `{"apiDailyCallCap":70,"apiScheduledReserve":30,"claude2.maxCallsPerCycle":5,"intradayMaxPerSession":3,"intradayMinPerSession":1,"intradayEvents":true,"intradayEffort":"medium"}`
   (`effort` high·`claude.checkpoint` 끔·`*.freeTiming` 켬은 그대로 — `intradayEffort`는 두 책 공통이라 한국에도 바로 적용).
2. 미국 규칙 계좌·감시: `{"rules.timing":"AT_MINUTE","rules.timingAtEt":"09:40","stopWatch.mode":"ON"}`.
3. 한국 달력: `{"kr.calendar.openTimeOverrides":{"2026-11-19":{"open":"10:00","close":"16:30"},"2027-01-04":{"open":"10:00","close":"15:30"}}}`(2027-01-04는 12월 KRX 공지와 대조).
4. 한국 장중 판단: `{"kr.intradayMaxPerSession":3,"kr.intradayMinPerSession":1,"kr.intradayEvents":true}`.
5. 한국 규칙 계좌·감시(실제 돈 — [ADR 0033](../adr/0033-real-isa-open-offset-and-stops.md) 결정 5·10, 저장 전 서버 읽기 전용 확인): `{"kr.rules.timing":"AT_MINUTE","kr.rules.timingAtKst":"09:10","kr.stopWatch.mode":"ON"}`.

- 사건은 감시 저장본을 읽으므로 `intradayEvents`만 켜고 감시가 `OFF`면 아무 일도 없습니다(2·5와 함께 켬).

### 17-4. 배포 뒤 확인

- 장중 판단: `paper_job_runs` `intraday`·`kr.intraday`의 'PLANNED GUARANTEE 12:31 ET'·'11:31 KST'(그 세션에 예약·부른 판단이 없을 때만), 'EVENT PULL …(원래 HH:MM)'·'EVENT ATTACH'·'SUPPRESSED …',
  결정 응답 `checkpoint.origin`(`GUARANTEE`·`EVENT`)과 `usage.effort` medium, 패킷 `1_basis.origin`·`remainingJudgments`.
- 첫 `kr-ft-2` 결정(11-09 22:30 KST)과 첫 미국 `ft-2` 결정(11-10 06:3x KST)의 메뉴(시가 없음)·지정 시각 범위.
- 규칙 계좌 첫 `AT_MINUTE` 체결: 한국 11-10 09:10(그날 밤 장부), 미국 11-10 09:40 ET(다음 관측치). 결정 기록의 `timing`·`timingSetting`.

### 17-5. 되돌리기

1. 설정만(몇 초): `intradayMinPerSession`·`kr.intradayMinPerSession` 0, `intradayEvents`·`kr.intradayEvents` 꺼짐, `intradayMaxPerSession`·`kr.intradayMaxPerSession` 2, `intradayEffort`는 `effort`와 같은 값
   (설정 API는 키를 지우지 않음), 예산 60·20·4, 규칙 계좌 기본 시점(`rules.timing` `NEXT_OBSERVATION`·`kr.rules.timing` `NEXT_OPEN`).
2. 코드: 1 → `scripts/rollback/intraday-slot3.sql`(순번 3 `PLANNED` 행을 닫음 — 옛 코드는 순번 3을 부르지 못함, 끝의 SELECT가 남는 `INTRADAY_3` 결정 행을 계좌별로 셈) →
   알렸지만 아직 적지 않은 ISA 스탑 지시(`manual_stop_instructions`의 `PLANNED`·`notified_at` 있음)가 0인지 읽기 전용으로 확인(`count(*)`라 늘 한 줄이 나오므로 그 값이 0인지로 보고,
   0이 아니면 자동 기록을 기다리거나 사용자가 ISA 장부에 직접 적은 뒤 — 명령과 두 길은 ADR 0033 '되돌리기', 옛 코드는 그 지시를 몰라 이미 판 주식을 다시 팔라고 알림, QA-333) → `git revert`
   (ISA 스탑 지시 수와 상관없이 순번 3 SQL 끝의 SELECT(`INTRADAY_3` 결정 행)가 한 줄이라도 내면 같은 커밋에 호환 줄 —
   `RuleBookService.intraday`를 `INTRADAY_` 접두로, `ExecutionView`·`claude2CallsInCycle`의 종류 목록에 `INTRADAY_3`, QA-311·ADR 0031 '되돌리기' —
   없으면 옛 코드가 그 행을 정기 결정으로 읽어 다음 결정 패킷의 8b watchlist가 빔) → 거래 창 밖 배포. V27은 남겨도 됩니다.
