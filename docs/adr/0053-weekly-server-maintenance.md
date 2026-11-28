# 0053. 서버 주간 자동 유지보수: 토요일 17:30 KST에 백업 → Docker·Git → 이미지(코드는 받지 않음) → Tailscale(따로, 복구 한 번) → 필요할 때만 재부팅 → 확인 → 운영 봇 한 통

- 상태: 채택 (2026-11-28, 사용자 결정 — "권장안대로 계획을 세우라", 결정 2 'Tailscale도 자동으로 올림'은 같은 날 사용자 지시로 '제외'에서 바꿈, 구현 전 결정 1~7과
  코드를 보고 보탠 넷(이미지 패키지 층 넷 모두·ubuntu crontab + `sudo -n`·`@reboot` 이어 하기·가드 파일 분리)을 사용자가 승인). 단계 2(앱 의존성 — 결정 6)는 따로 승인받아 진행한다.
- 함께 보는 결정: [ADR 0023](0023-vultr-deployment.md)(Vultr 서버·Tailscale·개정 2026-11-12 재부팅 뒤 DNS 장애 QA-415·`reboot-check.sh`), [ADR 0028](0028-real-trade-mirror.md)·
  [ADR 0033](0033-real-isa-open-offset-and-stops.md)(실제 매매 가드 — 거래 창), [ADR 0046](0046-security-notices.md)(버전 목록 — 보고·로그에 버전을 넣지 않는 규칙),
  [ADR 0026](0026-polite-fetch-layers.md)(브라우저 이미지의 Chrome 주기 값 `CHROME_REFRESH` — QA-1004, 같은 방식).
- 지키는 방법(시험): `collector/tests/test_maintenance_script.py`(가드·잠금·판 대조에 걸리면 아무것도 바꾸지 않음 — 우회 값 무시, 단계가 실패하면 뒤 단계를 건너뛰고 멈춘 곳·할 일을 알림,
  `--dry-run`은 파일·`.git`·syslog·알림 쓰기 0, Tailscale은 Docker·Git·이미지 뒤·재부팅 앞에 따로, 어긋나면 진짜 `tailscale-up.sh`로 복구 한 번 — 그래도 어긋나면 재부팅하지 않음,
  재부팅 뒤 이어 하기와 표시가 없거나 오래된 재부팅, 보고·syslog에 버전 문자열·비밀값 없음, 보내지 못한 보고를 다음 실행·`reboot-check.sh`가 다시 보냄, root·서버 아님·모르는 인자),
  `collector/tests/test_vultr_scripts.py`(`deploy.sh --no-fetch`가 받지도 병합하지도 않음, 고친 파일·main 아님에 멈춤, 잠금, 끝까지 배포한 기록은 성공한 배포만, `OS_PKG_REFRESH`를 네 빌드에,
  가드 파일만 바뀌어도 새 판으로 다시 돎), `collector/tests/test_container_images.py`(네 Dockerfile의 OS 패키지 층이 `OS_PKG_REFRESH`를 참조하고 USER 앞, 수집기·브라우저는 pip·Chrome 층 뒤).

## 배경

2026-11-28에 서버 설정을 읽어 층마다 보안 업데이트가 어떻게 들어오는지 봤다.

| 층 | 그때 | 근거 |
|---|---|---|
| Ubuntu 패키지(보안·ESM) | 이미 자동(매일) | `50unattended-upgrades`의 허용 출처가 배포판·`-security`·ESM 둘 |
| 커널 적용(재부팅) | 사람이 함. 16:10 KST 알림만 | `Automatic-Reboot` 없음, `reboot-check.sh` |
| Docker·Compose·Tailscale·Git | 사람이 함 | 출처 `o=Docker`·`o=Tailscale`·`o=LP-PPA-git-core`가 허용 출처에 없음 |
| 컨테이너 이미지 | 배포할 때만 `--pull` | 배포가 없으면 이미지 안 패치가 쌓이지 않음. `apk upgrade` 층은 베이스 digest가 같으면 캐시된 채(QA-263의 남은 한계) |
| 앱 의존성 | 사람이 함. CI 점검은 push 때만 | `ci.yml`에 일정 없음, `dependabot.yml` 없음, Maven 점검 없음 |

