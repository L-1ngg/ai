---
title: MCP Server Auth
id: mcp-server-auth
order: 13
description: "Require a bearer token on an MCP server so only a client with that token can call it."
keywords:
  - tanstack ai
  - mcp
  - model context protocol
  - mcp server
  - bearer token
  - createMCPServer
  - verifyToken
  - jwksUrl
  - protectedResourceMetadata
---

Your MCP server is on a public URL. As a result, any client that can reach that URL can call your tools.

Pass `auth` to `createMCPServer`. Then a missing or bad token returns 401.

## `verifyToken`

1. Set `MCP_TOKEN` to the bearer token you accept.
2. Serve MCP with this handler.

```ts
import { createMCPServer, protectedResourceMetadata } from '@tanstack/ai-mcp/server'

const expected = process.env.MCP_TOKEN ?? ''
const resourceUrl = 'https://mcp.example.com'
const authorizationServerUrls = ['https://auth.example.com']

const server = createMCPServer({
  name: 'notes',
  version: '1.0.0',
  auth: {
    verifyToken: async (token) => token === expected,
  },
})

export default {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname
    if (path === '/.well-known/oauth-protected-resource') {
      return protectedResourceMetadata(resourceUrl, authorizationServerUrls)
    }
    return server.fetch(request)
  },
}
```

Add your tools on the `tools` field. If `MCP_TOKEN` is empty, `verifyToken` accepts no token.

`verifyToken` returns true only for a token that can call this server.

A missing token returns 401. In that response, the `WWW-Authenticate` header is `Bearer`. A bad token returns 401. In that response, the `WWW-Authenticate` header is `Bearer error="invalid_token"`.

`server.fetch` does not serve `/.well-known/oauth-protected-resource`. The response status is 404.

This package does not issue tokens. Your authorization server issues the token.

`protectedResourceMetadata` returns this JSON:

- `resource` is the MCP server URL.
- `authorization_servers` is the list of authorization server URLs.
- `bearer_methods_supported` is `header`.

Pass a resource URL and one or more authorization server URLs. Do not pass an empty URL.

The client sends `Authorization: Bearer` on each request. Read [Authentication](../tools/mcp#authentication) to send the token from a TanStack client.

## `jwksUrl`

Pass `jwksUrl` for an RS256 or ES256 JWT. Use the `fetch` handler from the previous section.

```ts
import { createMCPServer } from '@tanstack/ai-mcp/server'

const server = createMCPServer({
  name: 'notes',
  version: '1.0.0',
  auth: {
    jwksUrl: 'https://auth.example.com/jwks.json',
  },
})
```

The server reads keys from `jwksUrl`.

- The algorithm is `RS256` or `ES256`.
- `exp` is in the future.
- If `nbf` is present, the current time is at or after `nbf`.
- If the JWT has `kid`, the JWKS contains that key.
- If the JWT has no `kid`, the JWKS contains one key.

This path does not read `aud`.

If `aud` must match this server, pass `verifyToken`.

If the JWKS request fails, the server returns 401.

A request with no token, or with a bad token, returns 401. The metadata URL names your authorization server. A request with the token you accept calls the server.
