import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptBank } from '../src/bank';

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

const out = join(tmpdir(), `suilan-bank-${Date.now()}.sbank`);
execFileSync(
  process.execPath,
  [join(process.cwd(), 'tools', 'pack-bank.mjs'), '--demo', '--pass', 'demo123', '--out', out],
  { stdio: 'ignore' }
);

const text = readFileSync(out, 'utf8');
const json = JSON.parse(text);

console.log('\n[题库包] CLI 打包 → 浏览器同款 WebCrypto 解密');
check(json.v === 1 && json.algo === 'AES-GCM-256', '包格式为 v1 / AES-256-GCM');
check(!text.includes('向日葵'), '密文里读不到明文词语');
const src = readFileSync(join(process.cwd(), '词表随射.txt'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)[0];
check(typeof json.fingerprint === 'string' && json.fingerprint.length === 12, '带 12 位指纹');

const ok = await decryptBank(text, 'demo123');
check(ok.payload.words.length >= 25, `解密得到 ${ok.payload.words.length} 词`);
check(ok.payload.words[0].word === src, `首词与源词表一致（${src}）`);
// 词表里的「甲/乙」打包后仍然是同一个词的两种写法
const aliased = ok.payload.words.find((w: { alt?: string[] }) => w.alt?.length);
check(!!aliased, `斜杠写法被打包成别名（${aliased?.word} / ${aliased?.alt?.[0]}）`);
check(
  ok.payload.words.every((w: { word: string }) => !w.word.includes('/')),
  '打包后的词里没有残留斜杠'
);

let wrongMsg = '';
try {
  await decryptBank(text, 'bad-pass');
} catch (e) {
  wrongMsg = (e as Error).message;
}
check(wrongMsg.includes('口令'), '错误口令被拒');

const tampered = JSON.parse(text);
const buf = Buffer.from(tampered.ciphertext, 'base64');
buf[10] = buf[10] ^ 0xff;
tampered.ciphertext = buf.toString('base64');
let tamperMsg = '';
try {
  await decryptBank(JSON.stringify(tampered), 'demo123');
} catch (e) {
  tamperMsg = (e as Error).message;
}
check(tamperMsg.includes('损坏') || tamperMsg.includes('口令'), '篡改密文被拒（GCM 校验失败）');

rmSync(out, { force: true });

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
