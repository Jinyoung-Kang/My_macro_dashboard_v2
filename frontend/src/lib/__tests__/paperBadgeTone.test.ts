/**
 * 모의매매 배지 색 → 공용 태그 톤(lib/paperBadgeTone — 작업대 P6 PaperBadge): 정상 → ok, 주의 → warn, 안내·흐림 → neutral, 모르는 글 → neutral.
 */
import { describe, expect, it } from "vitest";

import { bookStatusBadge, toneClass } from "../paper";
import { badgeTagTone } from "../paperBadgeTone";

describe("badgeTagTone", () => {
  it("lib 색 표 넷을 태그 톤으로 — ok·warn은 그대로, info·muted는 중립", () => {
    expect(badgeTagTone({ className: toneClass("ok") })).toBe("ok");
    expect(badgeTagTone({ className: toneClass("warn") })).toBe("warn");
    expect(badgeTagTone({ className: toneClass("info") })).toBe("neutral");
    expect(badgeTagTone({ className: toneClass("muted") })).toBe("neutral");
  });

  it("색 표에 없는 글은 중립", () => {
    expect(badgeTagTone({ className: "text-text-3" })).toBe("neutral");
    expect(badgeTagTone({ className: "" })).toBe("neutral");
  });

  it("계좌 상태 배지 — 운용 중은 정상, 일시정지는 주의", () => {
    expect(badgeTagTone(bookStatusBadge("ACTIVE"))).toBe("ok");
    expect(badgeTagTone(bookStatusBadge("PAUSED"))).toBe("warn");
  });
});
