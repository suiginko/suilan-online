import { WordEntry } from './types';

export interface BankFile {
  v: 1;
  name: string;
  createdAt: number;
  count: number;
  algo: 'AES-GCM-256';
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string };
  iv: string;
  ciphertext: string;
  fingerprint: string;
}

export interface BankPayload {
  name: string;
  words: WordEntry[];
}

export const PBKDF2_ITERATIONS = 210_000;

const b64encode = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const b64decode = (str: string): Uint8Array => {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(view.byteLength);
  new Uint8Array(ab).set(view);
  return ab;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function fingerprintOf(ciphertext: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(ciphertext));
  return b64encode(digest).slice(0, 12);
}

export async function encryptBank(payload: BankPayload, passphrase: string): Promise<BankFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(plain))
  );
  return {
    v: 1,
    name: payload.name,
    createdAt: Date.now(),
    count: payload.words.length,
    algo: 'AES-GCM-256',
    kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: b64encode(toArrayBuffer(salt)) },
    iv: b64encode(toArrayBuffer(iv)),
    ciphertext: b64encode(toArrayBuffer(cipher)),
    fingerprint: await fingerprintOf(cipher),
  };
}

export async function decryptBank(fileText: string, passphrase: string): Promise<{ file: BankFile; payload: BankPayload }> {
  let file: BankFile;
  try {
    file = JSON.parse(fileText) as BankFile;
  } catch {
    throw new Error('文件不是合法的题库包');
  }
  if (file.v !== 1 || file.algo !== 'AES-GCM-256') throw new Error('题库包版本或算法不受支持');
  if (!file.kdf || !file.ciphertext) throw new Error('题库包结构不完整');

  const salt = b64decode(file.kdf.salt);
  const iv = b64decode(file.iv);
  const cipher = b64decode(file.ciphertext);
  const key = await deriveKey(passphrase, salt, file.kdf.iterations);

  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(cipher));
  } catch {
    throw new Error('口令不正确，或题库包已损坏');
  }

  const payload = JSON.parse(new TextDecoder().decode(plain)) as BankPayload;
  if (!payload || !Array.isArray(payload.words) || payload.words.length < 25) {
    throw new Error('题库内容不足 25 词');
  }
  return { file, payload };
}

export function bankInfoOf(file: BankFile) {
  return { name: file.name, count: file.count, fingerprint: file.fingerprint };
}
