# 수집기 이미지 (Python 3.11 + FastAPI)
FROM python:3.11-slim

# lxml 빌드와 TLS 검증에 필요한 최소 패키지만 설치합니다.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libxml2-dev libxslt1-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 운영 의존성만 설치합니다. 테스트 도구(pytest 등)는 requirements-dev.txt에 있습니다.
# 간접 의존성은 constraints.txt의 판으로 고정합니다 — 같은 커밋이면 언제 빌드해도 같은 이미지(make constraints로 갱신).
COPY requirements.txt constraints.txt ./
RUN pip install --no-cache-dir -r requirements.txt -c constraints.txt \
    && apt-get purge -y build-essential && apt-get autoremove -y

# 베이스 이미지에 든 패키지를 Debian 저장소의 수정판까지 올립니다. 위 설치 층은 패키지를 더할 뿐 올리지 않고, 층 캐시가 있으면 --pull도 다시 씁니다.
# 서버 배포(scripts/vultr/deploy.sh)가 OS_PKG_REFRESH(ISO 주, 주간 유지보수는 그날 날짜)를 넘겨 값이 바뀔 때 이 층을 새로 만듭니다(ADR 0053).
# pip 층 뒤에 두어 의존성 설치는 다시 하지 않습니다. 값이 비면(로컬·CI) 캐시 그대로.
ARG OS_PKG_REFRESH=
RUN echo "os packages refresh: ${OS_PKG_REFRESH}" \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# root로 돌지 않습니다. 앱이 쓰는 곳은 /tmp(yfinance 캐시)와 홈(라이브러리 설정 캐시)뿐이고,
# 코드(/app)는 읽기만 합니다. 컨테이너가 뚫려도 이미지 안의 파일을 바꿀 수 없습니다.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app

COPY app ./app
# 복사한 코드는 맥의 파일 권한을 그대로 따라옵니다. 맥에서 어떤 파일이 소유자만 읽기(600)가 되면 이미지 안에서
# root 소유 600이 되고, 아래 USER app은 그 파일을 읽지 못해 수집기가 기동하자마자 PermissionError로 재시작을
# 반복했습니다(2026-10-08, 빈 __init__.py 두 개). git은 600과 644를 구분하지 않아 CI 빌드에서는 드러나지 않습니다.
# 누구나 읽기(디렉터리는 들어가기)만 허용하고, 쓰기 권한은 주지 않습니다.
# 스키마 파일(저장소의 db/migrations)도 이미지에 넣습니다(QA-1036). 빌드 컨텍스트(collector/) 밖이라 compose의
# build.additional_contexts가 넘기는 이름 붙은 컨텍스트 migrations에서 복사합니다 — compose 없이 빌드하려면
# `docker build --build-context migrations=db/migrations collector`. 수집기는 기동할 때 이 폴더(MACRO_MIGRATIONS_DIR)에서
# 기록에 없는 번호만 적용하므로, 이미지가 아는 파일이 곧 적용하는 파일입니다(호스트 폴더를 마운트하지 않음).
COPY --from=migrations . /app/db/migrations/
RUN chmod -R a+rX /app/app /app/db

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Seoul

USER app

EXPOSE 8000

# --no-access-log: 20초마다 오는 헬스체크 GET /health가 로그의 2/3를 차지해 실제 오류를 묻었습니다.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
