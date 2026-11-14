"use client";

import { useCallback } from "react";
import { ScrollTopButton } from "@/components/ScrollTopButton";
import { Banner, PageHeader } from "@/components/ui";
import { DialogScope } from "@/components/ui/Dialog";
import { useInfoSearchUrl } from "@/hooks/useInfoSearch";
import { useInfoSearchWatch } from "@/hooks/useInfoSearchWatch";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isDemo, isOwner } from "@/lib/access";
import { candidateTarget, type SearchTarget } from "@/lib/infoSearch";
import type { SearchCandidate } from "@/lib/types";
import { CandidateList } from "./CandidateList";
import { EntityView } from "./EntityView";
import { SearchBox } from "./SearchBox";
import { SearchHome } from "./SearchHome";

/** 이 화면의 범위 표지 — globals.css의 [data-scope="search"]가 늘 어두운 토큰을 다시 정합니다. 이 화면에서 연 대화상자도 같은 표지. */
const SCOPE = "search";

/**
 * 정보 검색(/search — ADR 0041). 기업·기관·사람·주제를 대상으로 풀어 최근 2년의 뉴스·글·보유·연결을 한 화면에서 봅니다. 회원 이상(D-1) —
 * 글·논평 탭과 수집 글의 원문 팝업은 운영자만, 데모 열람은 서버가 저장본만 줍니다.
 *
 * 상태는 주소에 있습니다: `?q=`(후보 보기) · `?e=&tab=&range=`(대상). 대상을 바꾸면 기록에 쌓고 탭·기간은 바꿔 씁니다(hooks/useInfoSearch).
 * 내용 영역은 앱 테마와 상관없이 늘 어둡고(범위 토큰), 셸(왼쪽 메뉴·상단바)은 앱 테마 그대로입니다. 차트·시세는 그리지 않습니다.
 *
 * 관심 대상(단계 3 — 계약 §6-4)은 이 화면이 한 번 읽어 첫 화면·대상 화면의 왼쪽 칸과 대상 머리의 등록 단추가 함께 씁니다.
 * 데모 열람은 등록하지 못해 읽지도 않습니다.
 */
export function SearchScreen() {
  const user = useSessionUser();
  const owner = isOwner(user);
  const demo = isDemo(user);
  const { state, openEntity, replaceEntity, openQuery, setTab, setRange } = useInfoSearchUrl();
  const watch = useInfoSearchWatch(!demo);

  const go = useCallback(
    (target: SearchTarget) => {
      if ("open" in target) openEntity(target.open);
      else openQuery(target.resolve);
    },
    [openEntity, openQuery],
  );
  const chooseSuggestion = useCallback((candidate: SearchCandidate) => go(candidateTarget(candidate, null)), [go]);
  const chooseCandidate = useCallback((candidate: SearchCandidate) => go(candidateTarget(candidate, state.q)), [go, state.q]);

  return (
    <div data-scope={SCOPE} className="flex flex-col gap-4 rounded-card border border-border p-3 sm:p-4 lg:p-5">
      <DialogScope value={SCOPE}>
        <PageHeader title="정보 검색" description="기업·기관·사람·주제의 뉴스·글·보유·연결을 대상 하나로 모아 봅니다." />
        <SearchBox initial={state.q} onSubmit={openQuery} onChoose={chooseSuggestion} />
        {state.badKey ? (
          <Banner tone="warn">주소의 대상 키의 모양이 맞지 않습니다 — 검색창에서 다시 찾아 주세요.</Banner>
        ) : null}
        {state.e ? (
          <EntityView
            key={state.e}
            entityKey={state.e}
            tab={state.tab}
            range={state.range}
            owner={owner}
            demo={demo}
            watch={watch}
            onTab={setTab}
            onRange={setRange}
            onTarget={go}
            onOpen={openEntity}
          />
        ) : state.q ? (
          <CandidateList key={state.q} query={state.q} onAutoOpen={replaceEntity} onChoose={chooseCandidate} />
        ) : (
          <SearchHome watch={watch} owner={owner} demo={demo} onOpen={openEntity} />
        )}
        {/* 맨 위로(사용자 요청 2026-11-15) — 범위 안이라 어두운 토큰, 휴대폰 미리보기 서랍(z-30)을 덮지 않게 그 아래 층. */}
        <ScrollTopButton layer="z-20" />
      </DialogScope>
    </div>
  );
}
