/**
 * 가로 스크롤 줄(좁은 화면 하위 메뉴 줄 — P6에서 모의매매 탭 줄도)에서 칸 하나가 보이게 하는 줄의 scrollLeft — React를 모르는 순수 함수(ADR 0004). QA-510.
 * 세로판(넓은 화면 왼쪽 나무 메뉴 — QA-555)은 아래 navScrollTop입니다.
 *
 * 좌표는 줄 안 좌표입니다 — `item.left`는 칸의 offsetLeft(줄이 위치 기준 relative라 줄의 안쪽 가장자리부터, 스크롤과 상관없음), `view`는 줄의
 * 지금 scrollLeft와 보이는 폭(clientWidth).
 * - 칸이 다 보이면 그대로 둡니다(줄이 공연히 움직이지 않게).
 * - 왼쪽이 잘리면 칸 왼쪽이 여백(pad)만큼 안쪽에 오게, 오른쪽이 잘리면 칸 오른쪽이 여백만큼 안쪽에 오게 — 다음 칸이 조금 보여 줄이 이어진다는 것을 알립니다.
 * - 칸이 줄(여백 포함)보다 넓으면 왼쪽 끝을 맞춥니다(글의 앞이 보이게).
 * - 0 미만은 0입니다(줄 끝을 넘는 값은 브라우저가 줄입니다).
 */
export function stripScrollLeft(
  view: { scrollLeft: number; clientWidth: number },
  item: { left: number; width: number },
  pad = 16,
): number {
  const { scrollLeft, clientWidth } = view;
  const right = item.left + item.width;
  if (item.left >= scrollLeft && right <= scrollLeft + clientWidth) return scrollLeft;
  if (item.left < scrollLeft || item.width + 2 * pad > clientWidth) return Math.max(0, item.left - pad);
  return Math.max(0, right + pad - clientWidth);
}

/**
 * 세로로 스크롤하는 메뉴(넓은 화면 왼쪽 나무 메뉴 — QA-555)에서 칸 하나가 보이게 하는 메뉴의 scrollTop — stripScrollLeft의 세로판(규칙이 같음).
 *
 * `item.top`은 메뉴 스크롤 내용 안 좌표(칸 위 끝 − 메뉴 안쪽 위 끝 + 지금 scrollTop — 스크롤과 상관없음), `item.height`는 칸 높이, `view`는 메뉴의
 * 지금 scrollTop과 보이는 높이(clientHeight). 칸이 다 보이면 그대로, 위가 잘리면 칸 위가 여백만큼 안쪽에, 아래가 잘리면 칸 아래가 여백만큼 안쪽에
 * 오게, 칸이 메뉴(여백 포함)보다 높으면 위 끝을 맞춥니다. 0 미만은 0이고, 끝을 넘는 값은 브라우저가 줄입니다.
 */
export function navScrollTop(
  view: { scrollTop: number; clientHeight: number },
  item: { top: number; height: number },
  pad = 16,
): number {
  return stripScrollLeft({ scrollLeft: view.scrollTop, clientWidth: view.clientHeight }, { left: item.top, width: item.height }, pad);
}
