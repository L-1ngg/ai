/**
 * Accept or reject one bearer token.
 * Return true only for a token that can call this server.
 */
export type VerifyToken = (token: string) => Promise<boolean>

type JwksFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

type JwksAuth = {
  jwksUrl: string
  fetch?: JwksFetch
}

/**
 * Resource-server auth.
 * Pass `verifyToken`, or pass `jwksUrl` for an RS256 or ES256 JWT.
 */
export type ResourceServerAuth = { verifyToken: VerifyToken } | JwksAuth

type JwtHeader = {
  alg: string
  kid?: string
  crit?: unknown
}

type JwtPayload = {
  exp?: number
  nbf?: number
}

type ParsedJwt = {
  header: JwtHeader
  payload: JwtPayload
  signature: ArrayBuffer
  signingInput: string
}

const RS256 = 'RS256'
const ES256 = 'ES256'

// DOM JsonWebKey has no kid. RFC 7517 puts kid on the same object.
type ServerJwk = JsonWebKey & {
  kid?: string
}

/**
 * Checks the `Authorization: Bearer` token on an HTTP request.
 *
 * Pass `verifyToken`, or pass `jwksUrl`.
 * A missing token returns a 401 response.
 * An invalid token returns a 401 response.
 * A valid token returns `undefined`.
 *
 * The `jwksUrl` path checks an RS256 or ES256 signature with Web Crypto.
 * The JWT must include a future `exp`.
 * If the JWT includes `nbf`, this path checks that claim.
 * This path does not check the audience.
 * If the audience must match this server, pass `verifyToken`.
 *
 * @example
 * const denied = await requireBearerAuth(request, {
 *   verifyToken: async (token) => token === expected,
 * })
 * if (denied) return denied
 */
export async function requireBearerAuth(
  request: Request,
  auth: ResourceServerAuth,
) {
  const token = bearerToken(request)
  if (token === undefined) return unauthorized('missing')
  const valid = await tokenIsValid(token, auth)
  if (!valid) return unauthorized('invalid')
  return undefined
}

/**
 * Returns the OAuth protected-resource metadata document from RFC 9728.
 * Mount this response at `/.well-known/oauth-protected-resource`.
 *
 * `resource` is the MCP server URL.
 * `authorizationServers` lists the authorization server issuer URLs.
 * The document sets `bearer_methods_supported` to `header`.
 *
 * @example
 * return protectedResourceMetadata(
 *   'https://mcp.example.com',
 *   ['https://auth.example.com'],
 * )
 */
