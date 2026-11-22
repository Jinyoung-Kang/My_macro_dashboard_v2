# 0048. 13F 즐겨찾기 기관 — 기본 12곳은 그대로, 운영자가 더한 기관(백엔드 표)을 13F 화면·기관 상세에, 모의 매매·AI 리포트 원문에는 넣지 않음

- 상태: 채택 (2026-11-23, 사용자 결정 — 계획 세션 [실행 명세](../specs/2026-11-23-13f-favorites-institution-detail.md) §2. 단계 2 구현·배포 2026-11-23)
- 함께 보는 결정: [ADR 0008](0008-backend-owned-tables-and-scheduled-jobs.md)(표마다 쓰는 프로세스 하나), [ADR 0010](0010-accounts-and-db-sessions.md)(접근 표),
  [ADR 0018](0018-paper-trading-guardrails.md)(모의 매매 입력), [ADR 0042](0042-workbench-ui.md) 2026-11-23 덧붙임(기관 상세 보강 — 같은 명세의 단계 1)
- 지키는 방법(시험): 백엔드 `ArchitectureRulesTest.paperSnapshotAiDoNotReadFavorites`(feature.paper·snapshot·ai가 즐겨찾기 표·저장소·카탈로그·서비스를 참조하지 않음 — 불변식 1),
  `Sec13FCandidatePortfolioTest`(즐겨찾기 읽기 규칙 — q30 먼저·없으면 q8 모두 수집 없이, 후보면 q8을 찾지 않음, 저장본 없으면 400이 아니라 '아직 모으지 못함', 즐겨찾기 밖은 그대로 400),
  `Sec13FFavoriteServiceTest`(CIK 검사·운영자만·기본 12곳·중복·상한·원본 13F-HR 확인·수집 네 갈래·실패면 넣지 않음·캐시 비움), `Sec13FFavoriteStoreDbTest`(표·저장본 머리),
  `AccessPolicyTest`·`RouteInventoryTest`(`scripts/qa/routes.json`)·`docs/API.md`. 수집기 `test_sec13f_favorites.py`(대상 합치기·후보와 선행 CIK·기본 CIK 제외·단건 수집·실패 시 저장본 유지·빠진 저장본 목록),
  `test_sec13f_lookup.py`(EDGAR 회사 검색 atom·submissions — 고정 자료), `test_table_ownership.py`(`sec13f_favorites`는 백엔드 표, 읽는 곳은 `store.sec13f_favorites` 하나), `test_api_token.py`(새 경로 셋 토큰).
  화면 `institutionsFavorites.test.tsx`(두 목록·고름 하나·처음 요청 그대로·운영자 편집·찾기는 누를 때만·CIK 직접·실패 사유·지우기 확인), `institutionFavorites.test.ts`(상한·검색어 상한이 백엔드 상수와 같음·팔레트),
  `endpoints.test.ts`. 13F 화면 기존 시험(`institutionsRequests`·`institutionsScreenStates`·`institutionsQuotePopup`)은 고치지 않고 통과.

## 배경

13F 화면의 기관은 상수 두 곳(수집기 `indicators.INSTITUTIONS`, 백엔드 `Institutions.ALL`)의 12곳뿐이었다. 사용자가 다른 13F 보고 기관을 화면에서 더하고 지우기를 요청했다(2026-11-23).
그런데 이 12곳 상수는 13F 화면 밖에서도 쓰인다 — AI 리포트 원문의 교집합(`SnapshotTextService.appendSec13F`), 모의 매매 그룹 B 후보(`PaperSelectionService.groupBCandidates` — 선정·
후보 표·패킷의 이름·설명, `blend.groupB.topN` 상한 1~12). 그리고 모의 매매는 풀 기관의 13F를 'q30이 있으면 그것, 없으면 q8'로 읽는다.

## 결정

1. **기본 12곳은 그대로**(사용자 결정 — 숨기기·삭제 없음). 상수 두 곳(`Institutions.ALL`·`indicators.INSTITUTIONS`)을 고치지 않는다. 편집은 새 목록 **'즐겨찾기'**에서만.
2. **즐겨찾기는 백엔드 표**(V43 `sec13f_favorites` — CIK 10자리 유일, SEC 등록 이름, 표시 이름·설명(선택), 더한 시각·사용자). 백엔드만 쓰고 수집기는 읽기만 한다(ADR 0008 — `search_watches` 선례).
   사용자별이 아니라 하나의 목록, **상한 20곳**(`InstitutionCatalog.FAVORITE_LIMIT`, 최악 경우 부하는 단계 3에서 재고 넘치면 낮춤). 편집(이름 검색·더하기·지우기)은 운영자만, 목록 읽기는 기관 목록과 같은 회원.
3. **쓰이는 범위**: 13F 포트폴리오 화면(왼쪽 '즐겨찾기' 목록)·기관 상세·명령 팔레트(단계 2), 교집합·스타일·알림(단계 3 — 이 ADR에 덧붙임). **모의 매매와 AI 리포트 원문에는 넣지 않는다**(불변식 1):
   즐겨찾기를 읽는 빈(`InstitutionCatalog`)은 feature.institution에만 있고, feature.paper·snapshot·ai는 지금처럼 상수만 본다(시험으로 막음).
