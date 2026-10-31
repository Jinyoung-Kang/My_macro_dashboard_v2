import type { CSSProperties, JSX } from "react";

import { presentText } from "@/lib/patterns";

/**
 * 아바타 — 자산 행 왼쪽의 원(40px, 좁은 화면 36px) 안에 짧은 모노그램(티커 앞 글자·계좌 약칭, `lib/patternRows`의 `assetMonogram`·
 * `lib/paperOverview`의 `bookMonogram`이 정함). 자산 로고 이미지는 쓰지 않습니다(명세 §1 — 이미지 자산 없음).
 *
 * - 장식입니다(aria-hidden) — 무엇의 행인지는 옆의 이름 글이 나릅니다. 단추·링크 이름에도 섞이지 않습니다.
 * - `ring`(예: 계좌 색 = 그 계좌의 차트 선 색)을 주면 2px 고리를 두릅니다. 색은 보조 표지일 뿐 뜻을 나르지 않습니다.
 * - 글자가 없으면(null·빈 글·"N/A") 그리지 않습니다 — 빈 원을 두지 않습니다.
 */
export function Avatar({ text, ring }: { text?: string | null; ring?: string | null }): JSX.Element | null {
  const label = presentText(text);
  if (label === null) {
    return null;
  }
  const color = presentText(ring);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[13px] font-semibold leading-none text-text-2 sm:size-10 ${
        color ? "ring-2 ring-(--avatar-ring)" : ""
      }`}
      // 고리 색은 부르는 쪽 값(차트 계열 색)이라 클래스로 미리 만들 수 없어 변수로 넘깁니다.
      style={color ? ({ "--avatar-ring": color } as CSSProperties) : undefined}
    >
      {label}
    </span>
  );
}
