import type { JSX } from "react";

import { FilterList } from "@/components/patterns";

/** 거르기 칸 하나 — 키·이름·그 칸에 드는 줄 수(받은 줄 안). */
export type RowFilterChoice = { key: string; label: string; count: number };

/**
 * 받은 줄 거르기(작업대 P6 — 명세 §7-1 '체결·선정: 조밀 표와 필터') — 공용 거르기 목록(하나 고름, 넓은 화면도 30px 태그 줄 — `wide="wrap"`이라 좁은 화면 배치
 * `narrow`는 보지 않음), 칸 이름 뒤 줄 수. 표 위 한 줄입니다. 받은 줄만 거르고 새 요청이 없습니다. 쓰는 곳: 보유·체결 탭의 주문 상태·체결 방향, 미국 기관 선정
 * 후보, 한국 종목 선정 구성원.
 */
export function RowFilter({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly RowFilterChoice[];
  value: string;
  onChange: (key: string) => void;
}): JSX.Element {
  return (
    <div className="mb-2">
      <FilterList
        label={label}
        items={options.map((option) => ({ key: option.key, label: option.label, note: `${option.count}` }))}
        selected={[value]}
        onToggle={onChange}
        selection="single"
        wide="wrap"
      />
    </div>
  );
}
