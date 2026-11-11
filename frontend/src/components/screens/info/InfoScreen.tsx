"use client";

import { useEffect, useState } from "react";
import { PageHeader, underlineTabClasses } from "@/components/ui";
import { INFO_TABS, type InfoTab, parseInfoTab } from "@/lib/info";
import { GurusSection } from "./GurusSection";
import { InfoItemsSection } from "./InfoItemsSection";
import { NaverFlowsSection } from "./NaverFlowsSection";
import { SourceStatusSection } from "./SourceStatusSection";

/**
 * 정보 수집(모의매매 > 정보 수집, 운영자 전용 — ADR 0035).
 *
 * 해외 투자·경제 블로그 14곳, waedge 시장·거장, 네이버 투자자별 매매상위를 운영 서버가 불규칙한 간격으로 받아 둔 것을 봅니다. 백엔드는 저장본만
 * 읽어 화면을 열어도 수집이 일어나지 않습니다. 원문 링크를 늘 함께 보이고, 차단 통과 수집으로 받은 것은 '우회 수집'으로 표시합니다.
 * Claude 모의매매 판단(패킷)에는 넣지 않습니다. 탭은 주소의 `?tab=`(안내 띠의 '출처 상태 보기')으로도 고릅니다.
 */
export default function InfoScreen() {
  const [tab, setTab] = useState<InfoTab>("blog");

  useEffect(() => {
    setTab(parseInfoTab(new URLSearchParams(window.location.search).get("tab")));
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="정보 수집"
        description="해외 투자·경제 블로그, waedge 시황·거장, 네이버 투자자별 매매상위를 모은 운영자 전용 화면입니다. 글마다 원문 링크가 있습니다."
      />
      <div role="tablist" aria-label="정보 수집 분류" className="-mb-px flex overflow-x-auto border-b border-border">
        {INFO_TABS.map((entry) => {
          const active = entry.key === tab;
          return (
            <button
              key={entry.key}
              type="button"
              role="tab"
              id={`info-tab-${entry.key}`}
              aria-selected={active}
              aria-controls="info-tabpanel"
              onClick={() => setTab(entry.key)}
              className={underlineTabClasses(active, "sm")}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id="info-tabpanel" aria-labelledby={`info-tab-${tab}`} className="space-y-6">
        {tab === "blog" && <InfoItemsSection category="blog" />}
        {tab === "waedge" && <InfoItemsSection category="waedge" />}
        {tab === "gurus" && <GurusSection />}
        {tab === "naver" && <NaverFlowsSection />}
        {tab === "sources" && <SourceStatusSection />}
      </div>
      <p className="text-xs leading-5 text-text-3">
        수집은 운영 서버에서만 출처마다 불규칙한 간격으로 돌고(이 PC의 IP로는 받지 않음), 출처가 막으면 그 출처만 잠시 멈춘 뒤 텔레그램과 화면 위
        안내로 알립니다. 여기 모은 글은 참고용이며 Claude 모의매매 판단에는 넣지 않습니다.
      </p>
    </div>
  );
}
