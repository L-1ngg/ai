---
'@tanstack/ai': major
'@tanstack/ai-client': major
'@tanstack/ai-acp': major
'@tanstack/ai-anthropic': major
'@tanstack/ai-bedrock': major
'@tanstack/ai-byteplus': major
'@tanstack/ai-claude-code': major
'@tanstack/ai-codex': major
'@tanstack/ai-gemini': major
'@tanstack/ai-grok-build': major
'@tanstack/ai-mistral': major
'@tanstack/ai-ollama': major
'@tanstack/ai-opencode': major
'@tanstack/ai-openrouter': major
'@tanstack/openai-base': major
'@tanstack/ai-persistence': patch
---

Adopt AG-UI 1.0 event contracts and client validation. Public adapter and chat events now use `usage[]` with `inputTokens` and `outputTokens`; update third-party adapters and event consumers together.

Expand chunk events, apply activity and state patches, preserve reasoning message identity, and track subagent ownership. Frontend tools complete with successful `pendingToolCallIds` handoffs and return results through message history. Complete middleware and persistence when handing work to frontend tools.
