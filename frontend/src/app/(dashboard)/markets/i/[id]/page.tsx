import { notFound } from "next/navigation";
import { IndicatorDetailScreen } from "@/components/screens/detail/IndicatorDetailScreen";
import { parseIndicatorKey } from "@/lib/detail";

/**
 * 지표 상세(/markets/i/<매크로 카드 키>) — 통합 검색의 지표 결과가 오는 곳. 키 모양이 틀리면 404, 모양은 맞는데 저장본에 없으면 화면이 그 사실과
 * 매크로 지표 화면 링크를 적습니다(카드 목록은 수집기 indicators.py가 정하고 저장본을 읽어야 알 수 있음).
 */
export default async function IndicatorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const key = parseIndicatorKey(id);
  if (!key) notFound();
  return <IndicatorDetailScreen key={key} indicatorKey={key} />;
}
