# 차단 통과 수집 계층 명세 (2026-11-05)

결정과 이유는 [ADR 0026](../adr/0026-polite-fetch-layers.md)에 있습니다. 이 문서는 세 층(수집기·백엔드·화면)과 브라우저 컨테이너가 따르는 구조·수치·단계입니다.
수치는 초기값이고 서버에서 잰 뒤 고치면 이 문서의 표를 함께 고칩니다.

## 0. 사용자 결정 (2026-11-05)

| 번호 | 질문 | 결정 |
|---|---|---|
| C1 | 처음 연결할 자료 | TradingView 경제 캘린더, 인베스팅닷컴 경제 캘린더, 인베스팅닷컴 뉴스 HTML, KRX 정보데이터시스템(넷 다) |
| C2 | 브라우저 계층의 형태 | 요청 때만 브라우저를 띄우는 별도 컨테이너 |
| C3 | 출구 IP | 서버 IP 하나. 통과하지 못하면 그 출처를 포기 — 자택 회선·프록시로 구현하지 않음(승인 때 수정) |
| C4 | 사람 확인(CAPTCHA) | 풀지 않음 — 멈추고 직전 값 유지 + 알림 |
| C5 | 서버 크기(D29 조건 ④) | Vultr 4 GB 그대로 |
| — | 계획에서 권장안으로 둔 것 | User-Agent 무작위화 대신 호스트별 고정 프로필 · 새 자료는 운영자 화면 전용(패킷 불변) · 체크박스형 사람 확인도 누르지 않음 |

## 1. 구조

```
polite 틱(5분 + 지터) ── 때가 된 태스크만 ──> 태스크(collector/app/tasks/…)
                                                │  fetch.ladder.fetch(url)
                                                ▼
                    계층 0  fetch.state(닫힘·예산·일정) + fetch.pacing(지연)
                    계층 1  fetch.impersonate (curl_cffi, 호스트별 고정 프로필)
                    계층 2  fetch.browser_client ──HTTP──> 브라우저 컨테이너(Vultr 덧붙임에만)
```

- 새 패키지 `collector/app/fetch/` — `policy.py`(호스트 정책 표), `pacing.py`(지연), `state.py`(닫힘·예산·일정 규칙), `ladder.py`(계층 올라가기·판정),
  `impersonate.py`(계층 1), `browser_client.py`(계층 2 호출). SQL은 기존 관례대로 `collector/app/store.py`에 둡니다.
- 기존 세션(`get_session`·`get_fred_session`·`get_sec_session`·`get_bls_session`·`get_api_session`·`publicapi`·Yahoo)은 바꾸지 않습니다.
- 새 계층은 `http.reject_host`·`http.check_host`를 실제 호스트 이름으로 부르지 않습니다(ADR 0026 결정 2). 판정에는 `http.rejection_reason`의 표지를 입력 가운데
  하나로만 씁니다.
- 의존성: `curl_cffi`를 `collector/requirements.txt`에 직접 의존으로 올립니다(코드가 직접 import). 판은 `constraints.txt`에 이미 고정된 것과 같게 하고
  `constraints.txt`는 다시 만들지 않습니다 — 다시 만들면 다른 간접 의존성이 그날 판으로 움직입니다(2026-11-04 선례).

## 2. 판정과 계층 올라가기

응답 하나의 판정은 다섯 가지입니다.

| 판정 | 근거 | 다음 |
|---|---|---|
| 정상 | 2xx이고 정책이 기대한 모양(`html`·`json`) | 저장, `fail_level` 0, 그 계층을 `last_good_tier`로 |
| 거부 | 403·429, 차단 페이지 표지, JSON을 기대했는데 HTML | 지연 뒤 위 계층으로 한 번. 더 올라갈 곳이 없으면 물러남 |
| JS 검사 | `cf-mitigated: challenge` 등 챌린지 머리글·본문 표지 | 계층 2로(없으면 물러남) |
| 사람 확인 | 계층 2가 돌려준 `challenge: human` | 12~24시간 닫음 + 알림(ADR 0026 결정 5) |
| 그 밖 | 404·5xx·시간 초과·모양 다름 | 그 실행만 실패(물러남 없음 — 출처의 거부가 아님) |

