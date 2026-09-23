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

`verifyToken` returns `false` for a token that cannot call this server.

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
    resource: 'https://mcp.example.com',
  },
})
```

The server reads keys from `jwksUrl`.

- The algorithm is `RS256` or `ES256`.
- `exp` is in the future.
- If `nbf` is present, the current time is at or after `nbf`.
- If the JWT has `kid`, the JWKS contains that key.
- If the JWT has no `kid`, the JWKS contains one key.

`resource` is the URL of this server. It is required, because a token for a different API must not call your tools.

- A string `aud` must equal `resource`.
- An array `aud` must include `resource`.
- A missing or different `aud` returns 401.

If the JWKS request fails, the server returns 401. The server keeps the keys for 5 minutes. When a token has a new `kid`, the server gets the keys again, but not more than once in 30 seconds.

The server uses only RSA and EC keys. It skips other keys in the JWKS.

## Keep sessions and tasks per caller

Each user must see only the sessions and tasks that they started. Give each caller a subject:

```ts
import { createMCPServer } from '@tanstack/ai-mcp/server'

const server = createMCPServer({
  name: 'notes',
  version: '1.0.0',
  auth: {
    verifyToken: async (token) => {
      const user = await findUserByToken(token)
      return user ? { subject: user.id } : false
    },
  },
})

async function findUserByToken(token: string) {
  return token === process.env.MCP_TOKEN ? { id: 'user-1' } : undefined
}
```

- `verifyToken` returns `{ subject }` for a caller. It can also return `true`, and then the caller has no subject.
- The `jwksUrl` path uses the JWT `sub` claim as the subject.

A spec 2025 session belongs to the subject that opened it. A task belongs to the subject that started it. A request from another subject gets "not found".

A request with no token, or with a bad token, returns 401. The metadata URL names your authorization server. A request with the token you accept calls the server.
