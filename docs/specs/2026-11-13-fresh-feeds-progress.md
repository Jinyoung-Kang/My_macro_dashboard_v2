# 수집 신선도 개선 — 진행 기록 (2026-11-13~)

지시문: [2026-11-13-fresh-feeds-exec-instructions.md](2026-11-13-fresh-feeds-exec-instructions.md) · 프롬프트(승인):
[2026-11-13-fresh-feeds-exec-prompt.md](2026-11-13-fresh-feeds-exec-prompt.md) · 결정: [ADR 0040](../adr/0040-fresh-feeds.md).
계획 기준 커밋 `main@0c2bcfeb`(프롬프트 파일을 넣은 커밋). 작업 브랜치 `claude/fresh-feeds-2026-11`.

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | C1 조건부 요청 + C2 피드별 간격·흔들림 | 구현·시험 끝, main·CI·배포는 아래 §2 |
| 2 | B 경제지표 실제치 발표 직후 | 단계 1 배포 뒤 시작 |
| 3 | C3 결정·판단 직전·발표 직후 뉴스 | 단계 1 배포 뒤 미국·한국 각 2거래일 관찰 뒤 |
| 4 | A VIX 실시간 — 사전 검증부터 | 2026-11-16(월) 미국 정규장(23:30 KST~) 이후 |

## 0. 시작할 때 기준선 (2026-11-13 21:2x~21:4x KST, `main@0c2bcfeb`)

- `make test`(이 PC, JDK 25): 수집기 ruff 통과 + pytest **2412 통과 · 36 건너뜀 · 647초**, 백엔드 **3287 통과 · 실패 0**, 화면 vitest **157파일 2173 통과**,
  lint·build 통과. 전체 16분 29초. 지시문 §6의 기준선(`main@b5be1c3d`)과 같습니다(그 뒤 커밋은 문서뿐).
- 건너뛰는 36개는 이 PC에 `psql`이 없어서입니다(CI에서는 돔).

## 1. 사전 확인 — 서버에서 조건부 요청 (2026-11-13 21:2x KST, 피드마다 두 번)

수집기 컨테이너 안에서 수집기와 같은 세션(같은 UA·래치·간격)으로 첫 요청 → 그 응답의 검증 값을 붙인 둘째 요청. 같은 호스트 사이 3초.

| 피드 | 첫 요청 | 검증 값 | Cache-Control | 둘째(조건부) |
|---|---|---|---|---|
| investing_stock·ind·economy·forex | 200 (약 4.6~4.8KB) | 약한 ETag `W/"…"` + Last-Modified(넷 모두 같은 시각) | 없음 | **304** (304에는 ETag가 없음 — 직전 값을 이음) |
| fed_monetary | 200 (9.8KB) | ETag + Last-Modified | 없음 | **304** |
| bls_cpi·bls_empsit | **403** | — | — | (거부 래치로 둘째 요청 안 나감) |
| sec_press | 200 (18.6KB) | ETag + Last-Modified | `public, max-age=42` | **304** |
| bok_press | 200 (225KB) | 없음 | `no-cache` | 200 — **본문이 요청마다 다름**(해시 건너뛰기 안 됨, 늘 읽음) |
| mofe_press | 200 (15.8KB) | 없음 | 없음 | 200 — 본문 같음(해시 건너뛰기) |
| mods_press | 200 (16.7KB) | 없음 | 없음 | 200 — 본문 같음(해시 건너뛰기) |
| yna_market | 200 (85KB) | ETag + Last-Modified | 없음(Age 있음 — CDN) | **304** |

- **BLS 403**: 운영 저장본 `news.headlines.status`의 BLS 두 줄은 `lastOkAt` 2026-10-25T19:56:59Z(AWS 시절) 뒤로 한 번도 받지 못했고, 매시 실행이
  '거부됨 … BLS 차단(UA)'으로 남아 왔습니다(이 작업 전부터 — 결함 기록에는 없던 것). UA를 바꾸거나 우회하지 않습니다(지시문 §5). 새 구조에서는
  거부가 이어지면 그 피드 간격이 8배(8~16시간)까지 늘어 하루 2~3회만 묻습니다. 패킷은 지금처럼 '수집 실패 중인 피드'로 적습니다.
  단계 3의 'BLS 발표 직후 한 번 더'(C3)는 BLS가 막혀 있는 동안 의미가 없습니다 — 단계 3에서 다시 판단합니다.

