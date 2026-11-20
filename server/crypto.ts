import nodeCrypto from 'node:crypto';

/**
 * 服务端持有的两把派生密钥：
 *  - ENC：加密 vault（题库答案、席位令牌）。客户端能读表，但只能读到密文。
 *  - SIG：给公开快照签名。客户端能改表里的 state，但改完签名对不上，服务端会拒绝。
 *
 * 密钥只存在于服务端进程，不会进入任何前端 bundle。
 * 部署时可用 SUILAN_SECRET 覆盖。
 */
const SECRET =
  process.env.SUILAN_SECRET ?? 'suilan-online/rt-v1/2f9c1a7e5b3d84c6a0e2f71b9d4c8a35';

function derive(label: string): Buffer {
  return nodeCrypto.createHash('sha256').update(`${SECRET}::${label}`).digest();
}

const ENC_KEY = derive('vault');
const SIG_KEY = derive('sig');

/** 稳定序列化：键名排序，保证同一对象永远得到同一字符串 */
export function canon(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`).join(',')}}`;
}

/** AES-256-GCM 封装，输出 base64(iv|tag|body) */
export function seal(obj: unknown): string {
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function unseal<T>(blob: string): T {
  const raw = Buffer.from(blob, 'base64');
  if (raw.length < 29) throw new Error('vault 数据损坏');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as T;
}

export function signState(code: string, ver: number, state: unknown): string {
  return nodeCrypto
    .createHmac('sha256', SIG_KEY)
    .update(`${code}.${ver}.${canon(state)}`)
    .digest('base64url');
}

export function verifyState(code: string, ver: number, state: unknown, sig: string): boolean {
  const expect = signState(code, ver, state);
  if (expect.length !== sig.length) return false;
  return nodeCrypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig));
}

export function randomToken(bytes = 18): string {
  return nodeCrypto.randomBytes(bytes).toString('base64url');
}

/**
 * 房号：3 位纯数字（000–999），从最小空号开始顺序分配。
 * 这个游戏不会有很多房间同时开着，短号比长号好报、好记；
 * 撞号（并发建房或列表过期）时由建房流程顺延或回收过期房间后重试。
 *
 * @param used 已被占用的房号集合（含尚未清理的过期房间）
 * @returns 最小的未占用房号；1000 个号全被占用时返回 null
 */
export function nextRoomCode(used: Iterable<string>): string | null {
  const taken = used instanceof Set ? used : new Set(used);
  for (let i = 0; i < 1000; i++) {
    const code = String(i).padStart(3, '0');
    if (!taken.has(code)) return code;
  }
  return null;
}
