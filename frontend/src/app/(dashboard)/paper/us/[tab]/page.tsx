import { notFound } from "next/navigation";
import PaperScreen from "@/components/screens/paper/PaperScreen";
import { PAPER_TAB_SLUGS, paperTabFromSlug } from "@/lib/paperRoutes";

/** 여섯 탭 주소만 만듭니다 — 목록 밖의 조각은 만들지 않고 404(아래 notFound는 같은 규칙의 두 번째 울타리). */
export const dynamicParams = false;

export function generateStaticParams() {
  return PAPER_TAB_SLUGS.map((tab) => ({ tab }));
}

/**
 * 🧪 모의 알고리즘 매매(미국)의 탭 화면(/paper/us/selection|holdings|decisions|framework|notes|settings, 운영자 전용).
 * 개요는 /paper/us(../page.tsx). 화면 안에서 탭을 바꾸면 PaperScreen이 주소만 바꿉니다(이 파일을 다시 그리지 않음).
 */
export default async function PaperUsTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  const key = paperTabFromSlug(tab);
  if (!key) notFound();
  // 탭이 다르면 다른 화면으로 다시 만듭니다 — 같은 라우트 안에서 주소 조각만 바뀌어도 처음 탭이 새 주소를 따르게.
  return <PaperScreen key={key} initialTab={key} />;
}
