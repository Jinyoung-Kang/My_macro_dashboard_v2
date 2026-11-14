/**
 * 정보 검색(/search — ADR 0041) 응답 계약 — GET /api/search/suggest|resolve|entity|feed, 단계 3의 recent·watch·excludes.
 * 모양의 정본은 docs/specs/2026-11-14-info-search-contract.md §2~3·§6입니다. 백엔드는 수집기 응답에 `available: true`를 더해 그대로 넘기고,
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
  | "managed_by";

export type SearchLink = {
  relation: SearchLinkRelation | string;
  /** 누르면 넘어갈 대상. 없으면 그 이름으로 다시 풉니다. */
  key: string | null;
  name: string;
  kind: SearchEntityKind | null;
  source: string;
};

export type SearchEntityIds = {
  ticker: string | null;
  market: "us" | "kr" | null;
  stockCode: string | null;
  cik: string | null;
  dartCorpCode: string | null;
  wikidata: string | null;
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
  /** 작성 시각(timeBasis가 fetched면 처음 받은 시각). UTC ISO. */
  publishedAt: string | null;
  timeBasis: "published" | "fetched";
  source: string;
  lang: "ko" | "en" | null | string;
  summary: string | null;
  /** 수집 글(info_items)의 id — 운영자 화면의 원문 팝업용. */
  readerId: string | null;
};

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
};

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
