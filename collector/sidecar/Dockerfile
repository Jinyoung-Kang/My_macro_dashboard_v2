# 브라우저 컨테이너 이미지 (ADR 0026 결정 8) — 차단 통과 수집 계층의 계층 2.
# 빌드 문맥은 collector/ 입니다(compose.vultr.yml: context ./collector, dockerfile sidecar/Dockerfile).
# 운영 서버의 compose 덧붙임에만 있는 서비스라 로컬·QA 스택에는 이 이미지가 없습니다.
FROM python:3.11-slim

# Chrome이 화면을 그릴 가상 디스플레이(Xvfb). Chrome과 그 시스템 라이브러리는 아래 patchright install이 받습니다.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# 의존성은 간접 의존성까지 고정돼 있습니다(sidecar/pinned.txt — CI의 pip-audit도 이 파일을 봅니다).
COPY sidecar/pinned.txt ./pinned.txt
RUN pip install --no-cache-dir -r pinned.txt

# Chrome 안정 채널과 의존 라이브러리 — 빌드 시점의 안정판을 받습니다(보안 패치를 받으려고 판을 고정하지 않음).
RUN patchright install --with-deps chrome \
    && rm -rf /var/lib/apt/lists/*

# root로 돌지 않습니다. 쓰는 곳은 프로필 볼륨(/profile)과 /tmp·홈뿐이고 코드는 읽기만 합니다.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app \
    && mkdir -p /profile \
    && chown app:app /profile

COPY sidecar ./sidecar
RUN chmod -R a+rX /srv/sidecar

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Seoul \
    BROWSER_PROFILE_DIR=/profile

USER app

EXPOSE 8191

# 가상 디스플레이 안에서 내부 서비스를 띄웁니다. 브라우저는 요청이 올 때만 뜨고 끝나면 닫힙니다.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1366x768x24", "uvicorn", "sidecar.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8191", "--no-access-log"]