같은 날 Docker의 보안 수정 두 건이 나흘 동안 적용되지 않은 채 있었다(보호나라 공지에도 `/security` 화면에도 잡히지 않음). 손으로 한 순서(백업 → Docker 올림 → 재부팅 → 확인)는
컨테이너 여섯이 24초 안에 건강해지고 재부팅이 36초 만에 돌아오는 짧은 일이었다. 보호나라 공지는 이 스택의 일부만 다루고 늦게 올라와 업데이트의 계기로 쓰지 않는다 — 업데이트는 출처별로
주기적으로 돌리고, `/security` 화면은 빠진 것이 없는지 대조하는 데 둔다.

## 결정

1. **시각은 토요일 17:30 KST(08:30 UTC) 한 번.** 한국·미국 장이 모두 닫혀 있고 실제 매매 창 밖이다. 다른 cron(백업 08:00·일 23:00, 재부팅 점검 16:10, 버전 목록 16:20·07:20,
   복원 확인 토 09:30)과 겹치지 않고, 월요일 08:45 전에 일요일 하루가 남는다. cron 줄은 ubuntu 사용자의 crontab에 둘 —
   `30 8 * * 6 …/maintenance.sh`와 재부팅 뒤 이어 하기 `@reboot …/maintenance.sh --after-reboot`.
2. **Tailscale도 자동으로 올린다**(사용자 지시 — 처음 계획은 '제외, 보고만'). 접속 통로 자체이고 2026-11-12에 재부팅 뒤 DNS 장애가 있었으므로:
   - 다른 패키지·이미지를 다 올린 **뒤**, 재부팅 **앞**에 따로 올린다(어긋나도 나머지는 끝나 있고, 어긋난 채로 재부팅하지 않는다).
   - 올린 뒤(올릴 것이 없어도) 넷을 본다: `tailscaled` 동작, tailnet 연결 `Running`, `tailscale serve`의 `https:443 → 127.0.0.1:8201` 줄, 이름 조회(`getent hosts api.telegram.org`와
     `/etc/resolv.conf`가 Tailscale 리졸버 `100.100.100.100`이 아님).
   - 어긋나면 문서의 복구(`sudo bash scripts/vultr/tailscale-up.sh` — 이미 tailnet에 있으면 키를 읽지 않음, stdin은 `/dev/null` — + 앱 컨테이너 다섯 재시작)를 **한 번만** 하고
     다시 본다. 그래도 어긋나면 멈추고 알린다(재부팅하지 않음). 재부팅 뒤 이름 조회·Tailscale이 어긋났을 때도 같은 복구를 한 번만 한다. 한 번을 허용하는 까닭: 이름 조회가 깨지면
     실패 알림조차 나가지 못한다.
   - 그 밖의 방법(로그아웃·재가입·키 사용·방화벽 변경)으로 스스로 고치지 않는다.
3. **코드는 새로 받지 않는다.** `deploy.sh`는 `origin/main`을 받아, 그대로 부르면 main에는 있지만 날짜를 정해 배포하기로 한 변경(모의 매매 조건의 첫 효과일)이 토요일에 저절로 나간다.
   `deploy.sh --no-fetch`(받기·병합·새 판으로 다시 돌기를 건너뜀 — 가드·빌드·배포 전 덤프·기동·스키마·정리는 그대로)만 쓴다. 나아가 서버 폴더의 판이 **마지막으로 끝까지 배포한 판**
   (`deploy.sh`가 성공한 끝에 남기는 `backups/.last-deploy-ok`)과 다르면 아무것도 하지 않고 알린다 — 빌드 실패나 기동 직전 가드로 멈춘 배포는 서버 폴더만 새 main이라, 다시 빌드하면 그 판이
   토요일에 뜨기 때문이다(사람이 `deploy.sh`를 끝까지 돌리면 풀림).
