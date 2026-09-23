import { describe, expect, it, vi } from 'vitest'
import {
  authenticate,
  protectedResourceMetadata,
  requireBearerAuth,
} from '../../src/server/auth'
import type { ResourceServerAuth } from '../../src/server/auth'

const JWKS_URL = 'https://auth.example.com/jwks.json'
const RESOURCE = 'https://mcp.example.com'

type SigningAlg = 'RS256' | 'ES256'

type PublishedJwk = JsonWebKey & {
  kid: string
  alg: SigningAlg
  use: 'sig'
}

type SigningKey = {
  kid: string
  alg: SigningAlg
  privateKey: CryptoKey
  jwk: PublishedJwk
}

type JwtClaims = {
  exp: number
  nbf?: number
  sub?: string
  aud?: string | Array<string>
}

function mcpRequest(authorization?: string) {
  const headers = new Headers()
  if (authorization !== undefined) headers.set('Authorization', authorization)
  return new Request(`${RESOURCE}/mcp`, { method: 'POST', headers })
}

function bearerResult(
  authorization: string | undefined,
  auth: ResourceServerAuth,
) {
  return requireBearerAuth(mcpRequest(authorization), auth)
}

function futureExp(secondsFromNow = 60 * 60) {
  return Math.floor(Date.now() / 1000) + secondsFromNow
}

function bytesToBase64Url(bytes: Uint8Array) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function textToBase64Url(value: string) {
  return bytesToBase64Url(new TextEncoder().encode(value))
}

async function signingKey(alg: SigningAlg, kid: string): Promise<SigningKey> {
  const pair =
    alg === 'RS256'
      ? await crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256',
          },
          true,
          ['sign', 'verify'],
        )
      : await crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['sign', 'verify'],
        )
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    kid,
    alg,
    privateKey: pair.privateKey,
    jwk: { ...exported, kid, alg, use: 'sig' },
  }
}

