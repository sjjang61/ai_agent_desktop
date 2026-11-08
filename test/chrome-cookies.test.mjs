// node --test test/  (먼저 npm run build)
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { candidateHosts, checkChromeCookies, deriveKey, decryptValue, readChromeCookies, toElectronCookie } from '../dist/chrome-cookies.js'

const key = deriveKey('test-password')
function encrypt(plain, host, version) {
  const body = Buffer.concat([version >= 24 ? crypto.createHash('sha256').update(host).digest() : Buffer.alloc(0), Buffer.from(plain)])
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), c.update(body), c.final()])
}
const webkit = (unixSec) => Math.round((unixSec + 11644473600) * 1e6)

function makeChrome(version = 24) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-chrome-'))
  const profile = path.join(root, 'Default', 'Network')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }))
  const db = path.join(profile, 'Cookies')
  const future = webkit(Date.now() / 1000 + 86400)
  const past = webkit(Date.now() / 1000 - 86400)
  const hex = (b) => b.toString('hex')
  const sql = `
    CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('version','${version}');
    CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER);
    INSERT INTO cookies VALUES('.example.com','sid','',x'${hex(encrypt('SECRET1', '.example.com', version))}','/',${future},1,1,1,1);
    INSERT INTO cookies VALUES('www.example.com','host_only','plain','','/',${future},0,0,-1,1);
    INSERT INTO cookies VALUES('.example.com','expired','',x'${hex(encrypt('OLD', '.example.com', version))}','/',${past},1,0,0,1);
    INSERT INTO cookies VALUES('.evil-example.com','sid','',x'${hex(encrypt('NOPE', '.evil-example.com', version))}','/',${future},1,0,0,1);
    INSERT INTO cookies VALUES('.example.com','bad','',x'7631300102','/',${future},1,0,0,1);`
  execFileSync('/usr/bin/sqlite3', [db, sql])
  return root
}

test('candidateHosts: 상위 도메인 후보, 비 http 는 제외', () => {
  assert.deepEqual(candidateHosts('https://accounts.google.com/login'), ['accounts.google.com', 'google.com'])
  assert.deepEqual(candidateHosts('https://example.com'), ['example.com'])
  assert.deepEqual(candidateHosts('about:blank'), [])
  assert.deepEqual(candidateHosts('data:text/html,hi'), [])
})

test('decryptValue: 버전별 복호화, 잘못된 값은 null', () => {
  assert.equal(decryptValue(encrypt('abc', '.x.com', 24), key, 24), 'abc')
  assert.equal(decryptValue(encrypt('abc', '.x.com', 20), key, 20), 'abc')
  assert.equal(decryptValue(Buffer.from('xx'), key, 24), null)
  assert.equal(decryptValue(Buffer.from('v10zzzz'), key, 24), null)
})

test('check: 해당 사이트(상위 도메인 포함)만 세고 비슷한 도메인은 제외', async () => {
  const root = makeChrome()
  const r = await checkChromeCookies('https://www.example.com/login', root)
  assert.equal(r.count, 4) // .example.com 3개(만료·손상 포함, 복호화 전) + www.example.com 1개
  assert.equal((await checkChromeCookies('https://other.com', root)).count, 0)
  assert.equal(await checkChromeCookies('about:blank', root), null)
})

test('read: 복호화, 만료 제외, 손상 건너뜀, 다른 사이트 제외', async () => {
  for (const v of [24, 20]) {
    const root = makeChrome(v)
    const { cookies, skipped } = await readChromeCookies('https://www.example.com/', key, root)
    const names = cookies.map((c) => c.name).sort()
    assert.deepEqual(names, ['host_only', 'sid'])
    assert.equal(cookies.find((c) => c.name === 'sid').value, 'SECRET1')
    assert.equal(skipped, 1) // 손상된 값 1개
  }
})

test('toElectronCookie: 도메인 쿠키/호스트 전용/__Host- 처리', () => {
  const base = { value: 'v', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }
  assert.equal(toElectronCookie({ ...base, host: '.example.com', name: 'a' }).domain, '.example.com')
  assert.equal(toElectronCookie({ ...base, host: 'www.example.com', name: 'a' }).domain, undefined)
  assert.equal(toElectronCookie({ ...base, host: '.example.com', name: '__Host-a' }).domain, undefined)
  assert.equal(toElectronCookie({ ...base, host: '.example.com', name: 'a' }).url, 'https://example.com/')
})
