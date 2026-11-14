// AUTH-2b · 密码派生与校验（WebCrypto PBKDF2-HMAC-SHA256）
// 冻结约束：不降低算法强度、不换算法、不引入付费方案；迭代参数化且越界 fail-closed。
// 说明：JS/JIT 不保证严格恒定时间，timingSafeEqualStr 仅为尽力而为的逐字节比较。

export const PBKDF2_MIN_ITERATIONS = 100_000
export const PBKDF2_MAX_ITERATIONS = 1_000_000
export const DEFAULT_ITERATIONS = 100_000
export const HASH_BYTES = 32
export const SALT_BYTES = 16
export const TOKEN_BYTES = 32

/** 密码长度：Unicode 码点 [12,128]；UTF-8 字节 <= 512。不截断、不 trim、不转换大小写、不归一化。 */
export const PASSWORD_MIN_CHARS = 12
export const PASSWORD_MAX_CHARS = 128
export const PASSWORD_MAX_UTF8_BYTES = 512

/** 环境变量 / DB iterations 越界：不执行 KDF，直接失败（fail-closed）。 */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

/** 密码输入越界（长度 / 字符集）：必须在进入 KDF 之前抛出。 */
export class AuthInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthInputError'
  }
}

/** KDF 调用计数（仅用于可观测性 / 测试断言，不影响行为）。 */
export const kdfCallCount = { value: 0 }

/** 校验并规范化迭代次数：非法值抛 AuthConfigError，调用方不得继续执行 KDF。 */
export function parseIterations(raw: unknown): number {
  let n: number
  if (typeof raw === 'number') {
    n = raw
  } else if (typeof raw === 'string' && /^\d{1,7}$/.test(raw)) {
    n = Number(raw)
  } else {
    throw new AuthConfigError('AUTH_CONFIG_INVALID')
  }
  if (!Number.isSafeInteger(n) || n < PBKDF2_MIN_ITERATIONS || n > PBKDF2_MAX_ITERATIONS) {
    throw new AuthConfigError('AUTH_CONFIG_INVALID')
  }
  return n
}

/** 从环境变量读取迭代次数（可选，默认 100000）。 */
export function envIterations(env: { PBKDF2_ITERATIONS?: string }): number {
  return env.PBKDF2_ITERATIONS === undefined
    ? DEFAULT_ITERATIONS
    : parseIterations(env.PBKDF2_ITERATIONS)
}

/** DB 读出的 users.iterations / password_history.iterations 必须同样校验。 */
export function dbIterations(raw: unknown): number {
  return parseIterations(raw)
}

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function unb64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/** 严格 Base64 解码并校验字节长度；畸形值抛 AuthConfigError（fail-closed）。 */
export function decodeB64Exact(text: unknown, expectedBytes: number): Uint8Array {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0 || !BASE64_RE.test(text)) {
    throw new AuthConfigError('AUTH_CREDENTIAL_INVALID')
  }
  let bytes: Uint8Array
  try {
    bytes = unb64(text)
  } catch {
    throw new AuthConfigError('AUTH_CREDENTIAL_INVALID')
  }
  if (bytes.length !== expectedBytes) throw new AuthConfigError('AUTH_CREDENTIAL_INVALID')
  return bytes
}

/** 校验数据库中的 salt / password_hash 格式与长度；畸形值 fail-closed。 */
export function assertStoredCredential(hashB64: unknown, saltB64: unknown): { hash: string; salt: string } {
  if (typeof hashB64 !== 'string' || typeof saltB64 !== 'string') {
    throw new AuthConfigError('AUTH_CREDENTIAL_INVALID')
  }
  decodeB64Exact(saltB64, SALT_BYTES)
  decodeB64Exact(hashB64, HASH_BYTES)
  return { hash: hashB64, salt: saltB64 }
}

export function generateSaltB64(): string {
  return b64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)))
}

export function generateToken(): string {
  const raw = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  return b64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token)
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 逐字节 XOR 累加比较；长度差也计入。不宣称严格恒定时间。 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/**
 * 检测孤立 UTF-16 代理项。
 * 高代理项（D800-DBFF）后必须紧跟低代理项（DC00-DFFF）；低代理项前必须有配对高代理项。
 */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1 // 跳过合法低代理项
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // 走到这里说明前面没有配对的高代理项
      return true
    }
  }
  return false
}

/** 密码输入边界；返回错误信息码，null 表示合法。 */
export function validatePasswordInput(password: unknown): string | null {
  if (typeof password !== 'string') return 'INVALID_INPUT'
  const chars = Array.from(password).length
  if (chars < PASSWORD_MIN_CHARS || chars > PASSWORD_MAX_CHARS) return 'INVALID_INPUT'
  if (new TextEncoder().encode(password).byteLength > PASSWORD_MAX_UTF8_BYTES) return 'INVALID_INPUT'
  // 禁控制字符；保留合法 Unicode 与特殊字符
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(password)) return 'INVALID_INPUT'
  if (hasLoneSurrogate(password)) return 'INVALID_INPUT'
  return null
}

/** KDF 入口统一守卫：任何 KDF 路径都必须先通过密码输入边界。 */
function assertKdfPassword(password: unknown): string {
  const code = validatePasswordInput(password)
  if (code !== null) throw new AuthInputError(code)
  return password as string
}

async function pbkdf2(password: string, saltB64: string, iterations: number): Promise<string> {
  // 二次防线：任何派生前都重新校验迭代次数与密码输入边界
  const iter = parseIterations(iterations)
  const pw = assertKdfPassword(password)
  kdfCallCount.value += 1
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: iter },
    keyMaterial,
    HASH_BYTES * 8,
  )
  return b64(new Uint8Array(bits))
}

/** 派生新哈希。saltB64 为每用户独立 16B 随机盐。 */
export async function deriveHash(password: string, saltB64: string, iterations: number): Promise<string> {
  return pbkdf2(password, saltB64, iterations)
}

/** 校验已存储密码：使用用户记录自身的 iterations；salt/hash 畸形 fail-closed。 */
export async function verifyHash(
  password: string, hashB64: string, saltB64: string, iterations: unknown,
): Promise<boolean> {
  const iter = dbIterations(iterations)
  const cred = assertStoredCredential(hashB64, saltB64)
  const actual = await pbkdf2(password, cred.salt, iter)
  return timingSafeEqualStr(actual, cred.hash)
}

// 虚拟校验：固定有效参数 + 固定格式 dummy hash，用户不存在 / 禁用时同样消耗一次 KDF
export const DUMMY_SALT_B64 = 'AAAAAAAAAAAAAAAAAAAAAA=='
export const DUMMY_HASH_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

/**
 * 防用户枚举：与真实校验同形同参数量级，结果恒为 false。
 * 密码越界时直接返回 false（不进入 KDF），由调用方统一返回 401。
 */
export async function virtualVerify(password: unknown, iterations: number): Promise<false> {
  if (typeof password !== 'string' || validatePasswordInput(password) !== null) return false
  const actual = await pbkdf2(password, DUMMY_SALT_B64, parseIterations(iterations))
  timingSafeEqualStr(actual, DUMMY_HASH_B64)
  return false
}
