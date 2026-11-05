"""
app/services — 출처별 수집 함수.

yfinance를 쓰는 서비스(market·sector·krx·us_calendar·earnings_surprise·detail)가 어느 것이 먼저 import되든 그 전에, yfinance의 세션과
다운로드 스레드를 태스크 예산·무응답 래치를 보는 것으로 바꿉니다(app.yahoo, QA-255). 새 서비스가 yfinance를 쓸 때 세션을 따로 바꿀 필요는
없지만, 두 가지는 지킵니다: ``yf.download``에는 ``session=yahoo.session()``을 넘기고(넘기지 않으면 yfinance가 세션을 새 기본 세션으로 바꿈 —
시험이 훑음), Yahoo를 늘 부르는 새 태스크는 ``Task(..., yahoo=True)``로 표시합니다(시험이 태스크 목록을 대조).
"""
from .. import yahoo as _yahoo

_yahoo.install()
