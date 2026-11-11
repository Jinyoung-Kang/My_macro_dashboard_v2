"use client";

import { useState } from "react";
import { Pager } from "@/components/Pager";
import {
  Banner,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  NativeSelect,
  SourceBadge,
  buttonClasses,
  filterChipClasses,
  inputClasses,
} from "@/components/ui";
import { ChevronDownIcon, ChevronUpIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useRemembered } from "@/hooks/useRemembered";
import { bypassBadge } from "@/lib/econCalendar";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import {
  type CatalogResponse,
  type HeadlinesResponse,
  type InfoItem,
  type InfoItemResponse,
  type InfoItemsResponse,
  PAGE_SIZE,
  bodyLabel,
  itemTime,
  itemTitles,
} from "@/lib/info";
import { GurusSection } from "./GurusSection";

type View = "blog" | "waedge" | "rss-us" | "rss-kr" | "gurus";

const VIEWS: readonly { key: View; label: string }[] = [
  { key: "blog", label: "해외 블로그" },
  { key: "waedge", label: "waedge 시황·거장 글" },
  { key: "gurus", label: "거장 견해" },
  { key: "rss-us", label: "사건 뉴스(미국)" },
  { key: "rss-kr", label: "사건 뉴스(한국)" },
];

/** 뉴스·글 — 해외 블로그·waedge 글(본문)·거장 견해·사건 뉴스 RSS 제목을 한 카드에서 골라 봅니다. 목록은 10편씩 쪽을 나눕니다. */
export function NewsSection() {
  const [view, setView] = useState<View>("blog");
  const [source, setSource] = useState("");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const catalog = useApi<CatalogResponse>(endpoints.info.catalog, 300_000);
  const sources = useRemembered(catalog.data?.sources) ?? [];
  const choices = sources.filter((row) => (view === "blog" ? row.kind === "blog" : view === "waedge" ? row.kind === "waedge" && row.key !== "waedge.blogs" : false));
  const deferred = sources.find((row) => row.access === "deferred");

  const choose = (next: View) => {
    setView(next);
    setSource("");
    setPage(1);
  };

  return (
    <Card title="뉴스·글" subtitle="글 제목을 누르면 원문이 새 창으로 열립니다. 본문은 운영 서버가 받아 둔 것(피드 본문 또는 글 페이지)입니다.">
      <div role="group" aria-label="글 종류" className="mb-3 flex flex-wrap gap-2">
        {VIEWS.map((entry) => (
          <button key={entry.key} type="button" aria-pressed={view === entry.key} onClick={() => choose(entry.key)} className={filterChipClasses(view === entry.key)}>
            {entry.label}
          </button>
        ))}
      </div>
      {deferred && view !== "gurus" && (
        <div className="mb-3">
          <Banner tone="info">
            {deferred.label}: 운영 서버 IP를 사이트가 대역째 막아(Cloudflare 차단 화면) 보류했습니다 — 개인 IP·프록시를 쓰지 않는 규칙.
            계정 이름 SAVETICKER_ID·SAVETICKER_PW는 .env에 두면 길이 생겼을 때 씁니다.
          </Banner>
        </div>
      )}
      {view === "gurus" ? (
        <GurusSection embedded />
      ) : (
        <>
          <form
            className="mb-3 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(draft);
              setPage(1);
            }}
          >
            {choices.length > 0 && (
              <label className="flex min-w-0 flex-col gap-1 text-xs text-text-2">
                출처
                <NativeSelect inputSize="sm" value={source} onChange={(event) => { setSource(event.target.value); setPage(1); }}>
                  <option value="">전체</option>
                  {choices.map((row) => (
                    <option key={row.key} value={row.key}>
                      {row.label}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            <label className="flex min-w-0 flex-col gap-1 text-xs text-text-2">
              검색(제목·요약)
              <input type="search" value={draft} onChange={(event) => setDraft(event.target.value)} className={inputClasses("sm")} maxLength={100} />
            </label>
            <button type="submit" className={buttonClasses("secondary", "sm")}>
              찾기
            </button>
          </form>
          {view === "blog" || view === "waedge" ? (
            <ArticleList path={endpoints.info.items({ kind: view, source, q: query, page, size: PAGE_SIZE })} onPage={setPage} />
          ) : (
            <HeadlineList path={endpoints.info.headlines({ set: view === "rss-us" ? "us" : "kr", q: query, page, size: PAGE_SIZE })} onPage={setPage} />
          )}
        </>
      )}
    </Card>
  );
}

function ArticleList({ path, onPage }: { path: string; onPage: (page: number) => void }) {
  const { data, loading, error, reload } = useApi<InfoItemsResponse>(path);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  if (!data.available) return <EmptyState message="정보 수집 표가 아직 없습니다 — 수집기가 새 스키마를 적용한 뒤 보입니다." />;
  if (data.items.length === 0) return <EmptyState message="받은 글이 없습니다. 수집은 운영 서버에서만 몇 시간에 한 번 불규칙하게 돕니다." />;
  return (
    <>
      <p className="mb-1 text-xs text-text-3">모두 {data.total ?? EMPTY}편</p>
      <ul className="divide-y divide-border">
        {data.items.map((item) => (
          <ArticleRow key={item.id} item={item} />
        ))}
      </ul>
      <Pager page={data.page ?? 1} pages={data.pages ?? 1} onChange={onPage} label="글 목록" />
    </>
  );
}

function ArticleRow({ item }: { item: InfoItem }) {
  const [open, setOpen] = useState(false);
  const titles = itemTitles(item);
  const badge = bypassBadge(item.fetchTier === "browser" ? "browser" : null);
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-text-2">
        <span className="font-semibold text-text">{item.sourceLabel}</span>
        {item.category && <span>{item.category}</span>}
        <span className="tabular-nums">{itemTime(item)}</span>
        {item.author && <span>{item.author}</span>}
        <span className="text-text-3">{bodyLabel(item.bodyStatus)}</span>
        {badge && <SourceBadge>{badge}</SourceBadge>}
      </div>
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="mt-1 block text-[15px] font-semibold leading-snug text-text hover:underline">
        {titles.primary}
      </a>
      {titles.secondary && <p className="text-[13px] text-text-2">{titles.secondary}</p>}
      {item.summary && !open && <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-text-2">{item.summary}</p>}
      <div className="mt-1 flex flex-wrap gap-3 text-xs">
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
          원문 열기
        </a>
        {item.bodyStatus !== "none" && (
          <button type="button" onClick={() => setOpen((value) => !value)} className="inline-flex items-center gap-1 text-accent hover:underline" aria-expanded={open}>
            {open ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
            {open ? "본문 접기" : item.bodyStatus === "full" ? "본문 보기" : "요약 보기"}
          </button>
        )}
      </div>
      {open && <ArticleBody id={item.id} />}
    </li>
  );
}

function ArticleBody({ id }: { id: string }) {
  const { data, loading, error, reload } = useApi<InfoItemResponse>(endpoints.info.item(id));
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data?.found || !data.item?.body) return <p className="mt-2 text-sm text-text-2">본문이 없습니다 — 원문을 여세요.</p>;
  return (
    <div className="mt-2 max-h-[32rem] overflow-y-auto whitespace-pre-wrap rounded-control bg-surface-2/60 p-3 text-[13px] leading-6 text-text">
      {data.item.body}
    </div>
  );
}

function HeadlineList({ path, onPage }: { path: string; onPage: (page: number) => void }) {
  const { data, loading, error, reload } = useApi<HeadlinesResponse>(path);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  if (data.items.length === 0) return <EmptyState message="받은 제목이 없습니다(보존 7일)." />;
  return (
    <>
      <p className="mb-1 text-xs text-text-3">모두 {data.total ?? EMPTY}건 · RSS 제목·출처·시각만(본문 없음) · 모의매매 패킷 11b_events의 재료</p>
      <ul className="divide-y divide-border">
        {data.items.map((row, index) => (
          <li key={`${row.link ?? row.title}-${index}`} className="py-2 text-sm">
            <span className="text-xs text-text-2">
              {row.source ?? row.feed ?? EMPTY} · <span className="tabular-nums">{row.publishedAt ?? EMPTY}</span>
            </span>
            {row.link ? (
              <a href={row.link} target="_blank" rel="noopener noreferrer" className="block font-semibold text-text hover:underline">
                {row.title ?? EMPTY}
              </a>
            ) : (
              <span className="block font-semibold text-text">{row.title ?? EMPTY}</span>
            )}
          </li>
        ))}
      </ul>
      <Pager page={data.page ?? 1} pages={data.pages ?? 1} onChange={onPage} label="사건 뉴스" />
    </>
  );
}
