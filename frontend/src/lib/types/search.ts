/**
 * 정보 검색(/search — ADR 0041) 응답 계약 — GET /api/search/suggest|resolve|entity|feed, 단계 3의 recent·watch·excludes, 단계 4의 links,
 * 단계 5의 Finviz(feed의 출처 `finviz`·`pending`), 단계 6의 같은 사건 묶음(줄의 `clusterId`·`cluster`)과 관심 대상의 화제(`hot`)·
 * 별칭(`aliases`)·알림(`notify`, PATCH /api/search/watch/{id}).
 * 모양의 정본은 docs/specs/2026-11-14-info-search-contract.md §2~3·§6~9입니다. 백엔드는 수집기 응답에 `available: true`를 더해 그대로 넘기고,
 * 수집기에 닿지 못하면 `{available: false, message}`만 보냅니다. 모르는 값은 null(화면은 '—', 0으로 채우지 않음). 시각은 UTC ISO.
 */

/** 대상 종류 — 기업 · 기관(13F 등) · 사람 · 주제(어디에도 없는 검색어). */
export type SearchEntityKind = "company" | "institution" | "person" | "topic";

/** 백엔드가 덧붙이는 중계 칸. */
export type SearchRelay = { available: boolean; message?: string | null };

/** 후보 한 줄(치는 동안·Enter). key가 null이면 식별자가 없는 이름이라 고르면 그 이름으로 다시 풉니다(계약 3-1). */
export type SearchCandidate = {
  key: string | null;
  kind: SearchEntityKind;
  name: string;
  sub: string | null;
  source: string;
};

export type SearchSuggestResponse = SearchRelay & { items?: SearchCandidate[]; fetchedAt?: string | null };

export type SearchResolveResponse = SearchRelay & {
  items?: SearchCandidate[];
  errors?: Record<string, string>;
  fetchedAt?: string | null;
};

export type SearchLinkRelation =
  | "owner_of"
  | "owned_by"
  | "founded_by"
  | "founder_of"
  | "employer"
  | "employee"
  | "ceo"
  | "ceo_of"
  | "parent"
  | "subsidiary"
  | "manager"
  | "managed_by"
  // 단계 4(계약 §7-5) — 미국 상장사의 내부자 명단(Yahoo), 법인의 최상위 모회사(GLEIF).
  | "insider"
  | "ultimate_parent";

/** 연결의 출처 — 대상 풀기(Wikidata·13F)와 연결 보강(단계 4 — Yahoo 내부자 명단·GLEIF 법인 관계). */
export type SearchLinkSource = "wikidata" | "13f" | "yahoo" | "gleif";

export type SearchLink = {
  relation: SearchLinkRelation | string;
  /** 누르면 넘어갈 대상. 없으면 그 이름으로 다시 풉니다. */
  key: string | null;
  name: string;
  kind: SearchEntityKind | null;
  source: SearchLinkSource | string;
  /** 한 줄 설명(단계 4 — 내부자의 직위·최근 거래, 법인의 소재지·LEI). 없으면 null, 대상 풀기의 옛 응답에는 칸이 없습니다. */
  detail?: string | null;
};

export type SearchEntityIds = {
  ticker: string | null;
  market: "us" | "kr" | null;
  stockCode: string | null;
  cik: string | null;
  dartCorpCode: string | null;
  wikidata: string | null;
  /** 법인 식별자(단계 4 — Wikidata P1278의 첫 값, 20자). 없으면 null, 하루 캐시의 옛 응답에는 칸이 없습니다. */
  lei?: string | null;
};

export type SearchEntity = {
  /** 대표 키(상장사 us:/kr:, 13F 기관 cik:, 그 밖 wd:, 주제 topic:). */
  key: string;
  kind: SearchEntityKind;
  name: string;
  nameKo: string | null;
  nameEn: string | null;
  aliases: string[];
  description: string | null;
  ids: SearchEntityIds;
  links: SearchLink[];
  sources: string[];
};

export type SearchEntityResponse = SearchRelay & {
  entity?: SearchEntity | null;
  errors?: Record<string, string>;
  fetchedAt?: string | null;
};

/** 결과 탭 — 보유·연결은 이 경로를 쓰지 않습니다(계약 3-4). */
export type SearchFeedTab = "timeline" | "news" | "posts" | "filings" | "research";

