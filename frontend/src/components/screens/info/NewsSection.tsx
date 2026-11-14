"use client";

import { useEffect, useState } from "react";
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
import { useApi } from "@/hooks/useApi";
import { useRemembered } from "@/hooks/useRemembered";
import { useTranslate } from "@/hooks/useTranslate";
import { bypassBadge } from "@/lib/econCalendar";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import {
  type CatalogResponse,
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
import { ReaderDialog } from "./ReaderDialog";

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

/** 제목 단추 — 누르면 원문 팝업이 열립니다(새 창의 원문은 '원문 열기' 링크). */
const TITLE_BUTTON = "mt-1 block text-left text-[15px] font-semibold leading-snug text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * 뉴스·글 — 해외 블로그·속보·waedge 글·거장 견해·사건 뉴스 RSS·보도자료·경제지 RSS를 한 카드에서 골라 봅니다. 목록은 10편씩 쪽을 나누고, 제목을 누르면 받아 둔
 * 원문이 팝업으로 열립니다(팝업에서 한국어로 번역 — ADR 0037). 제목은 원문 그대로 보이고, 제목마다 번역 단추를 눌렀을 때만 번역합니다.
 * 시각은 모두 한국 시각(KST)입니다.
 */
export function NewsSection() {
  const [view, setView] = useState<View>("blog");
  const [reader, setReader] = useState<ReaderEntry | null>(null);
  const [source, setSource] = useState("");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const catalog = useApi<CatalogResponse>(endpoints.info.catalog, 300_000);
  const sources = useRemembered(catalog.data?.sources) ?? [];
  const choices = sourceChoices(sources, view);
  const deferred = sources.find((row) => row.access === "deferred");
  const set = headlineSet(view);

  const choose = (next: View) => {
    setView(next);
    setSource("");
    setPage(1);
  };

  return (
    <Card title="뉴스·글" subtitle="제목은 원문 그대로입니다 — 제목 옆 '번역'을 누르면 그 제목만 한국어로 옮깁니다. 제목을 누르면 받아 둔 원문이 팝업으로 열리고, 팝업에서 본문을 번역합니다. 시각은 한국 시각(KST)입니다.">
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
            대신 이 사이트가 원출처로 밝힌 Financial Juice의 속보를 받습니다(위 &lsquo;속보&rsquo;).
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
              {searchLabel(view)}
              <input type="search" value={draft} onChange={(event) => setDraft(event.target.value)} className={inputClasses("sm")} maxLength={100} />
            </label>
            <button type="submit" className={buttonClasses("secondary", "sm")}>
              찾기
            </button>
          </form>
          {set === null ? (
            <ArticleList path={endpoints.info.items({ kind: view, source, q: query, page, size: PAGE_SIZE })} onPage={setPage} onOpen={setReader} />
          ) : (
            <HeadlineList
              set={set}
              path={endpoints.info.headlines({ set, q: query, page, size: PAGE_SIZE })}
              onPage={setPage}
              onOpen={setReader}
            />
          )}
        </>
      )}
      <ReaderDialog entry={reader} onClose={() => setReader(null)} />
    </Card>
  );
}

type Open = (entry: ReaderEntry) => void;

/** 쪽이 범위를 넘어 빈 목록이 왔으면(글은 있음) 마지막 쪽을 다시 묻습니다(QA-410) → 다시 묻는 중이면 그 쪽, 아니면 null. */
function useRewind(data: Parameters<typeof rewindPage>[0] | null | undefined, onPage: (page: number) => void): number | null {
  const rewind = data ? rewindPage(data) : null;
  useEffect(() => {
    if (rewind !== null) onPage(rewind);
  }, [rewind, onPage]);
  return rewind;
}

