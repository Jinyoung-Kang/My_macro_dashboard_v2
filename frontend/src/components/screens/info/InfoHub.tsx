"use client";

import { useCallback, useState, type ReactNode } from "react";
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

/**
 * 탭마다 머리 — 제목, 설명 한 줄, '자세히' 접기 안의 긴 설명(작업대 명세 §1 — 긴 설명 문단은 지우지 않고 접기로). 예전 설명 문단을 그대로 나눠
 * 첫 문장(또는 줄인 앞부분)은 설명, 나머지는 '자세히'에 둡니다.
 */
const TITLES: Record<InfoTab, { title: string; description: string; more?: string }> = {
  overview: { title: "정보 수집", description: "수집기가 받는 모든 출처의 상태를 분류별로 한눈에 봅니다.", more: "분류를 누르면 그 출처들의 자료와 상태로 갑니다." },
  news: {
    title: "뉴스·글",
    description: "해외 블로그 14곳·Financial Juice 속보·waedge 시황·거장 견해·사건 뉴스 RSS.",
    more: "제목은 원문 그대로이고 제목마다 번역 단추가 있습니다. 제목을 누르면 받아 둔 원문이 열리고(넓은 화면은 목록 옆 칸, 좁은 화면은 팝업) 거기서 본문을 번역합니다. 시각은 KST입니다.",
  },
  kr: { title: "국내 시장·수급", description: "KRX 정보데이터시스템(로그인)·네이버 매매상위·토스·Daum·금융위 등 국내 출처의 자료와 상태." },
  global: { title: "해외 시장·거시", description: "FRED·TradingView·Yahoo·CFTC·경제 캘린더 등 해외 시장과 거시 지표 출처의 상태." },
  filings: { title: "기관·공시·재무", description: "SEC 13F·XBRL 재무·DART·어닝 서프라이즈 출처의 상태." },
  paper: { title: "모의매매 입력", description: "모의매매 장부·패킷이 쓰는 시세·1분봉·수급 출처의 상태." },
  status: {
    title: "출처 상태",
    description: "모든 출처의 마지막 실행·판정·다음 실행을 한 표에서 봅니다.",
    more: "끊긴 출처는 텔레그램과 화면 위 안내로도 알립니다.",
  },
  mechanism: {
    title: "정보(메커니즘)",
    description: "수집이 어떻게 도는지 — 서버에서만, 사람 같은 불규칙한 간격, 차단 통과 계층, 사람 확인, 끊김 알림, 패킷 활용.",
    more: "값은 수집기 코드의 실제 값입니다.",
  },
};

/** 모든 탭의 '자세히' 끝 문단(예전에는 화면 바닥의 12px 문단). */
const COLLECTION_NOTE =
  "차단 통과 수집(블로그·waedge·네이버·KRX·TradingView 캘린더)은 운영 서버에서만 출처마다 불규칙한 간격으로 돌고, 이 PC의 IP로는 받지 않습니다. " +
  "수집 글은 설정(info.packet·kr.info.packet, 기본 켬)에 따라 Claude 모의매매 판단에 참고 자료로 들어갑니다.";

/**
 * 정보 수집 화면(메뉴 더보기 › '정보 수집' 묶음, 운영자 전용 — ADR 0035·0036). 백엔드는 저장본과 수집기 상태 응답만 읽어 화면을 열어도 수집이 일어나지
 * 않습니다. 긴 목록은 10줄씩 나눠 쪽을 옮기고, 아래로 내려가면 '맨 위로' 단추가 뜹니다.
 */
export default function InfoHub({ tab }: { tab: InfoTab }) {
  const head = TITLES[tab];
  return (
    <div className="space-y-6">
      <PageHeader
        title={head.title}
        // 설명 한 줄은 낱말 사이에서만 꺾습니다 — 390에서 '…봅|니다.'처럼 음절 사이가 갈렸습니다(P7 검토). 공용 머리 설명의 규칙은 P7 밖 화면도 바꾸므로 여기만.
        description={<span className="break-keep">{head.description}</span>}
        details={
          <div className="space-y-2">
            {head.more ? <p>{head.more}</p> : null}
            <p>{COLLECTION_NOTE}</p>
          </div>
        }
      />
      {tab === "overview" && <OverviewSection />}
      {tab === "news" && <NewsTab />}
      {tab === "kr" && <KrTab />}
      {tab === "global" && <CatalogSection tab="global" />}
      {tab === "filings" && <CatalogSection tab="filings" />}
      {tab === "paper" && <CatalogSection tab="paper" />}
      {tab === "status" && <StatusSection />}
      {tab === "mechanism" && <MechanismSection />}
      <ScrollTopButton />
    </div>
  );
}

/**
 * 위 패널이 처음 답할 때까지 아래 패널을 그리되 보이지 않게(hidden — 요청은 처음부터 함께 시작, 횟수·경로 그대로) 둡니다. 위 패널의 응답 뒤 높이는
 * 받은 자료에 따라 크게 갈려(국내 KRX: 받은 날 표 다섯 약 2,000px · 저장본 없음 약 230px, 뉴스: 글 10편 약 650~900px · 0편 한 줄) 읽는 중 자리로는 한쪽만
 * 맞출 수 있었습니다 — 보이던 아래 패널이 응답 뒤 첫 화면 밖으로 밀리거나(받은 날) 화면 밖에서 올라왔습니다(없는 날). 아래 패널은 위 패널이 답한 뒤
 * 처음 나타나므로 밀리지 않습니다(QA-893·894). 위 패널이 오류여도 답한 것으로 봅니다.
 */
function AfterSettled({ top, children }: { top: (settle: () => void) => ReactNode; children: ReactNode }) {
  const [settled, setSettled] = useState(false);
  const settle = useCallback(() => setSettled(true), []);
  return (
    <>
      {top(settle)}
      <div hidden={!settled} className="space-y-6">
        {children}
      </div>
    </>
  );
}

function NewsTab() {
  return (
    <AfterSettled top={(settle) => <NewsSection onSettled={settle} />}>
      <CatalogSection tab="news" />
    </AfterSettled>
  );
}

function KrTab() {
  return (
    <AfterSettled top={(settle) => <KrxSection onSettled={settle} />}>
      <NaverFlowsSection />
      <CatalogSection tab="kr" />
    </AfterSettled>
  );
}
