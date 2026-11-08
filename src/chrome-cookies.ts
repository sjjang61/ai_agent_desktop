/**
 * 로컬 Chrome(macOS)의 로그인 쿠키 조회·복호화.
 *
 * - 쿠키 DB(SQLite)는 Chrome 이 쓰는 중에도 읽을 수 있게 복사본으로 읽는다. macOS 기본 `sqlite3` 를 쓴다(네이티브 모듈 없음).
 * - 값 복호화 키는 키체인의 "Chrome Safe Storage" 암호에서 PBKDF2 로 만든다. 이 항목을 읽을 때 macOS 가 사용자에게 허용 여부를 묻는다.
 * - 쿠키 값은 이 모듈과 main 프로세스 안에서만 쓰고, 렌더러(UI)·서버·AI 로는 개수 같은 요약만 내보낸다.
 */
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface ChromeCookie {
  host: string // host_key (앞의 '.' 포함 가능)
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expires?: number // unix 초. 세션 쿠키면 없음
}

interface RawRow {
  host_key: string
  name: string
  value: string
  enc: string // hex
  path: string
  expires_utc: number
  is_secure: number
  is_httponly: number
  samesite: number
  has_expires: number
}

const CHROME_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
const WEBKIT_EPOCH_SEC = 11644473600 // 1601-01-01 ~ 1970-01-01

/** URL 의 호스트와, 같은 사이트의 상위 도메인 후보(최소 2단계). 예: accounts.google.com → [accounts.google.com, google.com] */
export function candidateHosts(url: string): string[] {
  let host = ''
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return []
    host = u.hostname.toLowerCase()
  } catch {
    return []
  }
  if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host ? [host] : []
  const parts = host.split('.')
  const out: string[] = []
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join('.'))
  return out.length ? out : [host]
}

/** SQL LIKE/동등 비교에 쓸 안전한 도메인 문자열만 허용한다 (SQL 주입 방지). */
function safeHost(h: string): boolean {
  return /^[a-z0-9.-]+$/.test(h) && h.length <= 253
}

export function lastUsedProfileDir(chromeDir = CHROME_DIR): string {
  const forced = process.env.AGENT_CHROME_PROFILE
  if (forced) return path.join(chromeDir, forced)
  try {
    const state = JSON.parse(fs.readFileSync(path.join(chromeDir, 'Local State'), 'utf8'))
    const last: string | undefined = state?.profile?.last_used
    if (last) return path.join(chromeDir, last)
  } catch { /* Local State 가 없으면 Default */ }
  return path.join(chromeDir, 'Default')
}

function cookiesDbPath(profileDir: string): string | null {
  for (const rel of [path.join('Network', 'Cookies'), 'Cookies']) {
    const p = path.join(profileDir, rel)
    if (fs.existsSync(p)) return p
  }
  return null
}

/** Chrome 이 DB 를 잠그고 있어도 읽을 수 있게 임시 폴더로 복사한다 (WAL 포함). */
function copyDb(dbPath: string): { dir: string; db: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-'))
  const db = path.join(dir, 'Cookies')
  fs.copyFileSync(dbPath, db)
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, db + ext)
  }
  return { dir, db }
}

