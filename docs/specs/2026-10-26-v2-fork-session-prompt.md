# fork 세션 지시문 — `~/Projects/My_macro_dashboard_v2`에서 여는 첫 Claude 세션에 붙여 넣는 글

> 아래 구분선 사이를 그대로 붙여 넣으세요. 세션은 v2 폴더에서 열어야 합니다(`cd ~/Projects/My_macro_dashboard_v2` 뒤 `claude`).

---

이 폴더는 2026-10-26에 `My_macro_dashboard_v1`을 전체 이력으로 갈라낸 `My_macro_dashboard_v2`다. 원격은 공개 저장소
`Jinyoung-Kang/My_macro_dashboard_v2`이고 `main`은 v1 `main`과 같은 커밋에서 시작한다. 아직 포트·이름·쿠키는 v1 것 그대로다.

상황
- v1(`~/Projects/My_macro_dashboard_v1`, 3001/8081/8001/5433)은 AWS 운영본이자 로컬 스택으로 **교체 전까지 계속 돈다**. v3(3000/…)도 돈다.
  두 폴더·볼륨·스택·원격 저장소를 건드리지 않는다. 이 저장소의 명령은 이 폴더에서만 친다.
- 모의 알고리즘 매매 정기 작업은 AWS v1 한 곳에서만 돈다. 이 폴더의 `.env`는 `PAPER_ENABLED=false`를 유지한다(ADR 0019).
- 사용자는 git 명령을 직접 치지 않는다. 작업은 `claude/<주제>-2026-10` 브랜치 → `make test` → main fast-forward → push → CI 6 job 확인 → 커밋 번호와 함께 보고.

먼저 읽을 것(순서대로)
1. `CLAUDE.md`(아직 v1 기준 — G 항목에서 네가 고친다)
2. `docs/specs/2026-10-26-v2-program-plan.md` — 전체 순서·사용자 결정 V1~V8·전환 절차
3. `docs/specs/2026-10-26-v2-step0-fork.md` — 지금 할 일. **A는 clone·origin 설정까지 끝났고 GitHub 저장소 만들기·첫 push가 남았다**(A-1·A-2 결과 줄).
   첫 일: `gh repo view Jinyoung-Kang/My_macro_dashboard_v2`로 저장소가 있는지 본다. 있으면 `git push -u origin main`, 없으면 사용자에게 알리고
   허락을 받아 `gh repo create … --public`(V8 개정 — 2026-10-26에 만듦). 그 뒤 **B부터 I까지 순서대로**
4. `docs/specs/2026-10-26-v2-ui-design.md`, `docs/specs/2026-10-26-v2-kr-paper-spec.md`, `docs/specs/2026-10-26-v2-oss-adoption.md` — 1·2단계 설계(지금은 읽기만)
5. `docs/PRINCIPLES.md`, `docs/adr/README.md`, `docs/DEVELOPMENT.md`

지금 할 일: 0단계 B~I
- 체크리스트 항목마다 "확인" 줄을 통과한 뒤 다음으로. 커밋은 체크리스트가 정한 다섯 개로 나눈다(`chore(v2): …`, `feat(v2): …`, `feat(paper): …`, `docs(adr): …`, `docs: …`), 요약은 한국어, 끝에 `Co-Authored-By` 줄.
- B-3의 `.env`는 v1 `.env`를 복사해 포트 네 줄과 `PAPER_ENABLED=false`만 고친다. 내용을 화면에 출력하지 않는다. `.env`·`.env.qa`는 커밋하지 않는다.
- C의 데이터 이어받기는 `make backup`(v1 폴더) → `make restore F=…`(이 폴더)로 한다(ADR 0003). 볼륨 복사는 쓰지 않는다.
- 테스트는 `macrodash_test`만. 운영 DB로 테스트하지 않는다. 정기 작업을 켜지 않는다.
- 외부 패키지를 올리거나 더하지 않는다(0단계에는 없음). 1단계의 Radix UI primitives는 사용자가 허용했지만 설치는 1단계에서 npm GA 버전을 확인한 뒤.
- 막히면 가정을 적고 진행하되, 다음은 멈추고 묻는다: v1·v3에 영향이 가는 일, 비밀값을 다뤄야 하는 일, 체크리스트에 없는 구조 변경, 외부 저장소 push.

끝나면 보고
- 커밋 번호 5개·CI 결과, `make doctor`·`make test` 요약, `docker ps`의 세 스택 동시 가동 확인, 그대로 둔 v1 문자열 목록, 남은 질문.
- 그 다음은 1단계(UI)다. 바로 코드를 쓰지 말고 `docs/specs/2026-10-26-v2-ui-design.md` §3·§4·§10에 따라 **디자인 토큰(라이트·다크, 팔레트 검증기 통과값)과 셸 시안**을 먼저 만들어 보여 주고 승인을 받은 뒤 홈 → 모의매매(미국) 순서로 간다.

---
