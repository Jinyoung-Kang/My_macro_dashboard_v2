"use client";

import { buttonClasses } from "@/components/ui";
import { pageNumbers } from "@/lib/info";

/**
 * 쪽 넘기기 — 이전 · 번호(처음·끝·지금 앞뒤, 사이는 말줄임) · 다음. 한 쪽뿐이면 그리지 않습니다.
 * 긴 목록을 한 화면에 늘어놓지 않고 5~10줄씩 나눠 보이는 화면이 씁니다(정보 수집 — 사용자 요청 2026-11-11).
 */
export function Pager({ page, pages, onChange, label }: { page: number; pages: number; onChange: (page: number) => void; label: string }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={`${label} 쪽`} className="mt-3 flex flex-wrap items-center gap-1.5 text-sm">
      <button type="button" className={buttonClasses("secondary", "sm")} disabled={page <= 1} onClick={() => onChange(page - 1)}>
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
            className={buttonClasses(n === page ? "primary" : "ghost", "sm")}
            onClick={() => onChange(n)}
          >
            {n}
          </button>
        ),
      )}
      <button type="button" className={buttonClasses("secondary", "sm")} disabled={page >= pages} onClick={() => onChange(page + 1)}>
        다음
      </button>
      <span className="ml-1 text-xs text-text-3 tabular-nums">
        {page}/{pages}쪽
      </span>
    </nav>
  );
}