export function protectedResourceMetadata(
  resource: string,
  authorizationServers: ReadonlyArray<string>,
) {
  const resourceMissing = resource.length === 0
  const serversMissing = authorizationServers.length === 0
  const hasEmptyServer = authorizationServers.some((url) => url.length === 0)
  if (resourceMissing || serversMissing || hasEmptyServer) {
    throw new Error(
      'protectedResourceMetadata needs a resource URL and at least one authorization server URL.',
    )
  }

  const document = {
    resource,
    authorization_servers: [...authorizationServers],
    bearer_methods_supported: ['header'],
  }
  return new Response(JSON.stringify(document), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function bearerToken(request: Request) {
  const header = request.headers.get('Authorization')
  if (header === null) return undefined
  const match = /^Bearer +(\S+)$/i.exec(header.trim())
  if (match === null) return undefined
  const token = match[1]
  if (token === undefined || token.length === 0) return undefined
  return token
}

function unauthorized(kind: 'missing' | 'invalid') {
  const challenge =
    kind === 'missing' ? 'Bearer' : 'Bearer error="invalid_token"'
  return new Response(null, {
    status: 401,
    headers: { 'WWW-Authenticate': challenge },
  })
}

async function tokenIsValid(token: string, auth: ResourceServerAuth) {
  if ('verifyToken' in auth) return auth.verifyToken(token)
  return jwtIsValid(token, auth)
}

async function jwtIsValid(token: string, auth: JwksAuth) {
  const parsed = parsedJwt(token)
  if (parsed === undefined) return false
  if (!timeClaimsAllow(parsed.payload)) return false
  const supportedAlg =
    parsed.header.alg === RS256 || parsed.header.alg === ES256
  if (!supportedAlg) return false

  const keys = await fetchJwks(auth)
  if (keys === undefined) return false
  const jwk = jwkForHeader(keys, parsed.header)
  if (jwk === undefined) return false
  return verifySignature(parsed.header.alg, jwk, parsed)
}

function parsedJwt(token: string) {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const encodedHeader = parts[0]
  const encodedPayload = parts[1]
  const encodedSignature = parts[2]
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    return undefined
  }
  const emptyPart =
    encodedHeader.length === 0 ||
    encodedPayload.length === 0 ||
    encodedSignature.length === 0
  if (emptyPart) return undefined

  const header = parseJson(encodedHeader)
  const payload = parseJson(encodedPayload)
  if (!isJwtHeader(header) || !isJwtPayload(payload)) return undefined
  const blockedHeader =
    header.alg.toLowerCase() === 'none' || header.crit !== undefined
  if (blockedHeader) return undefined

  const signature = base64UrlToArrayBuffer(encodedSignature)
  if (signature === undefined) return undefined
  const parsed: ParsedJwt = {
    header,
    payload,
    signature,
    signingInput: `${encodedHeader}.${encodedPayload}`,
  }
  return parsed
}

function timeClaimsAllow(payload: JwtPayload) {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const exp = payload.exp
  const expOk = exp !== undefined && Number.isFinite(exp) && nowSeconds < exp
  if (!expOk) return false
  const nbf = payload.nbf
  if (nbf === undefined) return true
  return Number.isFinite(nbf) && nowSeconds >= nbf
}

async function fetchJwks(auth: JwksAuth) {
  // Use the caller jwksUrl only. Do not read jku from the token.
  const fetchImpl = auth.fetch ?? fetch
  try {
    const response = await fetchImpl(auth.jwksUrl)
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    if (!isJwks(body)) return undefined
    return body.keys
  } catch {
    return undefined
  }
}

function jwkForHeader(keys: ReadonlyArray<ServerJwk>, header: JwtHeader) {
  if (header.kid !== undefined) {
    return keys.find((key) => key.kid === header.kid)
  }
  if (keys.length !== 1) return undefined
  return keys[0]
}

async function verifySignature(alg: string, jwk: ServerJwk, parsed: ParsedJwt) {
  const algMismatch = typeof jwk.alg === 'string' && jwk.alg !== alg
  const wrongUse = jwk.use !== undefined && jwk.use !== 'sig'
  if (algMismatch || wrongUse) return false

  const data = toArrayBuffer(new TextEncoder().encode(parsed.signingInput))
  const publicKey = publicJwk(jwk)
  switch (alg) {
    case RS256:
      return verifyRs256(publicKey, parsed.signature, data)
    case ES256:
      return verifyEs256(publicKey, parsed.signature, data)
    default:
      return false
  }
}

async function verifyRs256(
  jwk: JsonWebKey,
  signature: ArrayBuffer,
  data: ArrayBuffer,
) {
  if (jwk.kty !== 'RSA') return false
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data)
  } catch {
    return false
  }
}

async function verifyEs256(
  jwk: JsonWebKey,
  signature: ArrayBuffer,
  data: ArrayBuffer,
) {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      data,
    )
  } catch {
    return false
  }
}

function publicJwk(jwk: ServerJwk) {
  const key: JsonWebKey = { kty: jwk.kty }
  if (jwk.alg !== undefined) key.alg = jwk.alg
  if (jwk.use !== undefined) key.use = jwk.use
  if (jwk.n !== undefined) key.n = jwk.n
  if (jwk.e !== undefined) key.e = jwk.e
  if (jwk.crv !== undefined) key.crv = jwk.crv
  if (jwk.x !== undefined) key.x = jwk.x
  if (jwk.y !== undefined) key.y = jwk.y
  return key
}

function parseJson(encoded: string) {
  const bytes = base64UrlToArrayBuffer(encoded)
  if (bytes === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return parsed
  } catch {
    return undefined
  }
}

function base64UrlToArrayBuffer(input: string) {
  try {
    const base64 = input.replaceAll('-', '+').replaceAll('_', '/')
    const padLength = (4 - (base64.length % 4)) % 4
    const binary = atob(`${base64}${'='.repeat(padLength)}`)
    return toArrayBuffer(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
  } catch {
    return undefined
  }
}

function toArrayBuffer(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJwtHeader(value: unknown): value is JwtHeader {
  if (!isRecord(value)) return false
  if (typeof value.alg !== 'string' || value.alg.length === 0) return false
  if (value.kid !== undefined && typeof value.kid !== 'string') return false
  return true
}

function isJwtPayload(value: unknown): value is JwtPayload {
  if (!isRecord(value)) return false
  if (value.exp !== undefined && typeof value.exp !== 'number') return false
  if (value.nbf !== undefined && typeof value.nbf !== 'number') return false
  return true
}

function isJwks(value: unknown): value is { keys: Array<ServerJwk> } {
  if (!isRecord(value) || !Array.isArray(value.keys)) return false
  return value.keys.every((key) => isJwk(key))
}

function isJwk(value: unknown): value is ServerJwk {
  if (!isRecord(value)) return false
  const supportedKty = value.kty === 'RSA' || value.kty === 'EC'
  if (!supportedKty) return false
  if (value.kid !== undefined && typeof value.kid !== 'string') return false
  return true
}
