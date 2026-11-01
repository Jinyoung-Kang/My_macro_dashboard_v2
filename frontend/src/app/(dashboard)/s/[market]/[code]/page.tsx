import { notFound } from "next/navigation";
import { StockDetailScreen } from "@/components/screens/detail/StockDetailScreen";
import { parseStockRoute } from "@/lib/detail";

/**
 * 종목 상세(/s/us/<Yahoo 심볼>·/s/kr/<6자리 코드>) — 통합 검색의 종목 결과가 오는 곳. 시장·코드 형식이 틀리면 404(백엔드와 같은 규칙, lib/detail).
 * 코드가 바뀌면 화면을 다시 만듭니다(앞 종목의 차트 기간·요약이 남지 않게).
 */
export default async function StockDetailPage({ params }: { params: Promise<{ market: string; code: string }> }) {
  const { market, code } = await params;
  const target = parseStockRoute(market, code);
  if (!target) notFound();
  return <StockDetailScreen key={`${target.market}:${target.code}`} market={target.market} code={target.code} />;
}
