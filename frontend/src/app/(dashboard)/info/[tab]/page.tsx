import { notFound } from "next/navigation";
import InfoHub from "@/components/screens/info/InfoHub";
import { INFO_TAB_SLUGS, parseInfoTab } from "@/lib/info";

/** 여덟 탭 주소만 만듭니다 — 목록 밖의 조각은 404. */
export const dynamicParams = false;

export function generateStaticParams() {
  return INFO_TAB_SLUGS.map((tab) => ({ tab }));
}

/**
 * 정보 수집(/info/overview|news|kr|global|filings|paper|status|mechanism, 운영자 전용 — ADR 0035·0036). 탭은 상단의 하위 메뉴 줄이 고르고
 * (화면 안에 같은 고르기를 두지 않음), 그리기는 components/screens/info.
 */
export default async function InfoTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  const key = parseInfoTab(tab);
  if (!key) notFound();
  return <InfoHub key={key} tab={key} />;
}
