import type { ReactNode } from "react";
import { AlertTriangleIcon, CheckCircleIcon, CircleDashedIcon, MinusIcon, StatusText } from "@/components/ui/icons";
import { verdictView } from "@/lib/security";
import type { SecurityVerdict } from "@/lib/types";

/**
 * 판정 넷의 모양 표지 — 색만으로 가르지 않게(위험색과 상승색이 가까움 — ADR 0042 결정 3) 판정마다 다른 아이콘: 해당 경고 삼각형, 확인 필요 점선 원(판정 못 함),
 * 패치됨 체크 원, 무관 가로줄. 아이콘은 장식이고 뜻은 옆 글이 나릅니다.
 */
const VERDICT_ICON: Record<SecurityVerdict, ReactNode> = {
  affected: <AlertTriangleIcon size={14} />,
  check: <CircleDashedIcon size={14} />,
  patched: <CheckCircleIcon size={14} />,
  unrelated: <MinusIcon size={14} />,
};

/**
 * 판정 글 — 아이콘 + 글(공용 StatusText). 해당은 낭독기에 '주의: '를 먼저 읽히고(위험 톤의 기본 '오류: '가 아님 — 실패가 아니라 업데이트가 필요하다는 뜻),
 * 나머지는 글 자체가 뜻을 나르므로 머리말이 없습니다. 모르는 판정 코드는 lib/security가 '확인 필요'로 읽습니다(안전한 쪽으로 읽지 않음).
 */
export function VerdictText({ code }: { code: string | null | undefined }) {
  const view = verdictView(code);
  return (
    <StatusText tone={view.tone} icon={VERDICT_ICON[view.code]} srPrefix={view.code === "affected" ? "주의: " : ""}>
      {view.label}
    </StatusText>
  );
}
