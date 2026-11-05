"""
app/services — 출처별 수집 함수.

yfinance를 쓰는 서비스(market·sector·krx·us_calendar·earnings_surprise·detail)가 어느 것이 먼저 import되든 그 전에, yfinance의 세션과
다운로드 스레드를 태스크 예산·무응답 래치를 보는 것으로 바꿉니다(app.yahoo, QA-255). 새 서비스가 yfinance를 써도 따로 부를 필요가 없습니다.
"""
from .. import yahoo as _yahoo

_yahoo.install()