export type SearchFeedItem = {
  id: string;
  kind: "news" | "headline" | "post" | "opinion" | "wire" | "filing" | "research" | string;
  title: string;
  url: string | null;
  publisher: string | null;
  publisherDomain: string | null;
  /**
   * 작성 시각(timeBasis가 fetched면 처음 받은 시각, date면 그 날짜의 출처 달력 00:00 — DART·네이버 KST, SEC 미국 동부). UTC ISO.
   */
  publishedAt: string | null;
  /** published = 작성 시각, fetched = 처음 받은 시각(시각 칸 없는 피드), date = 날짜만 아는 출처(단계 4 — 화면은 날짜만). */
  timeBasis: "published" | "fetched" | "date";
  source: string;
  lang: "ko" | "en" | null | string;
  summary: string | null;
  /** 수집 글(info_items)의 id — 운영자 화면의 원문 팝업용. */
  readerId: string | null;
  /**
   * 같은 사건 묶음(단계 6 — 계약 §9-2): 묶음 대표 줄(가장 이른 줄)의 id. 묶이지 않으면 null, 단계 5까지의 응답에는 칸이 없습니다.
   * 묶기 규칙(제목 낱말 자카드 ≥ 0.5 · 48시간 안 · 최대 30줄)은 수집기가 원본이고 화면은 이 칸으로 묶어 보이기만 합니다.
   */
  clusterId?: string | null;
  /** 대표 줄에만 — 묶음의 줄 수와 서로 다른 매체 수(받은 2년 묶음 전체 기준). 그 밖의 줄은 null이거나 칸이 없습니다. */
  cluster?: SearchFeedCluster | null;
};

/** 같은 사건 묶음의 크기(계약 §9-2) — size = 줄 수, publishers = 서로 다른 매체 수('삼각측량'). */
export type SearchFeedCluster = { size: number; publishers: number | null };

export type SearchSourceStatusCode =
  | "ok"
  | "empty"
  | "error"
  | "cached"
  | "skipped"
  | "owner_only"
  | "offline"
  | "later"
  | "pending"
  | "server_only";

export type SearchDropped = { old: number; noTime: number; chinese: number; excluded: number };

export type SearchSourceStatus = {
  source: string;
  label: string;
  status: SearchSourceStatusCode | string;
  count: number | null;
  dropped: SearchDropped | null;
  message: string | null;
};

/** 기간 단추(화면이 2년 묶음에서 자름). */
export type SearchRange = "7d" | "30d" | "1y" | "2y";

export type SearchFeedResponse = SearchRelay & {
  entityKey?: string;
  tab?: SearchFeedTab | string;
  items?: SearchFeedItem[];
  sources?: SearchSourceStatus[];
  /** KST 날짜(YYYY-MM-DD). to가 서버의 오늘입니다. */
  window?: { from: string; to: string } | null;
  rangeCounts?: Partial<Record<SearchRange, number>> | null;
  olderOnlyLatest?: string | null;
  /**
   * 받는 중인 출처가 있음(단계 5 — Finviz가 줄에 있거나 받는 중, 출처 상태 `pending`). 화면은 5초마다 같은 결과를 다시 부릅니다(최대 12번 — 계약 §8-6).
   * 수집기의 `finvizQueued`(사용자 빈도 셈)는 백엔드가 지우고 넘기지 않습니다(§8-5).
   */
  pending?: boolean;
  fetchedAt?: string | null;
  /**
   * '지금 새로 받기'(refresh=1) 응답에 서버가 붙이는 한 줄 — 사용자당 10분 상한에 걸려 캐시를 그대로 줬을 때 등(계약 §6-4 '상태 글').
   * 없으면 화면은 받은 시각만 적습니다.
   */
  refreshNote?: string | null;
};

// ------------------------------------------------------------------ 단계 3 — 관심 대상·첫 화면·매체 제외(계약 §6-4)

