import { SearchScreen } from "@/components/screens/search/SearchScreen";

/**
 * 정보 검색(/search, ADR 0041) — 기업·기관·사람·주제를 대상으로 풀어 최근 2년의 뉴스·공시·리서치·글을 모아 보는 화면. 회원 이상(D-1).
 * 라우트는 얇게, 그리기는 components/screens/search.
 */
export default function SearchPage() {
  return <SearchScreen />;
}