## 2. 단계 1 — C1·C2 (2026-11-13 착수)

### 한 일 (요약 — 코드는 파일:심볼)

- 새 속도군 `flex`: `collector/app/tasks/flex.py`(1분 틱 상수·`fetch_schedule`의 `태스크/항목` 일정), `runner.run_flex_due`, `main._run_flex_job`
  (interval 60초 + 지터 10초, 기동 직후 돌지 않음, 유예 30초), `base.Task.due`.
- 피드 규칙: `collector/app/tasks/news_feeds.py` — `CADENCES`(지시문 C2 표 그대로)·`is_active`·`next_window_start`·`draw_next`·`hold_until`·`plan`·
  `any_due`·`fetch`(요청 전에 다음 시각을 먼저 적음)·`settle`(피드 줄)·`merge`(합본).
- 조건부 요청: `services/news.fetch_feed_conditional`·`FeedReply`·`cache_max_age`, `FeedFetchError.rejected·retry_after`,
  `http.SourceRejected.retry_after`·`http.retry_after_seconds`(거부 응답의 Retry-After를 예외에 실음 — 래치는 그대로).
- 두 태스크(`tasks/news.task_news_headlines`·`tasks/kr_news.task_kr_news_headlines`): 저장 규칙은 그대로, 때가 된 피드만 받고 상태는 피드별 합본.
- 미국 휴장일: `collector/app/uscalendar.py`(백엔드 `UsMarketCalendar` 규칙을 옮김).
- 화면: `frontend/src/lib/info.ts` 주기 글 `flex`.
- 문서: ADR 0040, DATA_SOURCES §1(flex 군)·사건 뉴스 절, API.md(`/api/paper/status`의 news 칸 뜻, `/api/info/mechanism`의 schedule), ARCHITECTURE(표),
  README(데이터 출처 줄), 백엔드 주석 셋(`NewsEvents.STALE_AFTER`·`KrCollectionStatus`·`PaperQueryService.newsStatus` — 동작 그대로).

### 지시문과 다르게 하거나 정한 것

- **저장(E-4)**: 새 표 없음. 피드별 다음 시각은 `fetch_schedule`(`news_headlines/<피드>`), 검증 값·물러남·셈은 상태 저장본의 피드 줄.
- **받은 피드가 없는 실행의 상태 저장본**: 예전 '전부 실패면 상태를 건드리지 않음'을 '실패한 피드의 줄만 고쳐 씀(다른 칸·generatedAt 그대로,
  저장본이 없으면 쓰지 않음)'으로 바꿨습니다(ADR 0040 결정 4). 피드를 하나씩 받게 되어, 그대로 두면 한 피드만 받는 실행의 실패가 어디에도 남지
  않아 패킷의 '수집 끊긴 피드' 메모가 뜨지 않습니다. CLAUDE.md '직전 저장본의 값을 버리지 않는다'는 그대로 지킵니다(버리는 칸 없음).
- **미래 시각으로 미룬 항목**(구현 중 시험이 찾음): 직전 본문에 '하루 넘게 미래'라 넣지 않은 항목이 있으면 304·같은 본문으로 건너뛸 때 그 항목이
  시간이 지나도 들어오지 않습니다. 그 피드는 검증 값을 보내지 않고 다시 읽게 했습니다(`news_feeds._pending`).
- **할 일 없던 틱(E-5)**: 기록하지 않음(polite 관례 — 틱이 `due()`를 먼저 물음). 요청이 나간 실행만 한 줄씩.
- **틱 1분**: 지시문은 5분 틱도 허용했지만 단계 2·3의 몇 분 창 때문에 처음부터 1분.
- 시간 상한으로 보내지 못한 피드는 '실패'로 적지 않습니다(요청하지 않았으므로) — 일정을 건드리지 않아 다음 틱이 다시 고릅니다.

