"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Pager } from "@/components/Pager";
import { FilterList, InspectorFrame, type InspectorContext, InspectorTrigger, type InspectorTriggerProps } from "@/components/patterns";
import {
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  NativeSelect,
  SELECTED_BAR,
  SourceBadge,
  TEXT_TARGET,
  buttonClasses,
  inputClasses,
} from "@/components/ui";
import { TEXT_TARGET_SHORT } from "@/components/ui/classes";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useRemembered } from "@/hooks/useRemembered";
import { useTranslate } from "@/hooks/useTranslate";
import { bypassBadge } from "@/lib/econCalendar";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import {
  type CatalogResponse,
  type Headline,
  type HeadlineSet,
  type HeadlinesResponse,
  type InfoItem,
  type InfoItemsResponse,
  PAGE_SIZE,
  type ReaderEntry,
  bodyLabel,
  headlineLink,
  headlineSet,
  headlineSource,
  headlineTime,
  headlineViewText,
  itemTime,
  itemTitles,
  readerOfHeadline,
  readerOfItem,
  rewindPage,
  searchLabel,
  sourceChoices,
  titleNeedsTranslation,
} from "@/lib/info";
import { GurusSection } from "./GurusSection";
import { Reader } from "./Reader";

type View = "blog" | "wire" | "waedge" | "rss-us" | "rss-kr" | "rss-world" | "gurus";

/** 보기 — 사건 뉴스 두 묶음(모의 매매 패킷의 재료) 옆에 보도자료·경제지(새 피드 묶음 — 정보 검색 계약 §6-1, 패킷 밖). */
const VIEWS: readonly { key: View; label: string }[] = [
  { key: "blog", label: "해외 블로그" },
  { key: "wire", label: "속보(Financial Juice)" },
  { key: "waedge", label: "waedge 시황·거장 글" },
  { key: "gurus", label: "거장 견해" },
  { key: "rss-us", label: "사건 뉴스(미국)" },
  { key: "rss-kr", label: "사건 뉴스(한국)" },
  { key: "rss-world", label: "보도자료·경제지" },
];

/**
 * 제목 — 원문 검사 칸을 여는 줄 단추(공용 InspectorTrigger — 중립 잉크, 좁은 화면 44px·넓은 화면 24px 이상). 글은 14px 굵게(예전 15px 대신 본문 글자 단계),
 * 낱말 사이에서 줄을 바꾸고 공백 없는 긴 낱말만 꺾습니다.
 */
const TITLE = "mt-1 text-body font-semibold leading-snug wrap-anywhere";
/** 따로 선 글 링크·단추('본문 보기'·'원문 열기') — 좁은 화면 44px(QA-458). */
const TEXT_LINK = `${TEXT_TARGET} text-accent hover:underline`;
/** 짧은 글 단추('번역') — 좁은 화면 44×44, 글은 가운데(ui/classes TEXT_TARGET_SHORT). */
const SHORT_LINK = `${TEXT_TARGET_SHORT} text-accent hover:underline`;

/**
 * 뉴스·글 — 해외 블로그·속보·waedge 글·거장 견해·사건 뉴스 RSS·보도자료·경제지 RSS를 한 패널에서 골라 봅니다. 목록은 10편씩 쪽을 나누고, 제목을 누르면 받아 둔
 * 원문이 검사 칸에 열립니다 — 넓은 화면·넓은 틀(64rem 이상)은 목록 옆 28rem 칸, 그 밖은 위쪽 대화상자(예전 원문 팝업과 같은 꼴 — 제목·'출처 · 시각' 설명).
 * 검사 칸에서 한국어로 번역합니다(ADR 0037). 제목은 원문 그대로 보이고, 제목마다 번역 단추를 눌렀을 때만 번역합니다. 시각은 모두 한국 시각(KST)입니다.
 * 처음 열 때 원문을 저절로 고르지 않습니다 — 고를 때만 본문을 읽습니다(GET /api/info/items/{id}). 보기·출처·검색어·쪽이 바뀌면 고름을 풂니다.
 */