4. **재부팅은 필요 표시가 있을 때만**: `/var/run/reboot-required`가 있거나 `needrestart -b`가 새 커널 대기(`NEEDRESTART-KSTA` 2·3) 또는 재시작이 필요한 서비스(`NEEDRESTART-SVC`)를
   말할 때. 매주 무조건 재부팅하지 않는다. 재부팅 전에 표시 파일(`backups/.maintenance-reboot` — 시각·출력 파일·그때까지의 보고 줄)을 남기고, 부팅 뒤 `@reboot` cron이 6·7단계를
   마저 한다(표시가 2시간보다 오래됐으면 지우고 아무것도 하지 않음 — 손으로 한 재부팅에서 잘못 돌지 않게). Docker·Git·Tailscale을 올릴 때 needrestart는 목록만(`NEEDRESTART_MODE=l`) —
   재시작을 정하는 것은 이 스크립트다.
5. **실패하면 그 단계에서 멈추고 알린다.** 자동으로 되돌리거나 재시도하며 밀어붙이지 않는다(예외는 결정 2의 복구 한 번). 알림에 멈춘 단계와 사람이 할 일('실행:')을 적는다.
   알림을 보내지 못했으면 `backups/.maintenance-unsent`(소유자만)에 남겨 다음 실행의 보고에 붙여 보내고, 매일 16:10 KST의 `reboot-check.sh`(cron 길)도 다시 보낸다.
   단계 0 점검(잠금·도는 복원 확인·S3 백업·판 대조·`sudo -n`·실제 매매 가드) 가운데 하나라도 걸리면 아무것도 바꾸지 않고 '건너뜀'으로 알린다. 실제 매매 가드는 `deploy.sh`와 같은 함수
   (`scripts/vultr/realtrade-guard.sh`로 옮김 — 같은 판정, 같은 문구)이고, `REALTRADE_DEPLOY_OK` 같은 우회 값은 지우고 시작한다. 디스크를 바꾸는 단계(Docker·Git, Tailscale 복구, 재부팅)
   앞에서 다시 본다(이미지 단계는 `deploy.sh`가 빌드 전·기동 직전에 봄). 잠금은 `deploy.sh`와 같은 `backups/.deploy.lock` — 유지보수가 쥔 채 `deploy.sh`를 부르고(`DEPLOY_LOCK_HELD`),
   손으로 한 배포와 겹치지 않는다.
6. **앱 의존성은 Dependabot 보안 업데이트 + 주간 CI 점검**(버전 업데이트 PR은 켜지 않음 — PR이 쌓이지 않게). 단계 2로 따로 승인받아 넣는다(이 문서는 그때 덧붙인다).
7. **보고·syslog에 실제 버전 문자열을 넣지 않는다**(ADR 0046과 같은 규칙 — 패키지 이름·건수·단계 결과만, 판은 `/security` 버전 목록). `reboot-check.sh --summary`의 한 줄에는 커널 판이
   들어 있어 보고에는 결과(통과·경고)만 넣는다. 자세한 출력(apt·docker 빌드 — 판이 찍힘)은 서버의 `backups/maintenance/<UTC 시각>.log`(소유자만, 최근 12개)에만 둔다.
   텔레그램 값은 서버 `.env`에서 읽고 curl 설정(stdin)으로만 넘긴다(`notify-common.sh`).

덧붙여 정한 것(구현):

- **이미지 안 OS 패키지 층을 주마다 새로**: 네 Dockerfile이 `ARG OS_PKG_REFRESH`를 참조하는 올림 층을 둔다(backend·frontend `apk upgrade`, collector·browser `apt-get upgrade` —
  pip·Chrome 층 뒤라 의존성과 Chrome은 다시 받지 않음). `deploy.sh`가 기본 ISO 주를 넘기고(`CHROME_REFRESH`와 같은 방식), 유지보수는 그날 날짜를 넘겨 토요일마다 새로 만든다.
  값이 비면(로컬·CI) 캐시 그대로다. 2026-11-28 이 PC에서 backend·frontend·collector를 빌드했고, 값만 바꾸면 collector의 pip 층은 캐시를 쓰는 것을 봤다(browser는 CI가 빌드).
