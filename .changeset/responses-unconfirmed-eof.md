---
'@tanstack/openai-base': patch
---

Report OpenAI Responses streams that end without `response.completed` as `RUN_ERROR` instead of success. Preserve text already streamed to callers.
