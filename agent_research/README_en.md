# AI Learning Assistant

## Overview

This example implements an **Intelligent Learning Research Assistant** based on [**AgentScope**](https://doc.agentscope.io/) and [**AgentScope Runtime**](https://runtime.agentscope.io/). It takes **natural language instructions** as input and uses **Playwright-driven browser** to automatically collect learning materials, accomplishing **① multi-platform data collection ② intelligent knowledge analysis ③ visualized learning report generation** — letting AI help you quickly understand and master various knowledge concepts.

The agent uses a **code-controlled workflow** design: **Data Collection → Knowledge Analysis → Document Writing → HTML Rendering**, with real-time status updates at each step. It uses **DashScope models** for streaming content generation and **AgentRun cloud sandbox** to provide an isolated browser environment with VNC real-time preview support.

## Core Features

- **Feature 1: Multi-platform Data Collection**: Automatically search on Baidu and deeply scrape learning materials from multiple platforms including Zhihu, Bilibili, CSDN, CNBlogs, etc., with relevance scoring and content deduplication.
- **Feature 2: Intelligent Knowledge Analysis**: Extract core concepts, assess learning difficulty, analyze content type distribution (definition/principle/application), and distill key knowledge points.
- **Feature 3: Visualized Learning Report**: Generate a knowledge explanation document with six chapters, automatically rendered into a beautiful HTML page with ECharts charts.
- **LLM Deep Exploration**: For platforms like Zhihu and Bilibili, use LLM to decide whether to deeply explore comment sections for additional learning discussions.
- **Data Quality Filtering**: Evaluate material relevance based on multiple dimensions including keyword matching, platform recognition, and timeliness, automatically filtering ads and low-quality content.
- **Cloud Sandbox Isolation**: Each session has its own dedicated AgentRun browser sandbox connected via CDP protocol, with VNC real-time preview support.
- **Real-time Status Push**: Uses AG-UI compatible SSE protocol to push collection progress, analysis status, and document generation progress in real-time.

## Directory Structure

```text
agent_research/
├── README.md
├── main.py                    # AgentScope + FastAPI service entry (default port 8090)
├── client.py                  # Test client (/api/agent SSE)
├── server.sh                  # start / stop / restart / status
├── requirements.txt
├── agents/
│   └── research_agent.py      # Core agent: data collection + knowledge analysis + document writing
├── configs/
│   └── mcp_config.json        # MCP configuration (extensible with other tools)
├── tools/
│   ├── analysis_standards.py  # Analysis standards: sentiment calculation, heat trend, keyword extraction
│   └── event_queue.py         # SSE event queue management
├── web/starter_webui/         # Next.js frontend (visualized dashboard)
└── logs/                      # Service runtime logs
```

**`main.py` and `agents/research_agent.py`**: `main.py` is the service entry point (`python main.py`); `research_agent.py` contains the complete Pipeline logic, referenced by `main.py` and **does not need to be executed independently**.

## Agent Architecture

```text
User Natural Language Instruction (e.g., Help me learn "Machine Learning")
    ↓
FastAPI + AG-UI SSE Protocol (/api/agent)
    ↓
Research Pipeline (Code-controlled workflow)
    ├── Phase 1: Data Collection
    │   ├── Generate multi-angle search queries (definition/principle/tutorial/zhihu/bilibili/blog/example/advanced)
    │   ├── Browser Sandbox → Baidu Search → Deep scrape detail pages
    │   ├── LLM exploration decision (Zhihu comments, Bilibili comments, etc.)
    │   └── Relevance evaluation + quality filtering
    ├── Phase 2: Knowledge Analysis
    │   ├── Statistics of data source distribution
    │   ├── DashScope streaming call → extract core concepts and knowledge points
    │   └── Generate difficulty assessment, learning heat, key opinions
    ├── Phase 3: Document Writing
    │   ├── DashScope streaming generation of Markdown document
    │   └── Contains: Concept Introduction, Core Principles, Detailed Explanation, Application Cases, Advanced Suggestions, References
    └── Phase 4: HTML Rendering
        ├── Markdown → HTML conversion
        └── ECharts charts (content type distribution, heat trend, source distribution, difficulty assessment, word cloud)
```

## Alibaba Cloud Compute Nest Deployment

Deploy this example with one click via Alibaba Cloud Compute Nest — no local environment setup required:

1. **Click Deploy**: Open the Compute Nest AI Learning Assistant deployment page and click "Deploy Now".
2. **Fill in Parameters**: Follow the page prompts to fill in parameters, and click "Create Now".
3. **Access the Instance**: After creation, you will be redirected to the instance page where you can access and use the Agent service via CLI or the frontend Web UI.

Open the WebUI, enter the knowledge topic you want to learn, and the system will automatically collect materials and generate a visualized learning report.

## Local Setup

### Environment Preparation

#### 1. Python

Python 3.10+ is recommended.

#### 2. Install Dependencies

```bash
cd agent_research
pip install -r requirements.txt
```

#### 3. Environment Variables

Copy `agent_research/.env.example` to `.env` (`cp .env.example .env`) or `export` in your shell:

| Variable | Required | Description |
|----------|----------|-------------|
| `DASHSCOPE_API_KEY` | Yes | DashScope API Key (starts with `sk-`), used for the chat model |
| `DASHSCOPE_MODEL_NAME` | No | Defaults to `qwen-max`; use a longer-context model for complex tasks |
| `AGENTRUN_TEMPLATE_ID` | Yes | AgentRun browser Sandbox template name, e.g. `sandbox-browser-xxxx` |
| `AGENTRUN_REGION` | No | AgentRun service region, defaults to `cn-hangzhou` |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | Yes | Alibaba Cloud AccessKey ID, used for AgentRun SDK authentication |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | Yes | Alibaba Cloud AccessKey Secret |

#### 4. AgentRun Sandbox

This example uses the cloud browser sandbox provided by **AgentRun**, with each session having its own isolated Chrome instance:

- **CDP URL**: Used by Playwright to connect and control the browser via CDP protocol for searching and content scraping.
- **VNC URL**: Used by the frontend for real-time browser preview to observe the data collection process.
- **Lifecycle**: Sandboxes are created on the first request of a session and automatically reclaimed after idle timeout.

Please enable AgentRun service in the [AgentRun Console](https://functionai.console.aliyun.com/cn-hangzhou/agent/runtime/sandbox).

### Starting the Service

#### Using server.sh

```bash
./server.sh start    # Start service
./server.sh stop     # Stop service
./server.sh restart  # Restart service
./server.sh status   # Check status
```

#### Manual Start (Development / Debugging)

```bash
cd agent_research
python main.py
```

The backend listens on **`http://0.0.0.0:8090`** by default. If the port is already in use, modify the port number in `main.py`.

### Test Client

```bash
python client.py
```

You can modify `BASE_URL`, `RUN_ID`, `THREAD_ID`, and the example instructions in `main()` within `client.py`.

## Example Prompts

- Help me learn and understand the basics of "Machine Learning"
- Help me learn and understand the core principles of "Deep Learning"
- Help me learn and understand "Natural Language Processing"
- Help me learn and understand the application scenarios of "Reinforcement Learning"
- Help me learn and understand the "Transformer Architecture"
- Help me learn and understand "Graph Neural Networks"

## Workflow Details

### Phase 1: Data Collection

1. **Query Generation**: Generate multi-angle search queries based on keywords, including:
   - Definition: `"{keyword} definition"`, `"{keyword} what is"`, `"{keyword} wiki"`
   - Principle: `"{keyword} principle"`, `"{keyword} explained"`, `"{keyword} tutorial"`
   - Tutorial: `"{keyword} tutorial"`, `"{keyword} beginner"`, `"{keyword} learn"`
   - Platform: `"{keyword} zhihu"`, `"{keyword} bilibili tutorial"`, `"{keyword} csdn"`
   - Application: `"{keyword} example"`, `"{keyword} case study"`, `"{keyword} application"`

2. **Search & Scrape**: Use Playwright to search on Baidu and deeply scrape the detailed content of each result page.

3. **Platform Adaptation**: Use specific content extraction selectors for different platforms (Zhihu, Bilibili, CSDN, Baidu Baike, etc.).

4. **LLM Exploration**: For platforms like Zhihu and Bilibili, use LLM to decide whether to deeply explore comment sections for additional content.

5. **Quality Filtering**: Evaluate relevance based on keyword matching, language consistency, platform weight, timeliness, etc., filtering ads and low-quality content.

### Phase 2: Knowledge Analysis

1. **Distribution Statistics**: Calculate data source platform distribution.
2. **Concept Extraction**: Call DashScope to extract 15-20 core concepts and terms.
3. **Difficulty Assessment**: Calculate comprehensive difficulty score and evaluate learning curve.
4. **Opinion Extraction**: Distill 5-8 most important knowledge points from materials.
5. **Learning Suggestions**: Generate prerequisite knowledge requirements and advanced direction suggestions.

### Phase 3: Document Writing

Use DashScope streaming to generate a Markdown document with six chapters:
- I. Concept Introduction
- II. Core Principles
- III. Detailed Explanation
- IV. Application Cases
- V. Related Knowledge and Advanced Topics
- VI. Summary and Learning Suggestions
- Appendix: References

### Phase 4: HTML Rendering

1. Convert Markdown to HTML.
2. Automatically embed ECharts charts:
   - Content type distribution (pie chart)
   - Learning heat trend (line chart)
   - Data source distribution (bar chart)
   - Learning difficulty assessment (gauge chart)
   - Core concept word cloud

## FAQ

- **Browser Sandbox creation fails**: Confirm that `AGENTRUN_TEMPLATE_ID`, `ALIBABA_CLOUD_ACCESS_KEY_ID`, and `ALIBABA_CLOUD_ACCESS_KEY_SECRET` are correctly configured and that the AgentRun service has been enabled in the console.
- **Few data collection results**: Try using more general keywords or increasing the `max_results` parameter value.
- **Slow analysis speed**: Complex topics require more data collection time; please be patient or choose a higher-performance model.
- **Generated document not detailed enough**: Try using a longer-context model (e.g., `qwen-long`) or explicitly request more detailed explanations in the prompt.
- **Invalid API Key**: Must be a DashScope general-purpose `sk-` key. See the [official documentation](https://help.aliyun.com/zh/model-studio/).
- **Port conflict**: Default port is **8090**. If it conflicts with another local service, update the port in `main.py` (and `BASE_URL` in `client.py`).

## References

- [AgentScope Documentation](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
- [AgentRun Console](https://functionai.console.aliyun.com/cn-hangzhou/agent/runtime/sandbox)
- [Alibaba Cloud DashScope (Bailian)](https://bailian.console.aliyun.com/)
