# 任务 04：隔离环境装依赖并取数

依次完成四步：

1. 在工作区建 Python 虚拟环境 `.venv`
2. 用 `.venv` 的 pip 安装 `requests`
3. 写 `fetch_title.py`：用 requests 请求 `https://example.com`，
   打印页面 `<title>` 里的文字
4. 用 `.venv` 里的 python 跑通它

约束：不许动系统 Python，`requests` 必须装在 `.venv` 内。
