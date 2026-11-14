"use client";

import { useEffect } from "react";
import { ErrorState, Loading } from "@/components/ui";
import { ChevronRightIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { autoPick, entityKindLabel, isTopicSearch, sourceLabel } from "@/lib/infoSearch";
import type { SearchCandidate, SearchResolveResponse } from "@/lib/types";
import { KindIcon, PANEL } from "./parts";

const CANDIDATE_SOURCES: Record<string, string> = {
  sec: "SEC",
  dart: "DART",
  "13f": "13F 기관",
  guru: "거장",
  universe: "종목 유니버스",
  wikidata: "Wikidata",
  topic: "주제",
};

/**
 * Enter로 받은 후보(GET /api/search/resolve — 가진 색인 + Wikidata). 주제를 뺀 후보가 하나이고 이름이 입력과 같으면 바로 열고(이 자리를
 * 바꿔 써서 뒤로 가기가 다시 열지 않게), 그 밖에는 목록을 보이고 사용자가 고릅니다(동명이인을 자동으로 고르지 않음). 맨 끝은 주제로 찾기.
 */
export function CandidateList({
  query,
  onAutoOpen,
  onChoose,
}: {
  query: string;
  onAutoOpen: (key: string) => void;
  onChoose: (candidate: SearchCandidate) => void;
}) {
  const resolved = useApi<SearchResolveResponse>(endpoints.search.resolve(query));
  const data = resolved.data;
  const items = data?.available ? (data.items ?? []) : [];
  const pick = data?.available ? autoPick(items, query) : null;

  useEffect(() => {
    if (pick?.key) onAutoOpen(pick.key);
  }, [pick?.key, onAutoOpen]);

  if (!data) {
    return resolved.error ? (
      <ErrorState message={resolved.error} onRetry={() => void resolved.reload()} />
    ) : (
      <Loading label="대상을 찾는 중… (Wikidata를 부르면 몇 초 걸립니다)" />
    );
  }
  if (!data.available) return <p className="text-sm text-text-2">{data.message ?? "후보를 받지 못했습니다."}</p>;
  if (pick) return <Loading label={`'${pick.name}'을(를) 여는 중…`} />;

  const failures = Object.entries(data.errors ?? {});
  return (
    <section aria-labelledby="search-candidates" className={`${PANEL} p-3`}>
      <h2 id="search-candidates" className="px-1 text-sm font-semibold text-text">
        ‘{query}’의 후보 <span className="font-normal text-text-3">— 하나를 고르세요</span>
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 px-1 text-sm text-text-2">맞는 대상이 없습니다.</p>
      ) : (
        <ul aria-label="후보" className="mt-2 divide-y divide-border">
          {items.map((candidate, index) => (
            <li key={`${candidate.key ?? "name"}:${candidate.name}:${index}`}>
              <button
                type="button"
                onClick={() => onChoose(candidate)}
                className="flex min-h-11 w-full items-center gap-3 rounded-control px-2 py-1.5 text-left text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:min-h-8"
              >
                <span className="text-text-3">
                  <KindIcon kind={candidate.kind} size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-accent">
                    {isTopicSearch(candidate) ? `‘${candidate.name}’ 주제로 찾기(구문 검색)` : candidate.name}
                  </span>
                  <span className="block truncate text-xs text-text-3">
                    {[entityKindLabel(candidate.kind), candidate.sub, CANDIDATE_SOURCES[candidate.source] ?? candidate.source]
                      .filter(Boolean)
                      .join(" · ")}
                    {candidate.key === null && !isTopicSearch(candidate) ? " · 식별자 없음 — 고르면 이 이름으로 다시 찾습니다" : ""}
                  </span>
                </span>
                <ChevronRightIcon size={14} className="text-text-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {failures.length > 0 ? (
        <p className="mt-2 px-1 text-xs text-text-3">
          일부 출처를 받지 못했습니다 — {failures.map(([source, reason]) => `${sourceLabel(source)}: ${reason}`).join(" · ")}
        </p>
      ) : null}
    </section>
  );
}
