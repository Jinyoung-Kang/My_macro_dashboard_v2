/**
 * 정보 검색(/search — ADR 0041) 응답 계약 — GET /api/search/suggest|resolve|entity|feed.
 * 모양의 정본은 docs/specs/2026-11-14-info-search-contract.md §2~3입니다. 백엔드는 수집기 응답에 `available: true`를 더해 그대로 넘기고,
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
};