### 검토(2026-11-13 22시대, 관점 넷 + 지적마다 반박 검증 — 16개 에이전트)

반박을 견딘 10건(모두 낮음~중간)을 고쳤습니다. 기각 2건(재기동 뒤 밀린 피드를 첫 틱에 함께 받음 — 처음 흩기는 일정이 없는 피드에만,
'작동 방식' 화면이 피드 일정을 그리지 않음 — ADR은 API 칸을 말함).

| 지적 | 고친 것 |
|---|---|
| 하한을 실행 시작 시각에서 재 같은 호스트 둘째 피드가 몇 초 일찍 물릴 수 있음 | 피드마다 실제로 보낸 시각(`fetch(wall=…)`·`Outcome.requested_at`)에서 잼 |
| max-age·Retry-After 상한 없음(몇 해 멈춤·시각 계산 넘침) | 하루까지만 따름(`SERVER_WAIT_CAP_SECONDS`) |
| 429의 Retry-After가 한 피드에만 걸림(같은 호스트 형제는 계속 물음) | 거부되면 같은 호스트의 다른 피드를 그 실행에서 보내지 않고 기한 뒤로(`_hold_siblings`) |
| 래치로 나가지 않은 요청을 요청·거부로 세고 물러남을 올림 | 보내기 전에 래치를 보고 미룸, 사이에 걸린 래치는 `SourceRejected.latched`로 가려 미룸 |
| Retry-After의 비ASCII 숫자(`²`)에서 ValueError — 래치 전에 터짐 | `isascii()` 확인 |
| 받은 것 없는 실행이 머리의 nextFeed·nextDueAt을 낡은 채 둠 | 일정 표에서 다시(`head_next`) |
| 받은 것 없는 실행이 저장 시각을 바꿔 상태 화면 '오래됨'을 가림 | 내용만 고침(`store.update_snapshot_payload`) |
| BLS만 도는 실행이 태스크 '실패'로 깜박이고 실패 글마다 시각이 달라 묶이지 않음 | 다른 피드가 정상이면 성공(실패를 적음), 실패 글에서 다음 시각을 뺌 |
| 한국 패킷의 '끊긴 피드' 메모가 둘째 계좌부터 빠질 수 있음(저장본이 읽은 순간 뒤에 바뀜) | **단계 3에서 고침** — 지금 한국 피드는 모두 정상이라 실제 영향 없음(ADR 0040 '남긴 한계') |

### 시험

- 새 시험: `test_news_feeds.py`(45), `test_uscalendar.py`(7), `test_group_schedule.py`(flex 틱 2), `test_http_guards.py`(Retry-After 8),
  화면 `info.test.ts`(주기 글 1). 기존 `test_news_headlines.py`·`test_kr_news_headlines.py`는 '받을 피드 고르기'를 '모두 때가 됨'으로 고정하고
  바뀐 상태 칸·실행 기록 글에 맞춤.
- `make test`(2026-11-13 22:1x~22:3x KST, 이 PC JDK 25): 수집기 ruff 통과 + **2482 통과 · 36 건너뜀**(기준선 2412 + 새 시험 70), 백엔드
  **3287 통과**, 화면 **157파일 2174 통과**(+1), lint·build 통과. 19분 30초.
- 커밋은 넷(휴장일 옮김 → 수집기 → 화면 → 문서·주석). 앞 셋은 서로 다른 묶음만 바꾸고, 백엔드 대조 시험(태스크 수·데이터셋 이름·뉴스 피드 키)이
  읽는 값은 이 단계에서 바뀌지 않아 각 커밋도 같은 결과입니다.

### 배포·관찰

- (배포 시각·첫 실행·304 비율·하루 요청 수·거부 수는 배포 뒤 채움)

## 남은 일

- 단계 1: main·CI·배포, 배포 뒤 관찰(미국·한국 각 2거래일).
- 단계 2(B): 단계 1 배포 뒤.
- 단계 3(C3): 관찰 끝난 뒤 — BLS가 막혀 있으면 'BLS 발표 직후' 부분은 다시 판단.
- 단계 4(A): 2026-11-16(월) 23:30 KST 이후 서버에서 사전 검증.