/** 내 관심 대상 한 줄. newCount = 마지막으로 본 뒤 처음 받은 글 수(모르면 null — 0으로 채우지 않음). */
export type SearchWatchItem = {
  id: number;
  /** 대표 키(계약 §2). */
  key: string;
  kind: SearchEntityKind | string;
  name: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  newCount: number | null;
  /**
   * 화제(단계 6 — 계약 §9-2): 지난 24시간에 처음 받은 글이 5건 이상이고 그 앞 30일 하루 평균의 3배 이상. 받을 때 작성 시각(날짜만 아는 줄은
   * 그 날의 끝)이 이미 하루 넘게 지난 글은 세지 않고, 평균은 그 대상이 처음 등록된 뒤 모은 날로 나눔. 회원에게는 운영자 전용 출처를 세지 않음.
   * 모르면 null(모은 날이 하루 미만이고 5건 이상 등), 단계 5까지의 응답에는 칸이 없습니다(화면은 true일 때만 '화제' 글 배지).
   */
  hot?: boolean | null;
  /**
   * 이 줄의 별칭(단계 6 묶음 2 — 계약 §9-4): 그 사용자의 검색어(결과 경로가 수집기에 `aliases=`로 넘기면 대상 풀기의 별칭에 더해 쓰고, 정기 수집은 대표 키마다 모든 사용자의 것을 합침).
   * 등록 때 대상 풀기의 별칭(이름 둘이 앞)으로 채우고 PATCH로 고칩니다. 1~12개, 하나 1~60자. 단계 6 묶음 1까지의 응답에는 칸이 없습니다(화면은 편집을 두지 않음).
   */
  aliases?: string[] | null;
  /**
   * 새 글 알림(계약 §9-5) — 켜면 백엔드 정기 작업(15분)이 새 글을 알림함에 한 줄로 남깁니다(텔레그램 없음). 기본 꺼짐.
   * 단계 6 묶음 1까지의 응답에는 칸이 없습니다(화면은 단추를 그리지 않음 — 끔으로 채우지 않음).
   */
  notify?: boolean | null;
};

/** PATCH /api/search/watch/{id} — 별칭이나 알림 하나를 고칩니다(자기 줄만, 데모·store_only 403). */
export type SearchWatchPatch = { aliases: string[] } | { notify: boolean };

/** 상한 — 내 목록(회원 10·운영자 50)과 서버 전체의 서로 다른 대상(100). */
export type SearchWatchLimits = { mine: number | null; max: number | null; serverUsed: number | null; serverMax: number | null };

/** GET /api/search/watch. collecting = 서버 정기 수집이 켜진 곳인지(로컬·QA는 false, 모르면 null). */
export type SearchWatchResponse = SearchRelay & {
  items?: SearchWatchItem[];
  limits?: SearchWatchLimits | null;
  collecting?: boolean | null;
};

/**
 * GET /api/search/recent — 새 피드 묶음 최근 글(운영자는 속보를 더함). errors = 읽지 못한 저장본(feeds·wire)과 사유 —
 * 있으면 빈 목록은 '없음'이 아니라 '모름'입니다.
 */
export type SearchRecentResponse = SearchRelay & { items?: SearchFeedItem[]; errors?: Record<string, string> | null; fetchedAt?: string | null };

/** 매체 제외 종류 — 도메인(점 경계로 대조)·이름(대소문자 무시 완전 일치). */
export type SearchExcludeKind = "domain" | "name";

/** 코드에 둔 처음 값 — 묶음(중국 국가·당 매체·홍콩 등)과 함께. */
export type SearchExcludeSeed = { kind: SearchExcludeKind | string; value: string; group: string | null };

/** 운영자가 더한 제외 매체(백엔드 표 search_media_excludes). */
export type SearchExcludeAdded = { id: number; kind: SearchExcludeKind | string; value: string; note: string | null; createdAt: string | null };

/** GET /api/search/excludes. */
export type SearchExcludesResponse = SearchRelay & { seed?: SearchExcludeSeed[]; added?: SearchExcludeAdded[] };

// ------------------------------------------------------------------ 단계 4 — 연결 보강(계약 §7-5)

/**
 * GET /api/search/links — 연결 탭을 열 때 따로 부르는 연결 보강(미국 상장사의 내부자 명단 · LEI가 있는 법인의 모회사·자회사).
 * 화면은 대상 풀기의 links와 합쳐 관계별로 보입니다. sources는 출처마다 한 줄(받는 중·실패·건너뜀을 빈 목록으로 숨기지 않음).
 */
export type SearchLinksResponse = SearchRelay & {
  entityKey?: string;
  links?: SearchLink[];
  sources?: SearchSourceStatus[];
  fetchedAt?: string | null;
};
