"use client";

import { useId, useState, type ReactNode } from "react";
import { tabId, Tabs } from "@/components/ui";

/** 상세 화면 가운데 탭 하나 — 키·이름·내용(패널들). */
export type DetailTab<K extends string> = { key: K; label: string; content: ReactNode };

/**
 * 상세 화면 가운데 탭(작업대 대상 문법 — 지표·종목·기관 상세의 개요·뉴스·리서치·보유, P4).
 *
 * - 탭 줄은 공용 Tabs(밑줄 탭, ARIA tabs — 화살표·Home·End는 포커스만, 누르기·Enter·Space가 엶)이고 이름은 `label`('{이름} 내용').
 * - 탭 패널(role=tabpanel)은 하나이고 지금 탭에 이름이 붙습니다(aria-labelledby). 탭마다의 내용은 그 안에 **모두 마운트**하고 고르지 않은 것은
 *   hidden입니다 — 화면을 열 때 시세·차트·뉴스·보유를 한 번씩 읽는 요청 시점·횟수가 탭이 없던 때와 같고(이름을 받은 뒤 부르는 뉴스 — QA-448·453
 *   그대로), 탭을 오가도 AI 요약 결과·뉴스 쪽·차트 기간이 남습니다. 차트(ResponsiveContainer)는 처음 보이는 첫 탭(개요)에 둡니다 — 숨긴 채로 처음
 *   그리면 폭을 0으로 잽니다.
 * - 고른 탭은 화면 안 상태(주소 그대로 — W5), 처음은 첫 탭. 그 탭이 사라지면(리서치·보유가 없는 종목으로 바뀜) 첫 탭으로 돌아갑니다.
 * - 탭 안 패널 사이는 칸 틀과 같은 12px(lg 16px).
 */
export function DetailTabs<K extends string>({ label, tabs }: { label: string; tabs: readonly DetailTab<K>[] }) {
  const baseId = useId();
  const idPrefix = `${baseId}-tab`;
  const panelId = `${baseId}-panel`;
  const [chosen, setChosen] = useState<K | null>(null);
  const current = tabs.find((tab) => tab.key === chosen)?.key ?? tabs[0]?.key;
  if (current === undefined) return null;
  return (
    <div className="min-w-0">
      <Tabs label={label} items={tabs.map(({ key, label: name }) => ({ key, label: name }))} value={current} onChange={setChosen} idPrefix={idPrefix} panelId={panelId} size="sm" />
      <div role="tabpanel" id={panelId} aria-labelledby={tabId(idPrefix, current)} className="mt-3 min-w-0">
        {tabs.map((tab) => (
          <div key={tab.key} hidden={tab.key !== current} className="flex min-w-0 flex-col gap-3 lg:gap-4">
            {tab.content}
          </div>
        ))}
      </div>
    </div>
  );
}