4. **트랙레코드 후보(27곳)인 즐겨찾기에는 q8을 새로 만들지 않는다**(불변식 2): 수집기는 `TRACK_RECORD_FILERS`의 CIK와 선행 CIK를 즐겨찾기 수집 대상에서 빼고(단건 수집도 `refused`),
   화면은 그 기관의 q30을 수집 없이 읽는다(2026-11-22 신호 기관 팝업과 같은 규칙). 기본 12곳과 그 합산 자회사(뱅가드 `merge_ciks`)도 즐겨찾기로 모으지 않는다.
5. **포트폴리오 읽기 규칙**: 기본 12곳은 지금 그대로(q8, 없거나 오래면 수집을 부름). 즐겨찾기는 q30이 있으면 그것, 없으면 q8 — **둘 다 수집을 부르지 않고**(`StoreReader.quietly`) 읽는다.
   명세 초안은 '없으면 수집을 부름'이었지만, 저장본이 없을 때 백엔드가 부르는 것은 `sec_13f` 태스크 전체(12곳 + 즐겨찾기, 45~57초)라 화면 하나가 그만큼 멈춘다 — 더하기 때 그 기관 하나를 모으고
   정기 `sec_13f`가 이어 모으므로 읽기에서 태스크를 기다리지 않는다. 즐겨찾기인데 저장본이 없으면 400이 아니라 '아직 모으지 못함'(available=false). 그 밖의 CIK는 지금처럼 q30이 있으면 그것, 없으면 400.
6. **더하기 흐름**: CIK 검사(숫자 1~10자리 → 10자리, 기본 12곳·중복·상한) → 수집기가 SEC submissions로 등록 이름과 원본 13F-HR 공시가 있는지 확인(없으면 422) → 표에 넣음 →
   저장본(q30·q8)이 없으면 **그 기관 하나만** 수집을 기다림(수집기 단건 경로 — 태스크 전체를 다시 돌리면 더할 때마다 SEC 요청이 열 배 넘게 든다). 수집이 실패를 돌려주면 줄을 지우고 사유와 함께 422(넣지 않은 것과 같음).
   **기다림 상한 65초**(조회 25초와 합쳐 90초 안): `sec_13f`가 12곳을 4개 병렬로 45~57초에 모으므로(QA 기록 2026-11-02~04) 기관 하나는 보통 이보다 짧지만, SEC가 느리거나 다른 수집과 토큰 버킷을 나누면
   넘을 수 있다. 넘으면 줄은 남기고 '수집 중'으로 답한다 — 수집기는 그 호출을 끝까지 돌려 저장하고, 화면은 목록을 다시 읽어 저장본이 생긴 것을 본다(명세 §5 단계 2-4가 허용한 '저장 먼저, 수집은 뒤에서'를 상한을 넘긴 경우에만).
   트랙레코드 후보면 `waiting`(q30 수집이 저장본을 만듦). 쓰기 뒤 응답 캐시를 비운다(`ComputedCache.clear()`).
7. **지우기**: 표의 줄만 지운다. 그 기관의 13F 저장본은 지우지 않는다(목록에서 빼고 수집만 멈춤 — 다시 더하면 바로 보임). 단계 3에서 그 CIK의 13F 신규 편입 알림 규칙도 함께 지운다.
8. **이름 검색**: SEC EDGAR 회사 검색 `browse-edgar?action=getcompany&company=<이름>&type=13F-HR&output=atom` 한 번(첫 쪽 40곳). 2026-11-23 실제 응답으로 확인 — 회사 이름 앞부분 일치(옛 이름 포함)이고
   `type=13F-HR`이 13F-HR 제출자만 남긴다(baupost 2곳 — 개체 색인 전체는 16곳, pershing square 2곳, berkshire 6곳, 없는 이름은 빈 피드). 전문 검색(efts)은 13F 보유 표에 이름이 나오는 다른 기관까지 걸려 쓰지 않는다.
   '찾기'를 누를 때만 부르고(입력마다 부르지 않음), 숫자 1~10자리를 넣으면 이름 검색 없이 그 CIK를 후보로 둔다. 후보의 최근 13F 공시일은 검색에서 묻지 않고(후보마다 SEC 한 번씩이 되므로) 더할 때 submissions로 확인한다.
   SEC 호출은 모두 기존 토큰 버킷(`http.sec_rate_limit`)과 User-Agent 세션만 쓴다.
9. **기관 목록 응답**: `institutions`(기본 12곳)는 모양 그대로 두고 `favorites`·`favoriteLimit`을 더한다 — `institutions`만 읽는 화면(교집합·알림)의 동작이 바뀌지 않게.

## 결과

- 즐겨찾기는 13F 화면에서 기본 12곳과 같은 패널 셋(요약·히트맵·비중 추이·보유 표)으로 보이고, 기관 상세·명령 팔레트에도 나온다. 수집은 `sec_13f`(12시간)에 함께 돌고, 상태 화면의 빠진 저장본 목록에도 나온다.
- 모의 매매 패킷·그룹 B 후보·AI 리포트 원문은 바이트까지 그대로다(상수만 봄 — 시험).
- 알려진 한계: 이름 검색은 영문 등록 이름의 앞부분 일치라 한국어·약칭으로는 찾지 못한다(CIK 직접 입력으로 대신). 더하기가 '수집 중'으로 끝나면 몇 분 뒤 목록을 다시 열어야 저장본이 보인다.
  SEC submissions의 최근 블록(약 1,000건)에 13F-HR이 없는 오래된 제출자는 '13F-HR 공시가 없음'으로 거절될 수 있다.
