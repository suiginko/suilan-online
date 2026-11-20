/**
 * 临时探针：示例题库从 48 词变成 2577 词后，一次写库要塞多少字节。
 * vault 里装着全部词（all + pool + cellWords），每次动作都整份重写。
 *
 * 用法：npx tsx test/__probe_vault.ts
 */
import { createRoom, prepareSecrets, withBank, advance } from '../src/engine';
import { DEMO_WORDS } from '../src/data/demoBank';
import { seal } from '../server/crypto';
import { SEAT_ORDER, WordEntry } from '../src/types';

const SMALL: WordEntry[] = Array.from({ length: 48 }, (_, i) => ({
  word: `示例词${String.fromCharCode(0x4e00 + i)}`,
  hint: '提示',
  category: '演示',
}));

function sizeOf(words: WordEntry[]) {
  let secrets = prepareSecrets(words);
  let state = withBank(createRoom('999'), { name: '词表', count: words.length, fingerprint: 'X' });
  for (const seat of SEAT_ORDER) {
    const r = advance(state, secrets, 1);
    state = r.state;
    secrets = r.secrets;
  }
  const vault = { secrets, proposals: {}, seatTokens: {}, hostToken: 'h', spectators: {} };
  const blob = seal(vault);
  return {
    words: words.length,
    plainKB: JSON.stringify(vault).length / 1024,
    sealedKB: blob.length / 1024,
    sealedB64KB: Buffer.byteLength(blob, 'utf8') / 1024,
  };
}

const fmt = (o: Record<string, number>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${typeof v === 'number' && k !== 'words' ? v.toFixed(1) : v}`)
    .join(' ');

console.log('旧示例题库 ', fmt(sizeOf(SMALL)));
console.log('词表随射   ', fmt(sizeOf(DEMO_WORDS)));
