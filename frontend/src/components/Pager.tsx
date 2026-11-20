"use client";

import { type MouseEvent, useEffect, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui";
import { pageNumbers } from "@/lib/info";

/** 번호 단추 폭 하한 — 좁은 화면 44px(높이와 같은 누름 자리 — 한 자리 번호도), 넓은 화면 24px(작은 조작 — 작업대 명세 §3-7). 예전에는 글 폭뿐이었음(QA-835). */
const NUMBER_WIDTH = "min-w-11 lg:min-w-6";

/**
 * 쪽 넘기기 — 이전 · 번호(처음·끝·지금 앞뒤, 사이는 말줄임) · 다음. 한 쪽뿐이면 그리지 않습니다.
 * 긴 목록을 한 화면에 늘어놓지 않고 5~10줄씩 나눠 보이는 화면이 씁니다(정보 수집 — 사용자 요청 2026-11-11).
 * 지금 쪽은 주 단추(강조 바탕)·aria-current이고, 고대비(forced-colors)에서는 바탕이 지워지고 모든 번호의 테두리가 같은 시스템 색이라 지금 쪽에만
 * 2px 테두리를 둡니다(QA-492 — 켜고 끄는 단추·거르기 칩과 같은 방법). 번호 단추는 좁은 화면에서 폭도 44px입니다(QA-835).
 * '다음'·'이전'으로 끝 쪽에 닿으면 누른 단추가 꺼져 크롬이 포커스를 body로 보내므로, 그때만 포커스를 지금 쪽 번호 단추로 옮깁니다(QA-890 — 쪽 nav 안에 남음).
 */
export function Pager({ page, pages, onChange, label }: { page: number; pages: number; onChange: (page: number) => void; label: string }) {
  const navRef = useRef<HTMLElement>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    const nav = navRef.current;
    const active = document.activeElement;
    // 꺼진 단추에 남았거나(크롬이 아직 빼지 않음) body로 떨어졌을 때만 — 그 사이 다른 곳으로 옮긴 포커스는 건드리지 않습니다.
    const lost = active === null || active === document.body || (active instanceof HTMLButtonElement && active.disabled && !!nav?.contains(active));
    if (lost) nav?.querySelector<HTMLButtonElement>('button[aria-current="page"]')?.focus();
  }, [refocus, page]);
  if (pages <= 1) return null;
  const step = (event: MouseEvent<HTMLButtonElement>, next: number) => {
    // 이 넘김으로 누른 단추가 꺼지면(첫 쪽·끝 쪽) 그린 뒤 포커스를 지금 쪽 번호로.
    if ((next <= 1 || next >= pages) && document.activeElement === event.currentTarget) setRefocus(true);
    onChange(next);
  };
  return (
    <nav ref={navRef} aria-label={`${label} 쪽`} className="mt-3 flex flex-wrap items-center gap-1.5 text-sm">
      <button type="button" className={buttonClasses("secondary", "sm")} disabled={page <= 1} onClick={(event) => step(event, page - 1)}>
        이전
      </button>
      {pageNumbers(page, pages).map((n, i) =>
        n === null ? (
          <span key={`gap-${i}`} className="px-1 text-text-3" aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={n}
            type="button"
            aria-current={n === page ? "page" : undefined}
            className={`${n === page ? `${buttonClasses("primary", "sm")} forced-colors:border-2` : buttonClasses("ghost", "sm")} ${NUMBER_WIDTH}`}
            onClick={() => onChange(n)}
          >
            {n}
          </button>
        ),
      )}
      <button type="button" className={buttonClasses("secondary", "sm")} disabled={page >= pages} onClick={(event) => step(event, page + 1)}>
        다음
      </button>
      <span className="ml-1 text-xs text-text-3 tabular-nums">
        {page}/{pages}쪽
      </span>
    </nav>
  );
}
