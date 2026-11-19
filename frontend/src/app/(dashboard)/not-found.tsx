import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { FOCUS_RING, TEXT_TARGET } from "@/components/ui/classes";

/**
 * 셸 안 notFound()의 화면(QA-864) — 동적 경로 화면이 주소 형식을 보고 부르는 notFound()(숫자가 아닌 CIK `/institutions/abc`, 시장·코드 형식이 틀린 종목
 * `/s/xx/AAPL`, 모양이 틀린 지표 키 `/markets/i/a.b`)는 이 경계가 받아 셸(왼쪽 메뉴·상단바·빵부스러기) 본문에 그립니다. 여기로 오지 않는 것 — 모양은 맞지만
 * 저장본에 없는 지표(`/markets/i/zzz`)는 지표 화면이 '지표를 찾지 못했습니다'를 직접 그리고, 목록 밖의 정보 수집 분류·모의매매 탭(`/info/nope`·
 * `/paper/us/nope` — dynamicParams false라 화면이 그려지기 전에 404)과 앱이 만들지 않는 주소는 루트 not-found(app/not-found.tsx — 셸 밖 인증 카드)가 받습니다.
 * 글은 루트와 같고, 셸이 `<main>`을 가지므로 자기 `<main>`·카드 없이 화면 머리(h1)와 홈 링크 하나입니다. 서버 컴포넌트입니다(머리는 공용 클라이언트 부품을 그대로 씀).
 * 홈 링크는 따로 선 글 링크(강조 파랑 — 누를 수 있는 것)이고, 두세 글자라 좁은 화면에서 높이·폭 44px로 두되 글은 머리 시작선에 붙입니다(TEXT_TARGET + 폭 하한 —
 * 가운데에 놓는 TEXT_TARGET_SHORT는 시작선에서 밀림).
 */
const HOME_LINK = `${TEXT_TARGET} min-w-11 rounded-sm text-accent underline-offset-2 hover:text-accent-hover hover:underline lg:min-w-0 ${FOCUS_RING}`;

export default function DashboardNotFound() {
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      {/* 안내 한 줄은 낱말 사이에서만 꺾습니다 — 390에서 '…홈|에서'처럼 음절 사이가 갈렸습니다. 공용 머리 설명의 규칙은 다른 화면도 바꾸므로 여기만(정보 수집 머리와 같음). */}
      <PageHeader
        title="찾을 수 없는 화면"
        description={<span className="break-keep">주소가 틀렸거나 없는 화면입니다. 주소를 확인하거나 홈에서 다시 찾아 주세요.</span>}
      />
      <p className="text-sm">
        <Link href="/" className={HOME_LINK}>
          ← 홈
        </Link>
      </p>
    </div>
  );
}
