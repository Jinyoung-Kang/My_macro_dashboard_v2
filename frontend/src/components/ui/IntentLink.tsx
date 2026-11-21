"use client";

import NextLink from "next/link";
import { type ComponentProps, useState } from "react";

type IntentLinkProps = ComponentProps<typeof NextLink>;

/**
 * 가리킬 때만 미리 받는 링크 — 앱의 모든 화면 안 링크가 `next/link` 대신 이것을 씁니다(ADR 0047 결정 5, 2026-11-22 사용자 결정 D-4).
 *
 * Next의 기본 `<Link>`는 화면에 보이기만 해도 그 경로를 미리 받습니다(운영 빌드). 셸 메뉴·목록의 링크가 화면마다 24~31개라, 어느 화면을 열든
 * 다른 화면들의 스크립트(앱 전체 JS의 약 70%)까지 받았습니다. 이 링크는 처음에는 미리 받지 않고(`prefetch={false}`), 마우스를 올리거나
 * 키보드 초점이 오거나 터치가 시작되면 — 누를 뜻을 보이면 — Next 기본 동작(`prefetch={null}`)으로 돌아가 그때 미리 받습니다
 * (Next.js 16.4.5 문서의 '가리킬 때만 미리 받기' 꼴). 호출한 쪽이 `prefetch={false}`를 주면 끝까지 받지 않고, `true`를 주면 의도를 보인 뒤 그 값을 씁니다.
 * 넘겨받은 `onMouseEnter`·`onFocus`·`onTouchStart`는 그대로 부릅니다. 지킴 시험: `components/ui/__tests__/IntentLink.test.tsx`.
 */
export function IntentLink({ prefetch, onMouseEnter, onFocus, onTouchStart, ...rest }: IntentLinkProps) {
  const [intent, setIntent] = useState(false);
  const resolved = prefetch === false || !intent ? false : (prefetch ?? null);
  return (
    <NextLink
      {...rest}
      prefetch={resolved}
      onMouseEnter={(event) => {
        setIntent(true);
        onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        setIntent(true);
        onFocus?.(event);
      }}
      onTouchStart={(event) => {
        setIntent(true);
        onTouchStart?.(event);
      }}
    />
  );
}

export default IntentLink;
