"use client";

import { ErrorState, Loading } from "@/components/ui";
import { ExternalLinkIcon, StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatKst } from "@/lib/format";
import { groupByKstDate, httpUrl, itemKindLabel, kstTime, sortFeed, sourceLabel } from "@/lib/infoSearch";
import type { SearchRecentResponse } from "@/lib/types";
import { PANEL, PaneHeading } from "./parts";

/**
 * 첫 화면의 최근 글(GET /api/search/recent — 계약 §6-4): 새 피드 묶음(중앙은행 보도자료·경제지 RSS 12곳)의 최근 30건, 운영자에게는 속보 최근 20건을
 * 더합니다. 저장본만 읽고(외부 호출 없음), KST 날짜로 묶어 시각 · 종류 · 매체 · 제목(원문 새 창)을 보입니다. 기사 본문은 받지 않습니다.
 * 읽지 못한 저장본(응답의 errors)은 출처와 사유를 위에 적고, 그때 빈 목록은 '없음'이 아니라 '모름'으로 보입니다.
 */
export function RecentPanel({ owner }: { owner: boolean }) {
  const recent = useApi<SearchRecentResponse>(endpoints.search.recent);
  const data = recent.data;

  let body;
  if (!data) {
    body = recent.error ? (
      <ErrorState message={recent.error} onRetry={() => void recent.reload()} />
    ) : (
      <Loading label="최근 글을 읽는 중…" />
    );
  } else if (!data.available) {
    body = <p className="px-3 py-4 text-sm text-text-2">{data.message ?? "최근 글을 받지 못했습니다."}</p>;
  } else {
    const groups = groupByKstDate(sortFeed(data.items ?? []));
    // 읽지 못한 저장본(문 시간 초과 등) — 빈 목록을 '없음'으로 보이지 않게 출처와 사유를 적습니다(계약 §5, 지시문 §8).
    const failed = Object.entries(data.errors ?? {}).filter(([, reason]) => typeof reason === "string" && reason);
    const failures =
      failed.length > 0 ? (
        <ul aria-label="읽지 못한 출처" className="flex flex-col gap-0.5 border-b border-border px-3 py-1.5">
          {failed.map(([name, reason]) => (
            <li key={name} className="text-xs text-text-2">
              <StatusText tone="warn" colorText={false} iconSize={12}>
                {sourceLabel(name)} — {reason}
              </StatusText>
            </li>
          ))}
        </ul>
      ) : null;
    const list =
      groups.length === 0 ? (
        failed.length > 0 ? (
          <p className="px-3 py-4 text-sm text-text-2">읽지 못한 출처가 있어 최근 글이 있는지 모릅니다 — 잠시 뒤 다시 열어 보세요.</p>
        ) : (
          <p className="px-3 py-4 text-sm text-text-2">아직 받은 글이 없습니다 — 새 피드 묶음은 피드마다 30분~6시간 간격으로 받습니다.</p>
        )
      ) : (
        <ul aria-label="최근 글" className="flex flex-col">
          {groups.map((group) => (
            <li key={group.date || "none"}>
              <p className="border-b border-border bg-surface-2 px-3 py-1 text-xs font-semibold text-text-2">{group.label}</p>
              <ul className="flex flex-col">
                {group.items.map((item) => {
                  const url = httpUrl(item.url);
                  return (
                    <li
                      key={item.id}
                      className="grid min-h-11 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 border-b border-border px-3 py-1.5 text-sm lg:min-h-8 lg:grid-cols-[3.5rem_4rem_10rem_minmax(0,1fr)] lg:py-1"
                    >
                      <span className="flex flex-col text-xs tabular-nums text-text-2 lg:text-sm">
                        <span>{kstTime(item.publishedAt) ?? EMPTY}</span>
                        {item.timeBasis === "fetched" ? <span className="text-xs text-text-3">받은 시각</span> : null}
                      </span>
                      <span className="col-start-2 row-start-2 text-xs text-text-3 lg:col-start-auto lg:row-start-auto">
                        {itemKindLabel(item.kind)}
                        <span className="lg:hidden"> · {item.publisher ?? EMPTY}</span>
                      </span>
                      <span className="hidden truncate text-xs text-text-2 lg:block">{item.publisher ?? EMPTY}</span>
                      <span className="col-start-2 row-start-1 min-w-0 lg:col-start-auto lg:row-start-auto">
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex max-w-full items-center gap-1 rounded-sm text-accent hover:text-accent-hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                          >
                            <span className="truncate">{item.title}</span>
                            <ExternalLinkIcon size={12} />
                            <span className="sr-only">(새 창)</span>
                          </a>
                        ) : (
                          <span className="block truncate text-text">{item.title}</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      );
    body = (
      <>
        {failures}
        {list}
      </>
    );
  }

  return (
    <section aria-labelledby="search-recent" className={`${PANEL} flex flex-col`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-3 py-2">
        <PaneHeading id="search-recent">최근 글 — 보도자료·경제지 피드{owner ? "와 속보" : ""}</PaneHeading>
        {data?.fetchedAt ? <span className="text-xs text-text-3">받은 시각 {formatKst(data.fetchedAt)} KST</span> : null}
      </div>
      {body}
      <p className="px-3 py-2 text-xs leading-5 text-text-3">
        중앙은행(연준·ECB·영란은행)·경제지(Bloomberg·CNBC·MarketWatch·Benzinga·Seeking Alpha·BBC·Economist·Nikkei Asia) RSS에서 받아 둔 제목입니다
        {owner ? "(운영자에게는 속보도)" : ""}. 시각 칸이 없는 피드는 처음 받은 시각에 &lsquo;받은 시각&rsquo;을 붙입니다. 모의 매매의 입력이 아닙니다.
      </p>
    </section>
  );
}