- **실행 계정**: ubuntu 사용자(docker 그룹 — `.env`·`backups/`의 소유자)로 돌고 apt·`tailscale-up.sh`·재부팅만 `sudo -n`(bootstrap이 만든 비밀번호 없는 sudo). root로 부르면 멈춘다
  (파일 소유자가 바뀜). 손으로 실제 실행할 때는 Tailscale을 올리는 동안 SSH가 끊겨도 끝까지 돌도록
  `sudo systemd-run --uid=ubuntu --gid=ubuntu --setenv=HOME=/home/ubuntu --unit=my-macro-maintenance-manual bash …/maintenance.sh`.
- **`--dry-run`**: 쓰기·syslog·알림 없이 점검 결과(걸린 까닭 모두)·올릴 Docker·Git·Tailscale 보류·재부팅 필요 여부·남은 보류 이름만 찍는다(apt 목록은 마지막으로 받은 것 —
  `apt-get update`도 하지 않음, `git status`는 색인을 고쳐 쓰지 않게).
- 기동(재부팅이면 부팅) 뒤 5분의 `ERROR` 줄 수는 실패 조건이 아니라 참고로 보고한다 — 정상 운영에도 수집 실패 줄이 있고, 재부팅 중 정상 종료 과정의 줄(`cannot schedule new futures
  after shutdown`)은 부팅 시각 앞이라 빠진다.

## 버린 대안

- **unattended-upgrades의 허용 출처에 Docker를 넣기**: 자동 업데이트가 15:58 KST에 돈 기록이 있다 — 한국 장 끝 무렵 컨테이너가 모두 재시작된다.
- **매주 무조건 재부팅**: 필요 없는 재부팅이 실제 매매 서버의 위험만 늘린다.
- **`deploy.sh`를 그대로 부르기**: 날짜를 정해 배포하기로 한 main의 변경이 토요일에 나간다(결정 3).
- **Tailscale을 자동에서 빼고 보고만**: 처음 계획이었으나 사용자 지시로 포함(결정 2의 안전장치를 둠).
- **가드를 유지보수에 다시 짜기**: 판정이 두 곳에 생겨 어긋날 수 있다 — `deploy.sh`에서 함수 파일로 옮겨 같이 쓴다.

## 결과와 남는 위험

- 실제 매매가 이 서버에서 돈다. 무인 업데이트가 잘못되면 월요일 08:45 전에 알아채고 고쳐야 한다 — 토요일 17:30이면 일요일 하루가 남는다.
- Docker 올림이 실패하면 컨테이너가 내려간 채 남을 수 있다. 멈춘 단계와 할 일을 알리지만 고치는 것은 사람이다.
- Tailscale을 무인으로 올리므로 끝내 올라오지 않으면 화면·Tailscale SSH·알림이 함께 닫힐 수 있다. **토요일 18:30까지 보고가 오지 않으면 그것이 신호**이고, 비상용 22(PC IP만)로 들어가
  `journalctl -t my-macro-maintenance`와 `backups/maintenance/`를 본다.
- needrestart가 매주 같은 서비스를 '재시작 필요'로 남기면 매주 재부팅하게 된다 — 첫 실행들의 보고(재부팅 까닭에 서비스 이름이 나옴)로 보고, 그러면 결정 4를 다시 정한다.
- 확인하지 못한 것(2026-11-28): Tailscale 패키지를 올릴 때 `tailscale serve` 설정과 `accept-dns=false`가 유지되는지(첫 실제 실행에서 봄 — 어긋나면 복구 한 번이 고침),
  브라우저 이미지의 `apt-get upgrade`가 Chrome 설치가 남긴 Google 저장소까지 올리는지(그러면 Chrome도 그날 오름 — 판을 고정하지 않으므로 같은 뜻), 서버의 needrestart 판이 `-b -r l`을
  받는지(미리 보기에서 봄).
