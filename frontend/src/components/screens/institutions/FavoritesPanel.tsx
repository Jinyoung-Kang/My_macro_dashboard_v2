"use client";

import { FilterList } from "@/components/patterns";
import { Button, Panel } from "@/components/ui";
import { useSec13fFavorites } from "@/hooks/useSec13fFavorites";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isOwner } from "@/lib/access";
import { institutionItems, type InstitutionFavoriteEntry } from "@/lib/institutionsScreen";
import { FavoritesEditDialog } from "./FavoritesEditDialog";

/**
 * 13F 포트폴리오 왼쪽 칸의 '즐겨찾기' 패널(ADR 0048) — 기관 목록 응답의 favorites를 '기관' 패널과 같은 거르기 목록(하나 고름)으로. 두 목록은 고른 기관
 * 하나를 함께 씁니다(이쪽 줄을 고르면 '기관' 목록에는 고른 줄이 없음). 비었으면 안내 글. 운영자에게만 머리 동작 '편집'(대화상자 — 찾기·더하기·지우기).
 * 목록 응답 하나에 함께 와서 처음 여는 요청 수는 그대로입니다. 기관 목록을 아직 못 받았으면 그리지 않습니다('기관' 패널이 읽는 중·오류를 보임).
 */
export function FavoritesPanel({
  favorites,
  defaultCiks,
  limit,
  selected,
  onSelect,
  reload,
}: {
  favorites: readonly InstitutionFavoriteEntry[];
  defaultCiks: readonly string[];
  limit: number | null;
  selected: string;
  onSelect: (cik: string) => void;
  reload: () => Promise<void> | void;
}) {
  const user = useSessionUser();
  const owner = isOwner(user);
  const editor = useSec13fFavorites(reload);
  const items = institutionItems(favorites);
  const count = items.length > 0 ? `${items.length.toLocaleString("ko-KR")}곳${limit ? ` / ${limit}` : ""}` : undefined;
  return (
    <Panel
      title="즐겨찾기"
      count={count}
      actions={
        owner ? (
          <FavoritesEditDialog
            favorites={favorites}
            defaultCiks={defaultCiks}
            editor={editor}
            trigger={
              <Button size="sm">
                편집 <span className="sr-only">13F 즐겨찾기</span>
              </Button>
            }
          />
        ) : undefined
      }
    >
      <FilterList
        label="즐겨찾기 기관"
        items={items.map((item) => ({ key: item.key, label: item.label }))}
        selected={[selected]}
        onToggle={onSelect}
        selection="single"
        narrow="wrap"
        emptyText={
          <p className="break-keep text-sm text-text-2">
            {owner ? "즐겨찾기한 기관이 없습니다. '편집'에서 13F 보고 기관을 더하세요." : "즐겨찾기한 기관이 없습니다."}
          </p>
        }
      />
    </Panel>
  );
}
