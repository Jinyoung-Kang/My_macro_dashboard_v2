import Link from "next/link";
import { AuthCard } from "@/components/auth/AuthCard";
import { AUTH_LINK_SHORT } from "@/components/auth/classes";

/**
 * 없는 주소의 화면(QA-270) — 앱이 만들지 않는 주소와 목록 밖의 정보 수집 분류·모의매매 탭(`/info/nope`·`/paper/us/nope`·`/paper/kr/nope` — dynamicParams
 * false라 화면이 그려지기 전에 404)이 여기로 옵니다. 동적 경로 화면이 주소 형식을 보고 부르는 notFound()(형식이 틀린 CIK·종목 주소·지표 키)는 셸 안 경계
 * app/(dashboard)/not-found.tsx가 같은 글로 셸 본문에 그립니다(QA-864).
 * 루트 not-found라 대시보드 셸(왼쪽 메뉴·상단바) 밖에서 그립니다 — 인증 화면과 같은 카드 틀(서버 컴포넌트, 어두운 토큰)이고 돌아갈 곳은 홈 하나입니다
 * (모의매매 등 운영자 전용 화면 링크는 회원·로그인 전 방문자에게 막힌 링크라 두지 않음). 탭 제목은 루트 metadata 그대로입니다(QA-270 사용자 결정).
 * 홈 링크는 두세 글자라 짧은 글 단추 누름 자리(AUTH_LINK_SHORT — 좁은 화면 높이·폭 44px, QA-862)입니다.
 */
export default function NotFound() {
  return (
    <AuthCard
      title="찾을 수 없는 화면"
      footer={
        <Link href="/" className={AUTH_LINK_SHORT}>
          ← 홈
        </Link>
      }
    >
      <p className="mt-2 text-sm leading-relaxed text-text-2">
        주소가 틀렸거나 없는 화면입니다. 주소를 확인하거나 홈에서 다시 찾아 주세요.
      </p>
    </AuthCard>
  );
}
