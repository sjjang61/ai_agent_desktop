# AI Agent Desktop

AI Agent Platform(`ai_agent_service`)의 macOS 데스크톱 셸. 왼쪽은 에이전트 UI, 오른쪽은 에이전트가 조작하는 내장 브라우저입니다.

## 실행 (개발)
1. 서버 쪽(`ai_agent_service`): 백엔드(8500)와 프론트(`npm run dev`, 5173)를 띄웁니다.
2. 서버 `.env` 에 추가하고 백엔드를 재시작합니다 (uvicorn --reload 는 .env 변경을 감지하지 않음).
   ```
   LOCAL_BROWSER_CDP_URL=http://127.0.0.1:9222
   LOCAL_BROWSER_USER_ID=<내 사용자 id>
   ```
3. `npm install && npm run dev`  (다른 포트의 UI: `AGENT_UI_URL=http://localhost:5174 npm run dev`)

환경변수: `AGENT_UI_URL`, `AGENT_SERVER_URL`(UI 와 서버 출처가 다를 때), `AGENT_CDP_PORT`(9222), `AGENT_START_PAGE`.

## 구조
- 내장 브라우저는 앱 UI 와 분리된 영구 세션(`persist:agent-browser`)을 씁니다.
- CDP 는 `127.0.0.1:9222`, 브라우저 targetId 안내(info)는 `127.0.0.1:9223` 에만 열립니다.
- 백엔드(`app/services/local_browser.py`)가 페이지 CDP 로 직접 조작합니다 (Playwright connect_over_cdp 는 Electron 에서 멈춰 사용하지 않음).
- 서버가 원격으로 이동하면 CDP 직접 접속 대신 토큰 인증 웹소켓 브리지로 교체해야 합니다.

## 주의
- 실행 환경에 `ELECTRON_RUN_AS_NODE=1` 이 있으면 Electron 이 Node 로만 실행됩니다 (npm 스크립트가 해제).

## 안전장치
- 에이전트가 명령을 보내는 동안 브라우저 위에 "조작 중" 배너와 **중지** 버튼이 나타납니다. 중지하면 그 작업(run)의 다음 명령부터 거부되고 에이전트는 멈춰서 보고합니다.
- 쓰기 동작 승인, 도메인 정책, 웹 콘텐츠 불신 규칙은 서버(`backend/app/services/browser_policy.py`)에 있습니다.
