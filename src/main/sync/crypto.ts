import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { gunzip, gzip } from 'node:zlib'
import { promisify } from 'node:util'

/** How files are stored in the sync repo: compressed, then encrypted when the repo uses
 *  encryption. Each file's name inside the repo is part of what's checked, so a file
 *  can't be swapped for another without it being noticed. */

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>

const MAGIC_ENCRYPTED = Buffer.from('CCS1')
const MAGIC_PLAIN = Buffer.from('CCP1')
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 }
const CHECK_TEXT = 'delegatto-sync-key-check'
const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export class WrongKeyError extends Error {
  constructor(message = "That recovery key doesn't match this sync repo.") {
    super(message)
    this.name = 'WrongKeyError'
  }
}

/** 25 random characters in five groups, without look-alike letters. */
export function newRecoveryKey(): string {
  const bytes = randomBytes(25)
  let out = ''
  for (let i = 0; i < 25; i++) {
    if (i > 0 && i % 5 === 0) out += '-'
    out += BASE32[bytes[i]! % BASE32.length]
  }
  return out
}

export function normalizeRecoveryKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** The key as it's shown: five groups of five, however it was typed. */
export function formatRecoveryKey(key: string): string {
  return normalizeRecoveryKey(key).replace(/(.{5})(?=.)/g, '$1-')
}

export type KdfHeader = { name: 'scrypt'; salt: string; N: number; r: number; p: number }

export function newKdf(): KdfHeader {
  return { name: 'scrypt', salt: randomBytes(16).toString('base64'), ...SCRYPT }
}

export async function deriveKey(recoveryKey: string, kdf: KdfHeader): Promise<Buffer> {
  return scryptAsync(normalizeRecoveryKey(recoveryKey), Buffer.from(kdf.salt, 'base64'), KEY_BYTES, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r
  })
}

function encrypt(key: Buffer, plain: Buffer, name: string): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(name, 'utf8'))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC_ENCRYPTED, iv, cipher.getAuthTag(), body])
}

function decrypt(key: Buffer, data: Buffer, name: string): Buffer {
  const start = MAGIC_ENCRYPTED.length
  const iv = data.subarray(start, start + IV_BYTES)
  const tag = data.subarray(start + IV_BYTES, start + IV_BYTES + TAG_BYTES)
  const body = data.subarray(start + IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(name, 'utf8'))
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new WrongKeyError(`${name} couldn't be decrypted. The key doesn't match, or the file was changed.`)
  }
}

export function keyCheck(key: Buffer): string {
  return encrypt(key, Buffer.from(CHECK_TEXT), 'check').toString('base64')
}

export function verifyKeyCheck(key: Buffer, check: string): boolean {
  try {
    return decrypt(key, Buffer.from(check, 'base64'), 'check').toString() === CHECK_TEXT
  } catch {
    return false
  }
}

/** Packs and unpacks repo files. A null key means the repo isn't encrypted. */
export class SyncCodec {
  constructor(private readonly key: Buffer | null) {}

  get encrypted(): boolean { return this.key !== null }

  /** Whether this key is the one a repo header's check was made with. */
  matches(check: string): boolean {
    return this.key !== null && verifyKeyCheck(this.key, check)
  }

  async pack(plain: Buffer, name: string): Promise<Buffer> {
    const packed = await gzipAsync(plain, { level: 6 })
    return this.key === null ? Buffer.concat([MAGIC_PLAIN, packed]) : encrypt(this.key, packed, name)
  }

  async unpack(data: Buffer, name: string): Promise<Buffer> {
    const magic = data.subarray(0, 4)
    if (magic.equals(MAGIC_ENCRYPTED)) {
      if (this.key === null) throw new WrongKeyError(`${name} is encrypted, but this PC has no key for it.`)
      return gunzipAsync(decrypt(this.key, data, name))
    }
    if (magic.equals(MAGIC_PLAIN)) {
      if (this.key !== null) throw new Error(`${name} isn't encrypted, but this sync repo should be.`)
      return gunzipAsync(data.subarray(4))
    }
    throw new Error(`${name} isn't a Delegatto sync file.`)
  }

  async packJson(value: unknown, name: string): Promise<Buffer> {
    return this.pack(Buffer.from(JSON.stringify(value), 'utf8'), name)
  }

  async unpackJson<T>(data: Buffer, name: string): Promise<T> {
    return JSON.parse((await this.unpack(data, name)).toString('utf8')) as T
  }
}