async function sqliteJson(db: string, sql: string): Promise<any[]> {
  const { stdout } = await run('/usr/bin/sqlite3', ['-readonly', '-json', db, sql], { maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim() ? JSON.parse(stdout) : []
}

function hostWhere(hosts: string[]): string {
  const safe = hosts.filter(safeHost)
  if (!safe.length) return '0'
  // host_key 가 정확히 같거나 '.도메인' 이거나 '*.도메인' 인 것만 (예: evil-linkedin.com 은 제외)
  return safe.map((h) => `host_key = '${h}' OR host_key = '.${h}'`).join(' OR ')
}

export interface CookieCheck {
  profile: string
  count: number // 해당 사이트의 쿠키 개수(복호화하지 않음)
  domains: string[]
}

/** 현재 사이트의 쿠키가 Chrome 에 몇 개 있는지 센다. 키체인에 접근하지 않는다. */
export async function checkChromeCookies(url: string, chromeDir = CHROME_DIR): Promise<CookieCheck | null> {
  const hosts = candidateHosts(url)
  if (!hosts.length) return null
  const profileDir = lastUsedProfileDir(chromeDir)
  const dbPath = cookiesDbPath(profileDir)
  if (!dbPath) return { profile: path.basename(profileDir), count: 0, domains: hosts }
  const { dir, db } = copyDb(dbPath)
  try {
    const rows = await sqliteJson(db, `SELECT COUNT(*) AS n FROM cookies WHERE ${hostWhere(hosts)}`)
    return { profile: path.basename(profileDir), count: Number(rows[0]?.n ?? 0), domains: hosts }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 키체인의 Chrome 암호로 쿠키 복호화 키를 만든다. macOS 가 접근 허용을 묻는다. */
export async function chromeKey(): Promise<Buffer> {
  const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'])
  return deriveKey(stdout.replace(/\n$/, ''))
}

export function deriveKey(password: string): Buffer {
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
}

/**
 * 값 복호화. 'v10' 접두 + AES-128-CBC(IV = 공백 16개). DB 버전 24+ 는 평문 앞에 host_key 의 SHA-256(32바이트)이 붙는다.
 * 복호화에 실패하면 null.
 */
export function decryptValue(enc: Buffer, key: Buffer, dbVersion: number): string | null {
  if (enc.length === 0) return ''
  const prefix = enc.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') return null
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    let plain = Buffer.concat([d.update(enc.subarray(3)), d.final()])
    if (dbVersion >= 24) plain = plain.subarray(32)
    return plain.toString('utf8')
  } catch {
    return null
  }
}

const SAMESITE: Record<number, ChromeCookie['sameSite']> = { [-1]: 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' }

/** 현재 사이트의 쿠키를 읽어 복호화한다. (읽기·복호화 실패 건수 skipped 를 함께 돌려준다) */
export async function readChromeCookies(
  url: string,
  key: Buffer,
  chromeDir = CHROME_DIR,
): Promise<{ cookies: ChromeCookie[]; skipped: number }> {
  const hosts = candidateHosts(url)
  if (!hosts.length) return { cookies: [], skipped: 0 }
  const dbPath = cookiesDbPath(lastUsedProfileDir(chromeDir))
  if (!dbPath) return { cookies: [], skipped: 0 }
  const { dir, db } = copyDb(dbPath)
  try {
    const meta = await sqliteJson(db, "SELECT value FROM meta WHERE key='version'")
    const version = Number(meta[0]?.value ?? 0)
    const rows = (await sqliteJson(
      db,
      `SELECT host_key, name, value, hex(encrypted_value) AS enc, path, expires_utc, is_secure, is_httponly, samesite, has_expires
       FROM cookies WHERE ${hostWhere(hosts)}`,
    )) as RawRow[]
    const now = Date.now() / 1000
    const cookies: ChromeCookie[] = []
    let skipped = 0
    for (const r of rows) {
      let value = r.value
      if (!value && r.enc) {
        const dec = decryptValue(Buffer.from(r.enc, 'hex'), key, version)
        if (dec === null) { skipped++; continue }
        value = dec
      }
      const expires = r.has_expires ? Number(r.expires_utc) / 1e6 - WEBKIT_EPOCH_SEC : undefined
      if (expires !== undefined && expires <= now) continue // 이미 만료
      cookies.push({
        host: r.host_key,
        name: r.name,
        value,
        path: r.path || '/',
        secure: !!r.is_secure,
        httpOnly: !!r.is_httponly,
        sameSite: SAMESITE[r.samesite] ?? 'unspecified',
        expires,
      })
    }
    return { cookies, skipped }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Electron session.cookies.set 인자로 변환한다. */
export function toElectronCookie(c: ChromeCookie) {
  const host = c.host.replace(/^\./, '')
  const hostPrefixed = c.name.startsWith('__Host-')
  return {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path}`,
    name: c.name,
    value: c.value,
    ...(hostPrefixed || !c.host.startsWith('.') ? {} : { domain: c.host }),
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    ...(c.expires !== undefined ? { expirationDate: c.expires } : {}),
  }
}