function ArticleList({ path, onPage, onOpen }: { path: string; onPage: (page: number) => void; onOpen: Open }) {
  const { data, loading, error, reload } = useApi<InfoItemsResponse>(path);
  const rewind = useRewind(data, onPage);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  if (!data.available) return <EmptyState message="정보 수집 표가 아직 없습니다 — 수집기가 새 스키마를 적용한 뒤 보입니다." />;
  if (rewind !== null) return <Loading />;
  if (data.items.length === 0) return <EmptyState message="받은 글이 없습니다. 수집은 운영 서버에서만 몇 시간에 한 번 불규칙하게 돕니다." />;
  return (
    <>
      <p className="mb-1 text-xs text-text-3">모두 {data.total ?? EMPTY}편</p>
      <ul className="divide-y divide-border">
        {data.items.map((item) => (
          <ArticleRow key={item.id} item={item} onOpen={onOpen} />
        ))}
      </ul>
      <Pager page={data.page ?? 1} pages={data.pages ?? 1} onChange={onPage} label="글 목록" />
    </>
  );
}

function ArticleRow({ item, onOpen }: { item: InfoItem; onOpen: Open }) {
  const titles = itemTitles(item);
  const badge = bypassBadge(item.fetchTier === "browser" ? "browser" : null);
  const open = () => onOpen(readerOfItem(item));
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
      <button type="button" onClick={open} aria-haspopup="dialog" className={TITLE_BUTTON}>
        {titles.primary}
      </button>
      {titles.secondary && <p className="text-[13px] text-text-2">{titles.secondary}</p>}
      <TitleTranslation title={item.title} titleKo={item.titleKo} />
      {item.summary && <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-text-2">{item.summary}</p>}
      <div className="mt-1 flex flex-wrap gap-3 text-xs">
        {item.bodyStatus !== "none" && (
          <button type="button" onClick={open} aria-haspopup="dialog" className="text-accent hover:underline">
            {item.bodyStatus === "full" ? "본문 보기" : "요약 보기"}
          </button>
        )}
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
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
function HeadlineList({ set, path, onPage, onOpen }: { set: HeadlineSet; path: string; onPage: (page: number) => void; onOpen: Open }) {
  const { data, loading, error, reload } = useApi<HeadlinesResponse>(path);
  const rewind = useRewind(data, onPage);
  const text = headlineViewText(set);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  if (rewind !== null) return <Loading />;
  if (data.items.length === 0) return <EmptyState message={text.empty} />;
  return (
    <>
      <p className="mb-1 text-xs text-text-3">모두 {data.total ?? EMPTY}건 · {text.note}</p>
      <ul className="divide-y divide-border">
        {data.items.map((row, index) => {
          const link = headlineLink(row);
          return (
            <li key={`${link ?? row.title}-${index}`} className="py-2 text-sm">
              <span className="text-xs text-text-2">
                {headlineSource(row)} · <span className="tabular-nums">{headlineTime(row)}</span>
              </span>
              <button type="button" onClick={() => onOpen(readerOfHeadline(row, index))} aria-haspopup="dialog" className={TITLE_BUTTON}>
                {row.title ?? EMPTY}
              </button>
              <TitleTranslation title={row.title} />
              {row.summary && <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-text-2">{row.summary}</p>}
              {link && (
                <a href={link} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-accent hover:underline">
                  원문 열기
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <Pager page={data.page ?? 1} pages={data.pages ?? 1} onChange={onPage} label={text.pager} />
    </>
  );
}

/**
 * 제목 하나의 번역 단추(2026-11-12 사용자 지시 — 미리 번역하지 않고 제목마다). 한글이 든 제목·출처가 한국어 제목을 붙인 글에는 내지 않습니다.
 * 누르면 그 제목만 서버에 묻고(같은 제목은 저장본에서 바로 옴) 아래에 한국어를 보입니다.
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
    <p className="text-xs">
      <button type="button" onClick={translate} disabled={busy} className="text-accent hover:underline disabled:opacity-60" aria-label={`제목 번역: ${title}`}>
        {busy ? "번역 중…" : "번역"}
      </button>
      {error && <span className="ml-2 text-danger">{error}</span>}
    </p>
  );
}
