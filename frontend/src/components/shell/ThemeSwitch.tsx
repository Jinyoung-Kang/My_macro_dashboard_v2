"use client";

import { useId } from "react";
import { SEGMENT_TRACK, segmentClasses } from "@/components/ui/classes";
import { useTheme } from "@/hooks/useTheme";
import { THEME_CHOICES, type ThemeChoice } from "@/lib/theme";

const LABELS: Record<ThemeChoice, string> = { system: "시스템", light: "라이트", dark: "다크" };

/**
 * 화면 테마 전환 — 시스템(기본)·라이트·다크. 기본은 운영체제 설정을 따르고, 고르면 이 브라우저에 기억합니다(lib/theme.ts).
 *
 * 브라우저 기본 라디오 단추를 씁니다 — 화살표 키로 옮기기·하나만 고르기·읽어 주기가 그대로 됩니다. 단추 모양은 가린 입력칸 위의
 * 라벨이 그리고, 포커스 링도 라벨에 그립니다. 같은 화면에 둘이 있을 수 있어(왼쪽 내비와 더보기 화면) name을 따로 만듭니다.
 * 좁은 화면(더보기 화면)에서는 손가락으로 누르므로 칸 높이 44px, 왼쪽 내비(lg)에서는 32px. 모양은 세그먼트(`segmentClasses` — 홈 시장 고르기와 같음).
 */
export function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const name = useId();
  return (
    <div role="radiogroup" aria-label="화면 테마" className={`flex ${SEGMENT_TRACK}`}>
      {THEME_CHOICES.map((choice) => (
        <label key={choice} className={`h-11 flex-1 text-xs lg:h-8 ${segmentClasses(theme === choice)}`}>
          <input
            type="radio"
            name={name}
            value={choice}
            checked={theme === choice}
            onChange={() => setTheme(choice)}
            className="sr-only"
          />
          {LABELS[choice]}
        </label>
      ))}
    </div>
  );
}
