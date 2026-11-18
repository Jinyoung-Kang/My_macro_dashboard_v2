import { toneClass, type Badge } from "./paper";

/** 모의매매 배지를 옮길 공용 태그 톤(components/ui Tag의 톤 가운데 셋 — 위험 톤은 쓰지 않음). */
export type PaperBadgeTagTone = "ok" | "warn" | "neutral";

/**
 * lib 배지의 색 클래스(`toneClass` — ok·warn·info·muted)를 공용 태그 톤으로(작업대 P6 PaperBadge). 정상 → ok, 주의 → warn, 안내·흐림 → neutral(데이터 배지는
 * 강조 파랑을 쓰지 않음 — 원칙 A1). 색 표에 없는 글(옛 배지·다른 클래스)은 neutral입니다 — 뜻은 배지 글이 나릅니다.
 */
export function badgeTagTone(badge: Pick<Badge, "className">): PaperBadgeTagTone {
  if (badge.className === toneClass("ok")) return "ok";
  if (badge.className === toneClass("warn")) return "warn";
  return "neutral";
}
