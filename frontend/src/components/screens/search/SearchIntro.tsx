import { PANEL, PaneHeading } from "./parts";

/**
 * 첫 화면의 설명 — 무엇을 어디서 얼마나 찾는지(외부 호출 없음). 관심 대상 목록·최근 글은 SearchHome이 옆에 그립니다.
 */
export function SearchIntro({ owner, demo }: { owner: boolean; demo: boolean }) {
  return (
    <section aria-labelledby="search-intro" className={`${PANEL} flex flex-col gap-3 p-4 text-sm leading-6 text-text-2`}>
      <PaneHeading id="search-intro">이 화면에서 찾는 것</PaneHeading>
      <p>
        기업·기관·사람 이름이나 티커·종목코드를 넣으면 먼저 <strong className="font-semibold text-text">대상</strong>으로 풀고(한글·영문 이름,
        별칭, 티커, CIK, DART 고유번호, 연결된 대상), 그 대상의 글을 <strong className="font-semibold text-text">최근 2년 안에서</strong> 최신순으로
        모읍니다. 어디에도 없는 말은 주제로 두고 그대로 찾습니다. 이름이 같은 후보가 여럿이면 직접 고릅니다.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          뉴스: 구글 뉴스(한국어·영어 판), Bing 뉴스, 이 대시보드가 받아 둔 사건 뉴스와 보도자료·경제지 피드. 종목이면 Yahoo Finance·네이버 종목 뉴스·연합인포맥스도.
        </li>
        <li>보유: 이 대시보드가 받는 13F 기관의 보유 줄(기업은 보유 기관, 기관은 상위 보유 종목).</li>
        <li>연결: Wikidata 관계(소유·창업·소속·모회사·자회사)와 13F 운용자·기관.</li>
        <li>
          관심 대상: 대상 머리의 &lsquo;관심 대상 등록&rsquo;으로 등록하면 서버가 대상마다 3~8시간에 한 번 새 글을 모으고, 왼쪽 목록에 마지막으로 본 뒤의
          새 글 수를 보입니다.
        </li>
        {owner ? <li>운영자: 수집 글(블로그·waedge)·거장 견해·속보도 섞고, 글·논평 탭에서 받아 둔 글을 엽니다.</li> : null}
      </ul>
      <p>
        기간은 7일·30일·1년·2년(기본 30일)으로 나눠 봅니다. 2년보다 오래된 글, 작성 시각을 모르는 글, 중국어 제목, 주소가 .cn인 매체와 제외 목록의 매체는 빼고
        출처마다 뺀 건수만 적습니다. 기사 본문은 받지 않고 제목·매체·시각·요약·원문 링크만 보입니다. 건수는 출처가 한 번에 주는 만큼이라 받은 자료 기준입니다.
      </p>
      {demo ? <p className="text-text-3">데모 열람은 외부 출처를 부르지 않고 이미 받아 둔 자료만 봅니다.</p> : null}
      <p className="text-xs text-text-3">
        키보드: <kbd className="rounded-sm border border-border px-1 font-sans">/</kbd> 검색창 · ↑↓ 결과 줄 옮기기 · Enter 원문 새 창. 메뉴·지표·종목 화면을
        찾는 것은 상단 통합 검색(Ctrl+K · ⌘K)입니다.
      </p>
    </section>
  );
}