- 사람 확인은 계층 2만 판정합니다(계층 1 응답만으로는 JS 검사와 가르지 못함).
- 한 실행에서 계층을 올라가는 것은 한 번뿐이고 같은 계층을 다시 보내지 않습니다.
- 브라우저 컨테이너에 닿지 못한 것(주소 없음·연결 실패·비밀 불일치)은 출처의 거부가 아니라 '계층 2 없음'으로 세고, 그때는 계층 1의 거부가 최종입니다.

## 3. 닫힘·예산·일정 (표 `fetch_hosts`·`fetch_schedule`, 마이그레이션 V21)

| 항목 | 값 |
|---|---|
| 거부 뒤 물러남 | 1회 30~60분 · 2회 3~6시간 · 3회 이상 12~24시간(구간 안 무작위) · 성공하면 0 |
| 포기 | 연속 5회 — 운영자가 풀 때까지 다시 시도하지 않음(`given_up`) |
| 사람 확인 | 12~24시간 닫음, `fail_level`은 올리지 않음 |
| 하루 예산(KST 날짜) | `www.investing.com` 60 · `economic-calendar.tradingview.com` 12 · `data.krx.co.kr` 40 |
| 요청 사이 지연 | 로그정규(중앙값 7초)에서 뽑아 4~15초로 자르고 ms 잡음, 10%는 20~45초 |
| 프로필 | 호스트를 처음 만날 때 후보 가운데 하나를 뽑아 고정, `curl_cffi` 판이 바뀔 때만 다시 |

- 재기동해도 이어집니다. 쿠키는 메모리에만 두고(재기동하면 사라짐) 프로필은 유지합니다.
- 포기·닫힘을 운영자가 푸는 방법은 [DATA_SOURCES](../DATA_SOURCES.md)에 적습니다(표의 그 호스트 행을 지움).
- 예산·닫힘·일정을 지키는 곳은 계층(`fetch.ladder`)과 태스크 머리입니다 — 틀 밖 실행(수동 단일 실행, 전체 수집)도 같은 규칙을 지납니다.

## 4. 일정

- 속도군 `polite`, 태스크 시간 상한 900초. 기존 속도군 목록(주기 설정·`/collect?group=`·`/status`의 주기 표)에는 넣지 않습니다.
- 스케줄러에 틱 하나(5분 + 지터 0~120초)를 따로 등록하고 `next_run_time`을 주지 않습니다 — 기동 직후 실행하지 않습니다.
- 틱은 `fetch_schedule.next_due_at`이 지난 태스크만 이름으로 실행합니다. 행이 없으면 첫 실행 시각을 그 태스크 구간 안에서 무작위로 정해 넣고 그 틱은 건너뜁니다.
- 태스크는 시작할 때 스스로 때를 확인하고, 아니면 외부를 부르지 않고 `EmptyResult`로 끝납니다(session 군 선례). 끝나면(성공·실패 모두) 다음 시각을 정합니다.
- 태스크 안에서 시간 예산이 모자라면 서두르지 않고 남은 것을 다음 회차로 넘깁니다.

| 태스크 | 다음 실행 간격 | 한 번에 |
|---|---|---|
| `econ_calendar_tradingview` | 3~6시간 | 요청 1건 |
| `econ_calendar_investing` | 5~8시간 | 1~3건 |
| `news_investing_html` | 3~5시간 | 분류 페이지 4건(순서 섞음) |
| `krx_investor_flows` | KR 거래일 장 마감 뒤 하루 1회(18:10~19:30 사이 무작위) | 10건 안팎 |

## 5. 브라우저 컨테이너

- 위치 `collector/sidecar/`(`guard.py` 문지기 · `app.py` 내부 서비스 · `driver.py` 브라우저 드라이버 · `Dockerfile` · `pinned.txt` · `seccomp.json`).
  시험은 `collector/tests/`에서 가짜 드라이버로 돌립니다(CI job 수는 그대로 — 이미지는 `images` 잡의 Vultr 덧붙임 단계가 빌드).
- compose: `compose.vultr.yml`에만 서비스 `browser`를 정의합니다. 기반·QA에는 없습니다. 포트 미게시, 새 망 `fetchnet`에 `collector`(기본 망과 함께)와 `browser`만,
  `browser`는 기본 망에 붙이지 않습니다(postgres·backend에 닿지 못함).
- 환경: 기반 compose `BROWSER_FETCH_URL: ""`(보간 없음), Vultr 덧붙임 `"${BROWSER_FETCH_URL:-}"` — 서버 `.env` 한 줄로 켜고 끕니다. `BROWSER_FETCH_TOKEN`은
  서버에서만 만들어 서버 `.env`에 둡니다. 토큰이 없으면 컨테이너는 뜨되 모든 요청을 거절합니다(배포가 멈추지 않게).
