import { Suspense } from "react";
import { Loading } from "@/components/ui";
import { SecurityScreen } from "./SecurityScreen";

/**
 * 보안 공지(/security, ADR 0046 — 운영자 전용, 읽기만). 라우트는 얇게, 그리기는 같은 폴더의 SecurityScreen. 화면이 주소의 쿼리(useSearchParams — 알림함
 * 링크의 `?ntt=<번호>`)를 읽으므로 Suspense로 감쌉니다 — 정적 페이지에서 감싸지 않으면 production 빌드가 실패합니다(Next 16 missing-suspense-with-csr-bailout,
 * 정보 검색 /search와 같음).
 */
export default function SecurityPage() {
  return (
    <Suspense fallback={<Loading />}>
      <SecurityScreen />
    </Suspense>
  );
}
