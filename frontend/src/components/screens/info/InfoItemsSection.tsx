"use client";

import { useState } from "react";
import {
  Card,
  EmptyState,
  ErrorState,
  Loading,
  NativeSelect,
  SourceBadge,
  buttonClasses,
  inputClasses,
} from "@/components/ui";
import { ChevronDownIcon, ChevronUpIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useRemembered } from "@/hooks/useRemembered";
import { bypassBadge } from "@/lib/econCalendar";
import { endpoints } from "@/lib/endpoints";
import {
  type InfoItem,
  type InfoItemResponse,
  type InfoItemsResponse,
  type InfoSourcesResponse,
  bodyLabel,
  itemTime,
  itemTitles,
} from "@/lib/info";

const PAGE = 40;

/**
 * 글 목록 — 해외 블로그(원문 블로그 14곳 + waedge가 붙인 한국어 제목) 또는 waedge 시황(시장·거장 글). 최근부터, 출처 고르기·검색·'더 보기'.
 * 본문은 펼칠 때 한 편씩 읽습니다.
 */
export function InfoItemsSection({ category }: { category: "blog" | "waedge" }) {
  const [source, setSource] = useState("");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const sources = useApi<InfoSourcesResponse>(endpoints.info.sources);
  const rows = useRemembered(sources.data?.sources)?.filter((row) => row.category === category) ?? [];

  const restart = (next: () => void) => {
    next();
    setCursors([undefined]);
  };

  return (
    <Card
      title={category === "blog" ? "해외 블로그" : "waedge 시황"}
      subtitle={
        category === "blog"
          ? "원문 블로그의 RSS에서 받은 글입니다. 피드에 본문이 있으면 그 본문을, 없으면 글 페이지에서 고른 본문을 보입니다. 한국어 제목은 waedge 해외 블로그가 붙인 것입니다."
          : "waedge 뉴스의 시장 글과 거장 글입니다. 본문은 상세 페이지에서 받은 것입니다(AI가 쓴 글이 섞여 있습니다)."
      }
    >
      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          restart(() => setQuery(draft));
        }}
      >
        <label className="flex min-w-0 flex-col gap-1 text-xs text-text-2">
          출처
          <NativeSelect inputSize="sm" value={source} onChange={(event) => restart(() => setSource(event.target.value))}>
            <option value="">전체</option>
            {rows.map((row) => (
              <option key={row.key} value={row.key}>
                {row.label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-text-2">
          검색(제목·요약)
          <input
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className={inputClasses("sm")}
            maxLength={100}
          />
        </label>
        <button type="submit" className={buttonClasses("secondary", "sm")}>
          찾기
        </button>
      </form>
      <div className="space-y-3">
        {cursors.map((cursor, index) => (
          <ItemsPage
            key={cursor ?? "first"}
            path={endpoints.info.items({ category, source, q: query, before: cursor, limit: PAGE })}
            last={index === cursors.length - 1}
            first={index === 0}
            onMore={(next) => setCursors((previous) => [...previous, next])}
          />
        ))}
      </div>
    </Card>
  );
}

function ItemsPage({ path, first, last, onMore }: { path: string; first: boolean; last: boolean; onMore: (next: string) => void }) {
  const { data, loading, error, reload } = useApi<InfoItemsResponse>(path);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  if (!data.available) {
    return <EmptyState message="정보 수집 표가 아직 없습니다 — 수집기가 새 스키마를 적용한 뒤 보입니다." />;
  }
  if (first && data.items.length === 0) {
    return <EmptyState message="아직 받은 글이 없습니다. 수집은 운영 서버에서만 몇 시간에 한 번 불규칙하게 돕니다." />;
  }
  return (
    <>
      <ul className="divide-y divide-border">
        {data.items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
      {last && data.next && (
        <button type="button" onClick={() => onMore(data.next as string)} className={buttonClasses("secondary", "sm")}>
          더 보기
        </button>
      )}
    </>
  );
}

function ItemRow({ item }: { item: InfoItem }) {
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
      {open && <ItemBody id={item.id} />}
    </li>
  );
}

function ItemBody({ id }: { id: string }) {
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