- API: `POST /fetch {url, wait}` → `{status, finalUrl, contentType, body, challenge}`. 임의 스크립트·클릭 입력은 받지 않습니다.
- 보호: 공유 비밀, 최상위 이동은 허용 호스트만, 리다이렉트·하위 요청이 전역 주소가 아닌 목적지(사설·루프백·링크 로컬·CGNAT 대역)면 중단, 내려받기·서비스 워커 끔,
  동시 1건, 요청당 90초 상한.
- 브라우저는 요청마다 띄우고 닫습니다. 프로필(쿠키)은 이름 있는 볼륨에 둡니다. 크래시 보고·배경 통신·구성요소 갱신을 끕니다.
- 굳히기: 비root, `cap_drop: [ALL]`, `no-new-privileges`, `mem_limit: 1g`, `init: true`. Chrome 샌드박스는 켭니다 — 도커 기본 seccomp은 권한을 뺀 컨테이너에서
  사용자 네임스페이스와 그 안의 `chroot`를 막아 Chrome이 뜨지 않으므로, 그 넷(`clone`·`setns`·`unshare`·`chroot`)만 더한 프로필 `collector/sidecar/seccomp.json`을 씁니다
  (Playwright의 `utils/docker/seccomp_profile.json` + `chroot`). 2026-11-06 개발 PC 확인: 기본 seccomp은 실패, Playwright 프로필만으로도 실패, `chroot`를 더하면 성공.
  빈 페이지 하나에 약 2초·메모리 정점 368 MiB. 서버에서 뜨지 않으면 서버 `.env`의 `BROWSER_SANDBOX=false`로 끄고 ADR 0026에 적습니다.
- 드라이버는 인터페이스 뒤에 둡니다(`sidecar/app.py`의 `Driver`). patchright 1.64.4(Apache-2.0, 2026-11-06 PyPI 확인)와 Chrome 안정 채널(이미지 빌드 때 받음 — 판을
  고정하지 않음)을 씁니다. 의존성은 간접 의존성까지 `collector/sidecar/pinned.txt`에 고정하고 CI의 pip-audit가 함께 봅니다. 대안은 SeleniumBase CDP 모드.
- 배포: `scripts/vultr/deploy.sh` 빌드 목록과 그것을 고정한 시험·문서(여섯 곳)를 함께 고칩니다.

## 6. 출처

공통: 실패하면 직전 저장본을 유지합니다(`EmptyResult`). 저장본에 `source`·`collectedAt`·`fetchTier`를 싣습니다. HTML은 BeautifulSoup/lxml로 읽습니다.

1. **TradingView 경제 캘린더** `econ_calendar_tradingview` — `economic-calendar.tradingview.com/events`(미국·한국), 계층 1.
   `calendar.us_consensus`의 "TradingView는 403 — 머리글을 바꾼 재시도는 하지 않음" 문구와 그 시험을 이 단계에서 고칩니다(G11의 '사용자 허락 뒤에만'은 이번 요청이 그 허락).
2. **인베스팅닷컴 경제 캘린더** `econ_calendar_investing` — 한국·미국, 예상·이전·실제·중요도. 계층 1 → 2.
3. **인베스팅닷컴 뉴스 HTML** `news_investing_html` — `/news/…` 네 분류. 패킷이 읽는 `news_headline`과 다른 데이터셋에 저장합니다. 계층 1 → 2.
4. **KRX 정보데이터시스템** `krx_investor_flows` — 전 종목 투자자별 수급.
   - 먼저 서버 `.env`에 `KRX_ID`·`KRX_PW`를 넣어 기존 pykrx 경로가 풀리는지 봅니다(코드 변경 없음). pykrx는 가져올 때 로그인하므로 수집기 기동마다 3건이 나가고
     이 경로에는 예산·물러남·고정 프로필이 걸리지 않습니다.
   - 풀리지 않으면 계층 1로 필요한 조회를 직접 부르고 자기 저장본에만 씁니다. 그때는 pykrx 단계와 둘 중 하나만 씁니다.
   - 레이더는 그 저장본을 '기준일이 조회 날짜와 같고 장중이 아닐 때만' 앞 순위로 읽습니다(레이더 태스크 안에서 지연이 든 호출을 하지 않음).
   - 공매도는 이번 범위가 아닙니다.

