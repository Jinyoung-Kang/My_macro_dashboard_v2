import { Banner, PageHeader } from "@/components/ui";

/**
 * 정보 검색 화면(ADR 0041). 단계 1(메뉴 재배치)에서는 탭이 빈 주소로 가지 않게 자리만 둡니다 — 외부 호출 없음.
 * 대상 검색·타임라인·관심 대상은 단계 2·3에서 이 자리에 들어옵니다.
 */
export function SearchScreen() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="정보 검색"
        description="기업·기관·사람 이름으로 최근 2년의 뉴스·공시·리서치·글을 모아 봅니다."
      />
      <Banner tone="info">
        준비 중입니다. 메뉴·지표·종목을 찾는 것은 상단의 통합 검색(Ctrl+K · ⌘K)을 쓰세요.
      </Banner>
    </div>
  );
}
