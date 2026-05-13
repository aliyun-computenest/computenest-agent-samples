# AgentScope 示例集合

本仓库收录基于 [AgentScope](https://doc.agentscope.io/) 与 [AgentScope Runtime](https://runtime.agentscope.io/) 的示例应用，各子目录独立运行，详见对应 `README.md`。

| 目录 | 说明 |
|------|------|
| `conversation/` | 对话与 MCP 示例 |
| `travel_planner/` | 智能旅行规划（高德 MCP、知识库、可选长期记忆） |
| `stock_analyst/` | 股票分析助手（数据分析 + 走势情景研判 + 投资参考建议；百炼 WebSearch MCP；**非持牌投顾**） |
| `opinion_analyst/` | 舆情 **Deep Research**（多轮子问题 + 百炼 WebSearch MCP + 工作区笔记 / 代码辅助） |
| `dashscope_memory/` | DashScope 长期记忆（画像 / 检索 / 写入）+ Runtime Session，无额外 MCP |
| `knowledge_rag/` | 企业知识库智能问答（阿里云百炼知识库 + ReActAgent 语义检索 + 多轮会话） |
| `browser_use/` | 智能浏览器操控助手（Playwright MCP + ReAct 循环 + 云端沙箱 CDP/VNC 预览） |
| `agent_research/` | AI 搜学助手（Playwright 多平台资料搜集 + 知识点分析 + 可视化 HTML 讲解报告） |