인베스팅닷컴 두 태스크는 RSS 피드가 거부당하고 있으면 실행하지 않습니다(ADR 0026 결정 11).

## 7. 백엔드·화면

- 데이터셋 이름은 `collector/app/catalog.py`·`backend/.../store/Datasets.java`·`DatasetsParityTest` 세 곳을 같은 커밋에서 고칩니다.
- 읽기 경로 둘(경제 캘린더, 헤드라인 — 인베스팅닷컴)은 운영자 전용이고 저장본만 읽습니다(태스크 이름 없이 — 화면 조회가 수집을 일으키지 않음).
- 화면: 매크로 화면에 운영자에게만 보이는 카드 둘. 출처·수집 시각·'우회 수집' 표기는 기존 출처 캡션 패턴에 얹습니다. 없는 값은 '—'.
- 알림: 사람 확인으로 닫히거나 포기로 넘어가면 텔레그램 한 통. 보내기는 기존 `feature.paper.PaperTelegram`을 그대로 쓰고(옮기지 않음), 보낸 자리는 백엔드가 가집니다.
  `PAPER_ENABLED`와 무관하게 돕니다.

## 8. 시험

- 계층·지연·예산·물러남·포기: 가짜 시계·난수와 127.0.0.1 `ThreadingHTTPServer`(기존 `test_http_guards.py` 방식).
- 공용 래치와 분리: 새 계층이 거부당한 뒤에도 같은 호스트의 공용 세션 요청이 나감.
- 프록시 인자를 넘기지 않음, 프로필이 재기동 뒤에도 같음.
- 일정: 기동 직후 실행 없음, 때가 아니면 외부 호출 0, 다음 시각이 구간 안.
- 브라우저 컨테이너: 가짜 드라이버로 비밀·허용 호스트·목적지 차단·사람 확인 돌려주기. CI는 이미지 빌드와 compose 해석 단언까지(브라우저 실행 없음).
- 백엔드: 새 표를 `ArchitectureRulesTest`의 수집기 표 목록에 더함, 새 경로의 `AccessPolicy`·`RouteInventoryTest`·`docs/API.md`·`scripts/qa/routes.json`,
  읽기가 수집을 요청하지 않음.
- 실제 사이트 확인은 자동 작업이 직접 하지 않습니다(ADR 0026 '결과와 남은 위험'). 배포 뒤 수집기의 실행 기록으로 통과 계층과 거부를 봅니다.

## 9. 단계

| 단계 | 내용 | 상태 |
|---|---|---|
| A0 | ADR 0026 · 이 명세 · 결정 기록 | 끝 |
| A1 | `fetch` 코어(정책·지연·상태·계층) + 계층 1 + V21 | 끝 |
| A2 | `polite` 속도군과 틱 + TradingView 경제 캘린더 | 끝 |
| A3 | 브라우저 컨테이너(앱·이미지·compose·배포 스크립트·CI 단언) + 계층 2 호출 | 끝(서버 기동·메모리는 첫 배포 때 확인) |
| A4 | 인베스팅닷컴 경제 캘린더 | |
| A5 | 인베스팅닷컴 뉴스 HTML + RSS 보호 | |
| A6 | KRX 정보데이터시스템 | |
| A7 | 백엔드 읽기 경로 · 매크로 화면 카드 | |
| A8 | 닫힘·포기 알림 | |
| A9 | 문서 마무리(DATA_SOURCES·PRINCIPLES·README·CLAUDE.md 등) · 병합 · 배포 | |

- 태스크를 등록하는 커밋마다 태스크 수 단언과 문서 숫자를 함께 올립니다. 모든 커밋이 `make test`를 통과합니다.
- 마이그레이션 번호는 V21로 확정합니다(다시 매기지 않음).

## 10. 남은 확인

- 서버 IP에서 출처별로 어느 계층이 통과하는지 — 배포 뒤 실행 기록.
- 인베스팅닷컴 두 페이지의 실제 응답 모양 — 운영자가 브라우저에서 저장해 준 페이지(저장소 밖에 둠) 또는 배포 뒤 확인.
- 서버 `.env`의 `KRX_ID`·`KRX_PW` — 2026-11-05 기준 로컬 `.env`에만 있음. 첫 배포 때 서버에 덧붙이고 pykrx 경로가 풀리는지 확인.
- 브라우저 컨테이너가 굳히기 설정에서 뜨는지, 메모리 사용량.
