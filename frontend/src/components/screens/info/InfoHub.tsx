"use client";

import { ScrollTopButton } from "@/components/ScrollTopButton";
import { PageHeader } from "@/components/ui";
import type { InfoTab } from "@/lib/info";
import { CatalogSection } from "./CatalogSection";
import { KrxSection } from "./KrxSection";
import { MechanismSection } from "./MechanismSection";
import { NaverFlowsSection } from "./NaverFlowsSection";
import { NewsSection } from "./NewsSection";
import { OverviewSection } from "./OverviewSection";
import { StatusSection } from "./StatusSection";

const TITLES: Record<InfoTab, { title: string; description: string }> = {
  overview: { title: "정보 수집", description: "수집기가 받는 모든 출처의 상태를 분류별로 한눈에 봅니다. 분류를 누르면 그 출처들의 자료와 상태로 갑니다." },
  news: { title: "뉴스·글", description: "해외 블로그 14곳·waedge 시황·거장 견해·사건 뉴스 RSS. 글마다 원문 링크가 있고, 펼치면 받아 둔 본문을 봅니다." },
  kr: { title: "국내 시장·수급", description: "KRX 정보데이터시스템(로그인)·네이버 매매상위·토스·Daum·금융위 등 국내 출처의 자료와 상태." },
  global: { title: "해외 시장·거시", description: "FRED·TradingView·Yahoo·CFTC·경제 캘린더 등 해외 시장과 거시 지표 출처의 상태." },
  filings: { title: "기관·공시·재무", description: "SEC 13F·XBRL 재무·DART·어닝 서프라이즈 출처의 상태." },
  paper: { title: "모의매매 입력", description: "모의매매 장부·패킷이 쓰는 시세·1분봉·수급 출처의 상태." },
  status: { title: "출처 상태", description: "모든 출처의 마지막 실행·판정·다음 실행을 한 표에서 봅니다. 끊긴 출처는 텔레그램과 화면 위 안내로도 알립니다." },
  mechanism: { title: "정보(메커니즘)", description: "수집이 어떻게 도는지 — 서버에서만, 사람 같은 불규칙한 간격, 차단 통과 계층, 사람 확인, 끊김 알림, 패킷 활용. 값은 수집기 코드의 실제 값입니다." },
};

/**
 * 정보 수집 화면(사이드바 '정보 수집', 운영자 전용 — ADR 0035·0036). 백엔드는 저장본과 수집기 상태 응답만 읽어 화면을 열어도 수집이 일어나지
 * 않습니다. 긴 목록은 10줄(카드는 8장)씩 나눠 쪽을 옮기고, 아래로 내려가면 '맨 위로' 단추가 뜹니다.
 */
export default function InfoHub({ tab }: { tab: InfoTab }) {
  const head = TITLES[tab];
  return (
    <div className="space-y-6">
      <PageHeader title={head.title} description={head.description} />
      {tab === "overview" && <OverviewSection />}
      {tab === "news" && (
        <>
          <NewsSection />
          <CatalogSection tab="news" />
        </>
      )}
      {tab === "kr" && (
        <>
          <KrxSection />
          <NaverFlowsSection />
          <CatalogSection tab="kr" />
        </>
      )}
      {tab === "global" && <CatalogSection tab="global" />}
      {tab === "filings" && <CatalogSection tab="filings" />}
      {tab === "paper" && <CatalogSection tab="paper" />}
      {tab === "status" && <StatusSection />}
      {tab === "mechanism" && <MechanismSection />}
      <p className="text-xs leading-5 text-text-3">
        차단 통과 수집(블로그·waedge·네이버·KRX·TradingView 캘린더)은 운영 서버에서만 출처마다 불규칙한 간격으로 돌고, 이 PC의 IP로는 받지
        않습니다. 수집 글은 설정(info.packet·kr.info.packet, 기본 켬)에 따라 Claude 모의매매 판단에 참고 자료로 들어갑니다.
      </p>
      <ScrollTopButton />
    </div>
  );
}
