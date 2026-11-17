import type { JSX } from "react";
import type { TimelineKind } from "@/components/patterns";
import { Tag } from "@/components/ui";
import { AlertTriangleIcon, CheckCircleIcon, CircleDashedIcon, InfoIcon } from "@/components/ui/icons";
import { type RegimeIcon, regimeTone } from "@/lib/regime";

/** 국면 아이콘 이름 → 12px 아이콘(장식 — 뜻은 국면 이름 글과 태그의 '주의:'가 나름). */
const ICONS: Record<RegimeIcon, JSX.Element> = {
  check: <CheckCircleIcon size={12} />,
  alert: <AlertTriangleIcon size={12} />,
  info: <InfoIcon size={12} />,
  unknown: <CircleDashedIcon size={12} />,
};

/** 판정 기록 타임라인의 종류 — 국면 태그와 같은 톤·아이콘(lib/regime regimeTone). */
export function regimeKind(code: string | null | undefined, label: string): TimelineKind {
  const { tone, icon } = regimeTone(code);
  return { label, tone, icon: ICONS[icon] };
}

/**
 * 국면 태그 — 공용 태그(톤 + 아이콘 + 국면 이름). 국면 범주색만으로 국면을 가르지 않습니다(D1 결정 거리 3 권장안 — lib/regime regimeTone).
 * 사분면·이력 띠 범례·과거 구간 표·판정 성과의 국면 머리가 함께 씁니다.
 */
export function RegimeTag({ code, label }: { code: string | null | undefined; label: string }): JSX.Element {
  const { tone, icon } = regimeTone(code);
  return (
    <Tag tone={tone} icon={ICONS[icon]}>
      {label}
    </Tag>
  );
}
