"use client";

import type { InfoSearchWatch } from "@/hooks/useInfoSearchWatch";
import { ExcludesPanel } from "./ExcludesPanel";
import { PANEL } from "./parts";
import { RecentPanel } from "./RecentPanel";
import { SearchIntro } from "./SearchIntro";
import { WatchPane } from "./WatchPane";

/**
 * 대상을 고르지 않은 첫 화면(지시문 §4.2 — 계약 §6-4): 왼쪽은 내 관심 대상, 가운데는 새 피드 묶음의 최근 글(운영자는 속보도)과 설명,
 * 그 아래 매체 제외 목록(펼칠 때만 읽음). 모두 저장본이라 외부 출처를 부르지 않습니다. 좁은 화면은 한 칸으로 차례대로.
 */
export function SearchHome({
  watch,
  owner,
  demo,
  onOpen,
}: {
  watch: InfoSearchWatch;
  owner: boolean;
  demo: boolean;
  onOpen: (key: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
      <aside className={`${PANEL} p-3`}>
        <WatchPane watch={watch} demo={demo} onOpen={onOpen} />
      </aside>
      <div className="flex min-w-0 flex-col gap-3">
        <RecentPanel owner={owner} />
        <SearchIntro owner={owner} demo={demo} />
        <ExcludesPanel owner={owner} />
      </div>
    </div>
  );
}