async function signJwt(
  key: SigningKey,
  claims: JwtClaims,
  options?: { includeKid: boolean },
) {
  const includeKid = options === undefined ? true : options.includeKid
  const header = includeKid
    ? { alg: key.alg, typ: 'JWT', kid: key.kid }
    : { alg: key.alg, typ: 'JWT' }
  const encodedHeader = textToBase64Url(JSON.stringify(header))
  // `aud` is always checked. Most tests use a token for this server.
  const encodedPayload = textToBase64Url(
    JSON.stringify({ aud: RESOURCE, ...claims }),
  )
  const data = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  const algorithm =
    key.alg === 'RS256'
      ? 'RSASSA-PKCS1-v1_5'
      : { name: 'ECDSA', hash: 'SHA-256' }
  const signature = await crypto.subtle.sign(algorithm, key.privateKey, data)
  const encodedSignature = bytesToBase64Url(new Uint8Array(signature))
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`
}

function jwksAuth(keys: Array<unknown>): ResourceServerAuth {
  return {
    jwksUrl: JWKS_URL,
    resource: RESOURCE,
    fetch: async (input) => {
      const url = requestUrl(input)
      if (url !== JWKS_URL) return new Response(null, { status: 404 })
      return new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  }
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return input
}

function algNoneToken() {
  const header = textToBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const payload = textToBase64Url(
    JSON.stringify({ sub: 'user', exp: futureExp() }),
  )
  return `${header}.${payload}.not-a-signature`
}

describe('requireBearerAuth', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const response = await bearerResult(undefined, {
      verifyToken: async () => true,
    })
    expect(response?.status).toBe(401)
    expect(response?.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  it('returns 401 when verifyToken rejects the token', async () => {
    const response = await bearerResult('Bearer nope', {
      verifyToken: async () => false,
    })
    expect(response?.status).toBe(401)
    expect(response?.headers.get('WWW-Authenticate')).toBe(
      'Bearer error="invalid_token"',
    )
  })

  it('does not return 401 when verifyToken accepts the token', async () => {
    const response = await bearerResult('Bearer secret', {
      verifyToken: async (token) => token === 'secret',
    })
    expect(response).toBeUndefined()
  })

  it('does not return 401 for an RS256 token signed by the JWKS key', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, { sub: 'user', exp: futureExp() })
    const response = await bearerResult(`Bearer ${token}`, jwksAuth([key.jwk]))
    expect(response).toBeUndefined()
  })

  it('does not return 401 when the JWT has no kid and the JWKS has one key', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(
      key,
      { sub: 'user', exp: futureExp() },
      { includeKid: false },
    )
    const response = await bearerResult(`Bearer ${token}`, jwksAuth([key.jwk]))
    expect(response).toBeUndefined()
  })

  it('returns 401 when the RS256 signature does not match the JWKS key', async () => {
    const trusted = await signingKey('RS256', 'shared')
    const attacker = await signingKey('RS256', 'shared')
    const token = await signJwt(attacker, { sub: 'user', exp: futureExp() })
    const response = await bearerResult(
      `Bearer ${token}`,
      jwksAuth([trusted.jwk]),
    )
    expect(response?.status).toBe(401)
  })

  it('returns 401 when the JWT exp is in the past', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, {
      sub: 'user',
      exp: Math.floor(Date.now() / 1000) - 10,
    })
    const response = await bearerResult(`Bearer ${token}`, jwksAuth([key.jwk]))
    expect(response?.status).toBe(401)
  })

  it('returns 401 when the JWT nbf is in the future', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, {
      sub: 'user',
      exp: futureExp(2 * 60 * 60),
      nbf: futureExp(),
    })
    const response = await bearerResult(`Bearer ${token}`, jwksAuth([key.jwk]))
    expect(response?.status).toBe(401)
  })

  it('does not return 401 for an ES256 token signed by the JWKS key', async () => {
    const key = await signingKey('ES256', 'ec-1')
    const token = await signJwt(key, { sub: 'user', exp: futureExp() })
    const response = await bearerResult(`Bearer ${token}`, jwksAuth([key.jwk]))
    expect(response).toBeUndefined()
  })

  it('returns 401 for an alg none token', async () => {
    const response = await bearerResult(
      `Bearer ${algNoneToken()}`,
      jwksAuth([]),
    )
    expect(response?.status).toBe(401)
  })

  it('returns 401 when the JWKS response is not ok', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, { sub: 'user', exp: futureExp() })
    const response = await bearerResult(`Bearer ${token}`, {
      jwksUrl: JWKS_URL,
      resource: RESOURCE,
      fetch: async () =>
        new Response(JSON.stringify({ keys: [key.jwk] }), { status: 500 }),
    })
    expect(response?.status).toBe(401)
  })

  it('returns 401 when resource is set and aud does not match', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, {
      sub: 'user',
      exp: futureExp(),
      aud: 'https://other.example.com',
    })
    let fetches = 0
    const response = await bearerResult(`Bearer ${token}`, {
      jwksUrl: JWKS_URL,
      resource: RESOURCE,
      fetch: async () => {
        fetches += 1
        return new Response(JSON.stringify({ keys: [key.jwk] }), {
          status: 200,
        })
      },
    })
    expect(response?.status).toBe(401)
    expect(fetches).toBe(0)
  })

  it('accepts a token whose aud array contains resource', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, {
      sub: 'user',
      exp: futureExp(),
      aud: ['https://other.example.com', RESOURCE],
    })
    const response = await bearerResult(`Bearer ${token}`, {
      jwksUrl: JWKS_URL,
      resource: RESOURCE,
      fetch: async () =>
        new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 }),
    })
    expect(response).toBeUndefined()
  })

  it('reuses a fresh JWKS response for the same fetch function', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, {
      sub: 'user',
      exp: futureExp(),
      aud: RESOURCE,
    })
    let fetches = 0
    const auth = {
      jwksUrl: JWKS_URL,
      resource: RESOURCE,
      fetch: async () => {
        fetches += 1
        return new Response(JSON.stringify({ keys: [key.jwk] }), {
          status: 200,
        })
      },
    }
    expect(await bearerResult(`Bearer ${token}`, auth)).toBeUndefined()
    expect(await bearerResult(`Bearer ${token}`, auth)).toBeUndefined()
    expect(fetches).toBe(1)
  })

  it('fetches again for an unknown kid, but at most once in 30 seconds', async () => {
    const stale = await signingKey('RS256', 'old')
    const current = await signingKey('RS256', 'new')
    const token = await signJwt(current, { sub: 'user', exp: futureExp() })
    let fetches = 0
    const auth = {
      jwksUrl: JWKS_URL,
      resource: RESOURCE,
      fetch: async () => {
        fetches += 1
        const keys = fetches === 1 ? [stale.jwk] : [stale.jwk, current.jwk]
        return new Response(JSON.stringify({ keys }), { status: 200 })
      },
    }
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      expect((await bearerResult(`Bearer ${token}`, auth))?.status).toBe(401)
      expect((await bearerResult(`Bearer ${token}`, auth))?.status).toBe(401)
      expect(fetches).toBe(1)

      now.mockReturnValue(start + 31 * 1000)
      expect(await bearerResult(`Bearer ${token}`, auth)).toBeUndefined()
      expect(fetches).toBe(2)
    } finally {
      now.mockRestore()
    }
  })

  it('waits 30 seconds after a failed JWKS fetch before it fetches again', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, { sub: 'user', exp: futureExp() })
    let fetches = 0
    const auth = {
      jwksUrl: JWKS_URL,
      resource: RESOURCE,
      fetch: async () => {
        fetches += 1
        return new Response(null, { status: 503 })
      },
    }
    expect((await bearerResult(`Bearer ${token}`, auth))?.status).toBe(401)
    expect((await bearerResult(`Bearer ${token}`, auth))?.status).toBe(401)
    expect(fetches).toBe(1)
  })

  it('shares one JWKS fetch between requests that miss at the same time', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, { sub: 'user', exp: futureExp() })
    let fetches = 0
    const auth = {
      jwksUrl: JWKS_URL,
      resource: RESOURCE,
      fetch: async () => {
        fetches += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return new Response(JSON.stringify({ keys: [key.jwk] }), {
          status: 200,
        })
      },
    }
    const results = await Promise.all([
      bearerResult(`Bearer ${token}`, auth),
      bearerResult(`Bearer ${token}`, auth),
      bearerResult(`Bearer ${token}`, auth),
    ])
    expect(results).toEqual([undefined, undefined, undefined])
    expect(fetches).toBe(1)
  })

  it('keeps the RSA and EC keys when the JWKS also has an OKP key', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, { sub: 'user', exp: futureExp() })
    const okp = { kty: 'OKP', crv: 'Ed25519', x: 'abc', kid: 'ed-1' }
    const response = await bearerResult(
      `Bearer ${token}`,
      jwksAuth([okp, key.jwk]),
    )
    expect(response).toBeUndefined()
  })

  it('returns 401 when the JWT has no aud', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, {
      sub: 'user',
      exp: futureExp(),
      aud: [],
    })
    const response = await bearerResult(`Bearer ${token}`, jwksAuth([key.jwk]))
    expect(response?.status).toBe(401)
  })

  it('returns 401 when the JWKS fetch does not settle', async () => {
    const key = await signingKey('RS256', 'rsa-1')
    const token = await signJwt(key, { sub: 'user', exp: futureExp() })
    const response = await bearerResult(`Bearer ${token}`, {
      jwksUrl: JWKS_URL,
      resource: RESOURCE,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    })
    expect(response?.status).toBe(401)
  }, 10_000)
})

describe('authenticate', () => {
  it('returns the subject from verifyToken', async () => {
    const result = await authenticate(mcpRequest('Bearer secret'), {
      verifyToken: async () => ({ subject: 'alice' }),
    })
    expect(result).toEqual({ subject: 'alice' })
  })

  it('returns no subject when verifyToken returns true', async () => {
    const result = await authenticate(mcpRequest('Bearer secret'), {
      verifyToken: async () => true,
    })
    expect(result).toEqual({ subject: undefined })
  })

  it('returns the JWT sub as the subject', async () => {
    const key = await signingKey('ES256', 'ec-sub')
    const token = await signJwt(key, { sub: 'bob', exp: futureExp() })
    const result = await authenticate(
      mcpRequest(`Bearer ${token}`),
      jwksAuth([key.jwk]),
    )
    expect(result).toEqual({ subject: 'bob' })
  })
})

describe('protectedResourceMetadata', () => {
  it('returns JSON that lists the authorization server URL', async () => {
    const response = protectedResourceMetadata(RESOURCE, [
      'https://auth.example.com',
    ])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({
      resource: 'https://mcp.example.com',
      authorization_servers: ['https://auth.example.com'],
      bearer_methods_supported: ['header'],
    })
  })

  it('throws when no authorization server URL is passed', () => {
    expect(() => protectedResourceMetadata(RESOURCE, [])).toThrow(
      'protectedResourceMetadata needs a resource URL and at least one authorization server URL.',
    )
  })
})
