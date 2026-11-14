import { Suspense } from "react";
import { Loading } from "@/components/ui";
import { SearchScreen } from "@/components/screens/search/SearchScreen";

/**
 * 정보 검색(/search, ADR 0041) — 기업·기관·사람·주제를 대상으로 풀어 최근 2년의 뉴스·글·보유·연결을 모아 보는 화면. 회원 이상(D-1).
 * 라우트는 얇게, 그리기는 components/screens/search. 화면이 주소의 쿼리(useSearchParams)를 읽으므로 Suspense로 감쌉니다 —
 * 정적 페이지에서 감싸지 않으면 production 빌드가 실패합니다(Next 16 missing-suspense-with-csr-bailout).
 */
export default function SearchPage() {
  return (
    <Suspense fallback={<Loading />}>
      <SearchScreen />
    </Suspense>
  );
}