export function NewsSection() {
  const [view, setView] = useState<View>("blog");
  const [source, setSource] = useState("");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const catalog = useApi<CatalogResponse>(endpoints.info.catalog, 300_000);
  const sources = useRemembered(catalog.data?.sources) ?? [];
  const choices = sourceChoices(sources, view);
  const deferred = sources.find((row) => row.access === "deferred");
  const set = headlineSet(view);
  // 글 목록과 헤드라인 목록 — 지금 보기의 것만 읽습니다(다른 쪽은 경로 없음 = 요청 없음, 거장 견해 보기는 둘 다 없음).
  const articles = useApi<InfoItemsResponse>(
    view !== "gurus" && set === null ? endpoints.info.items({ kind: view, source, q: query, page, size: PAGE_SIZE }) : null,
  );
  const headlines = useApi<HeadlinesResponse>(set !== null ? endpoints.info.headlines({ set, q: query, page, size: PAGE_SIZE }) : null);
  const active = set === null ? articles.data : headlines.data;
  const count = view !== "gurus" && active && active.items.length > 0 ? `모두 ${active.total ?? EMPTY}${set === null ? "편" : "건"}` : undefined;

  const reset = () => {
    setPage(1);
    setSelected(null);
  };
  const choose = (next: View) => {
    setView(next);
    setSource("");
    reset();
  };
  const turn = (next: number) => {
    setPage(next);
    setSelected(null);
  };

  return (
    <Card
      title="뉴스·글"
      count={count}
      subtitle="제목은 원문 그대로입니다 — 제목 옆 '번역'을 누르면 그 제목만 한국어로 옮깁니다. 제목을 누르면 받아 둔 원문이 열리고(넓은 화면은 옆 칸, 좁은 화면은 팝업) 거기서 본문을 번역합니다. 시각은 한국 시각(KST)입니다."
    >
      <FilterList label="글 종류" selection="single" wide="wrap" items={VIEWS} selected={[view]} onToggle={(key) => choose(key as View)} />
      <div className="mt-3 flex min-w-0 flex-col gap-3">
        {deferred && view !== "gurus" && (
          <Callout title="보류한 출처">
            {deferred.label}: 운영 서버 IP를 사이트가 대역째 막아(Cloudflare 차단 화면) 보류했습니다 — 개인 IP·프록시를 쓰지 않는 규칙.
            대신 이 사이트가 원출처로 밝힌 Financial Juice의 속보를 받습니다(위 &lsquo;속보&rsquo;).
          </Callout>
        )}
        {view === "gurus" ? (
          <GurusSection embedded />
        ) : (
          <>
            <form
              className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                setQuery(draft);
                reset();
              }}
            >
              {choices.length > 0 && (
                <label className="flex min-w-0 flex-col gap-1 text-[13px] text-text-2">
                  출처
                  <NativeSelect
                    value={source}
                    onChange={(event) => {
                      setSource(event.target.value);
                      reset();
                    }}
                  >
                    <option value="">전체</option>
                    {choices.map((row) => (
                      <option key={row.key} value={row.key}>
                        {row.label}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              )}
              <label className="flex min-w-0 flex-col gap-1 text-[13px] text-text-2">
                {searchLabel(view)}
                {/* 셸의 거르기 칸 표지(data-shell-filter — '/'로 이 칸에 포커스, 단축키 도움말의 '/' 줄) — 이 화면에 하나입니다. */}
                <input
                  type="search"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  className={inputClasses("md")}
                  maxLength={100}
                  data-shell-filter=""
                />
              </label>
              <button type="submit" className={buttonClasses("secondary", "md")}>
                찾기
              </button>
            </form>
            {set === null ? (
              <ArticleList read={articles} onRewind={setPage} onPage={turn} selected={selected} onSelect={setSelected} />
            ) : (
              <HeadlineList set={set} read={headlines} onRewind={setPage} onPage={turn} selected={selected} onSelect={setSelected} />
            )}
          </>
        )}
      </div>
    </Card>
  );
}

/** 쪽이 범위를 넘어 빈 목록이 왔으면(글은 있음) 마지막 쪽을 다시 묻습니다(QA-410) → 다시 묻는 중이면 그 쪽, 아니면 null. */
function useRewind(data: Parameters<typeof rewindPage>[0] | null | undefined, onPage: (page: number) => void): number | null {
  const rewind = data ? rewindPage(data) : null;
  useEffect(() => {
    if (rewind !== null) onPage(rewind);
  }, [rewind, onPage]);
  return rewind;
}

type Read<T> = { data: T | null | undefined; loading: boolean; error: string | null; reload: () => void };
type ListProps<T> = {
  read: Read<T>;
  /** 범위를 넘은 쪽을 되돌릴 때(QA-410) — 고름은 그대로(빈 쪽에는 고른 줄이 없음). */
  onRewind: (page: number) => void;
  /** 쪽 넘기기 — 고름을 풂. */
  onPage: (page: number) => void;
  selected: string | null;
  onSelect: (key: string | null) => void;
};

/**
 * 목록 + 원문 검사 칸 — 넓은 화면·틀 64rem 이상은 옆 28rem 칸(InspectorFrame layout="wide"), 그 밖은 위쪽 대화상자(제목 + '출처 · 시각' 설명 — 예전 원문
 * 팝업 꼴). 기본으로 고르는 원문이 없어 열 때 본문을 읽지 않습니다.
 */
function ReaderFrame({
  entries,
  selected,
  onSelect,
  children,
}: {
  entries: readonly ReaderEntry[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  children: (inspector: InspectorContext) => ReactNode;
}) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return (
    <InspectorFrame
      label="원문"
      layout="wide"
      titleOf={(key) => byKey.get(key)?.title ?? null}
      renderDetail={(key) => {
        const entry = byKey.get(key);
        return entry ? <ReaderPane key={entry.key} entry={entry} /> : null;
      }}
      dialogDescriptionOf={(key) => {
        const entry = byKey.get(key);
        return entry ? `${entry.sourceLabel} · ${entry.time}` : null;
      }}
      selectedKey={selected}
      onSelectedKeyChange={onSelect}
      inspectorHint="제목을 고르면 이 칸에 받아 둔 원문이 열립니다."
    >
      {children}
    </InspectorFrame>
  );
}

/**
 * 검사 칸 내용 — 옆 칸이면 맨 위에 '출처 · 시각' 한 줄(대화상자에서는 같은 줄이 제목 아래 설명이라 이 줄은 감춤 — 대화상자 안에서만 display:none), 그 아래 원문 읽기.
 */
function ReaderPane({ entry }: { entry: ReaderEntry }) {
  return (
    <>
      <p className="text-xs text-text-2 [[role=dialog]_&]:hidden">
        {entry.sourceLabel} · <span className="tabular-nums">{entry.time}</span>
      </p>
      <Reader entry={entry} />
    </>
  );
}

/** 줄 — 고른 줄(옆 칸에 열린 원문)은 잉크 막대 + 중립 바탕(데이터 영역 — 강조 파랑 아님). 막대 자리를 위해 왼쪽 12px. */
function rowClass(selected: boolean): string {
  return `relative py-3 pl-3 pr-2 ${selected ? "bg-surface-2" : ""}`.trim();
}

/** '본문 보기'·'요약 보기' — 제목과 같은 원문을 엽니다(줄 단추 속성을 펼치되 지금 보이는 줄 표시 aria-current는 제목 단추에만). */
function openProps(inspector: InspectorContext, key: string): InspectorTriggerProps {
  const props = { ...inspector.triggerProps(key) };
  delete props["aria-current"];
  return props;
}

function ArticleList({ read, onRewind, onPage, selected, onSelect }: ListProps<InfoItemsResponse>) {
  const { data, loading, error, reload } = read;
  const rewind = useRewind(data, onRewind);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  if (!data.available) return <EmptyState message="정보 수집 표가 아직 없습니다 — 수집기가 새 스키마를 적용한 뒤 보입니다." />;
  if (rewind !== null) return <Loading />;
  if (data.items.length === 0) return <EmptyState message="받은 글이 없습니다. 수집은 운영 서버에서만 몇 시간에 한 번 불규칙하게 돕니다." />;
  const entries = data.items.map((item) => ({ item, entry: readerOfItem(item) }));
  return (
    <div>
      <ReaderFrame entries={entries.map(({ entry }) => entry)} selected={selected} onSelect={onSelect}>
        {(inspector) => (
          <ul className="divide-y divide-border">
            {entries.map(({ item, entry }) => (
              <ArticleRow key={item.id} item={item} entry={entry} inspector={inspector} />
            ))}
          </ul>
        )}
      </ReaderFrame>
      <Pager page={data.page ?? 1} pages={data.pages ?? 1} onChange={onPage} label="글 목록" />
    </div>
  );
}

function ArticleRow({ item, entry, inspector }: { item: InfoItem; entry: ReaderEntry; inspector: InspectorContext }) {
  const titles = itemTitles(item);
  const badge = bypassBadge(item.fetchTier === "browser" ? "browser" : null);
  const shown = inspector.shownKey === entry.key;
  return (
    <li className={rowClass(shown)}>
      {shown ? <span aria-hidden="true" className={SELECTED_BAR} /> : null}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-text-2">
        <span className="font-semibold text-text">{item.sourceLabel}</span>
        {item.category && <span>{item.category}</span>}
        <span className="tabular-nums">{itemTime(item)}</span>
        {item.author && <span>{item.author}</span>}
        <span className="text-text-3">{bodyLabel(item.bodyStatus)}</span>
        {badge && <SourceBadge>{badge}</SourceBadge>}
      </div>
      <div>
        <InspectorTrigger inspector={inspector} itemKey={entry.key} className={TITLE}>
          {titles.primary}
        </InspectorTrigger>
      </div>
      {titles.secondary && <p className="text-[13px] text-text-2">{titles.secondary}</p>}
      <TitleTranslation title={item.title} titleKo={item.titleKo} />
      {item.summary && <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-text-2">{item.summary}</p>}
      <div className="mt-1 flex flex-wrap gap-3 text-xs">
        {item.bodyStatus !== "none" && (
          <button type="button" {...openProps(inspector, entry.key)} className={TEXT_LINK}>
            {item.bodyStatus === "full" ? "본문 보기" : "요약 보기"}
          </button>
        )}
        <a href={item.url} target="_blank" rel="noopener noreferrer" className={TEXT_LINK}>
          원문 열기
        </a>
      </div>
    </li>
  );
}

/**
 * 헤드라인 목록 — 사건 뉴스(미국·한국)와 보도자료·경제지(world). 묶음마다 안내 글(패킷의 재료인지·보관 기간)이 다르고,
 * 작성 시각이 없는 피드의 줄은 처음 받은 시각에 '(받은 시각)'을 붙입니다.
 */
function HeadlineList({ set, read, onRewind, onPage, selected, onSelect }: ListProps<HeadlinesResponse> & { set: HeadlineSet }) {
  const { data, loading, error, reload } = read;
  const rewind = useRewind(data, onRewind);
  const text = headlineViewText(set);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  if (rewind !== null) return <Loading />;
  if (data.items.length === 0) return <EmptyState message={text.empty} />;
  const rows = data.items.map((row, index) => ({ row, entry: readerOfHeadline(row, index), index }));
  return (
    <div>
      <p className="mb-1 text-xs text-text-3">{text.note}</p>
      <ReaderFrame entries={rows.map(({ entry }) => entry)} selected={selected} onSelect={onSelect}>
        {(inspector) => (
          <ul className="divide-y divide-border">
            {rows.map(({ row, entry, index }) => (
              <HeadlineRow key={`${headlineLink(row) ?? row.title}-${index}`} row={row} entry={entry} inspector={inspector} />
            ))}
          </ul>
        )}
      </ReaderFrame>
      <Pager page={data.page ?? 1} pages={data.pages ?? 1} onChange={onPage} label={text.pager} />
    </div>
  );
}

function HeadlineRow({ row, entry, inspector }: { row: Headline; entry: ReaderEntry; inspector: InspectorContext }) {
  const link = headlineLink(row);
  const shown = inspector.shownKey === entry.key;
  return (
    <li className={`${rowClass(shown)} text-sm`}>
      {shown ? <span aria-hidden="true" className={SELECTED_BAR} /> : null}
      <span className="text-xs text-text-2">
        {headlineSource(row)} · <span className="tabular-nums">{headlineTime(row)}</span>
      </span>
      <div>
        <InspectorTrigger inspector={inspector} itemKey={entry.key} className={TITLE}>
          {row.title ?? EMPTY}
        </InspectorTrigger>
      </div>
      <TitleTranslation title={row.title} />
      {row.summary && <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-text-2">{row.summary}</p>}
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer" className={`mt-1 text-xs ${TEXT_LINK}`}>
          원문 열기
        </a>
      )}
    </li>
  );
}

/**
 * 제목 하나의 번역 단추(2026-11-12 사용자 지시 — 미리 번역하지 않고 제목마다). 한글이 든 제목·출처가 한국어 제목을 붙인 글에는 내지 않습니다.
 * 누르면 그 제목만 서버에 묻고(같은 제목은 저장본에서 바로 옴) 아래에 한국어를 보입니다. 실패하면 사유를 아이콘 + 글로.
 */
function TitleTranslation({ title, titleKo }: { title: string | null; titleKo?: string | null }) {
  const { translate: request, busy, translated, response, error: requestError } = useTranslate();
  if (!title || !titleNeedsTranslation(title, titleKo)) return null;
  const korean = translated?.titleKo ?? null;
  // 응답은 왔는데 제목 번역이 없으면 그 사유(없으면 일반 문구)를 보입니다.
  const error = requestError ?? (response && !response.titleKo ? "번역하지 못했습니다." : null);
  const translate = () => request({ title });
  if (korean) {
    return (
      <p lang="ko" className="text-[13px] text-text-2">
        {korean}
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs">
      <button type="button" onClick={translate} disabled={busy} className={`${SHORT_LINK} disabled:opacity-60`} aria-label={`제목 번역: ${title}`}>
        {busy ? "번역 중…" : "번역"}
      </button>
      {error && (
        <StatusText tone="danger" iconSize={12}>
          {error}
        </StatusText>
      )}
    </p>
  );
}
