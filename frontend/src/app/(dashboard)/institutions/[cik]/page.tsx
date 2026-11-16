import { notFound } from "next/navigation";
import { InstitutionDetailScreen } from "@/components/screens/detail/InstitutionDetailScreen";
import { parseCik } from "@/lib/detail";

/**
 * 기관 상세(/institutions/<CIK>) — 통합 검색의 기관 결과가 오는 곳. CIK가 숫자가 아니면 404, 숫자 1~10자리는 10자리 정규 CIK로 읽습니다(앞 0 없는
 * 주소도 같은 기관 — QA-584). 추적하지 않는 CIK는 백엔드가 400으로 알려 화면이 '추적하는 13F 기관이 아님' 안내를 적습니다.
 */
export default async function InstitutionDetailPage({ params }: { params: Promise<{ cik: string }> }) {
  const { cik } = await params;
  const parsed = parseCik(cik);
  if (!parsed) notFound();
  return <InstitutionDetailScreen key={parsed} cik={parsed} />;
}
