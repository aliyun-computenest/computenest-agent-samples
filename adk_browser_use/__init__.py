"""ADK Browser Use - 基于 Google ADK 的浏览器自动化 Agent。"""

# 兼容缺少 _sqlite3 C 扩展的环境（如未编译 sqlite3 的 Python）
try:
    import sqlite3  # noqa: F401
except ModuleNotFoundError:
    import pysqlite3 as sqlite3_replacement  # type: ignore
    import sys
    sys.modules["sqlite3"] = sqlite3_replacement
    sys.modules["_sqlite3"] = sqlite3_replacement.dbapi2
