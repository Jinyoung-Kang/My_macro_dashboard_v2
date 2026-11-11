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

# root로 돌지 않습니다. 앱이 쓰는 곳은 /tmp(yfinance 캐시)와 홈(라이브러리 설정 캐시)뿐이고,
# 코드(/app)는 읽기만 합니다. 컨테이너가 뚫려도 이미지 안의 파일을 바꿀 수 없습니다.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app

COPY app ./app
# 복사한 코드는 맥의 파일 권한을 그대로 따라옵니다. 맥에서 어떤 파일이 소유자만 읽기(600)가 되면 이미지 안에서
# root 소유 600이 되고, 아래 USER app은 그 파일을 읽지 못해 수집기가 기동하자마자 PermissionError로 재시작을
# 반복했습니다(2026-10-08, 빈 __init__.py 두 개). git은 600과 644를 구분하지 않아 CI 빌드에서는 드러나지 않습니다.
# 누구나 읽기(디렉터리는 들어가기)만 허용하고, 쓰기 권한은 주지 않습니다.
RUN chmod -R a+rX /app/app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Seoul

USER app

EXPOSE 8000

# --no-access-log: 20초마다 오는 헬스체크 GET /health가 로그의 2/3를 차지해 실제 오류를 묻었습니다.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
