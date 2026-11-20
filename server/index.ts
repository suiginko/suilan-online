import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { SEAT_ORDER, SeatKey } from '../src/types';
import { DEMO_BANK_NAME, DEMO_WORDS } from '../src/data/demoBank';
import {
  RoomError,
  applyPlayerIntent,
  claimSeat,
  createNewRoom,
  importBankFile,
  importDemoBank,
  importTextBank,
  listRoomSummaries,
  readSnapshot,
  registerSpectator,
} from './service';

const app = express();
app.use(express.json({ limit: '4mb' }));

const SEAT_HEADER = 'x-seat-token';
const HOST_HEADER = 'x-host-token';
const WATCH_HEADER = 'x-watch-token';
const DEV_HEADER = 'x-dev-token';
/**
 * 设备号：比令牌更稳的身份线索。令牌会丢（清缓存 / 点过「返回」/ 换标签页），
 * 设备号留在那台机器的 localStorage 里，用来把同一个人认回来。
 * 它只是「同一台设备」的标记，不属于任何权限位——真正的权限仍由上面四枚令牌判定。
 */
const DEVICE_HEADER = 'x-device-id';

const tokenOf = (req: express.Request, header: string): string | null => {
  const raw = req.header(header);
  return raw && raw.length > 8 ? raw : null;
};

const seatTokenOf = (req: express.Request) => tokenOf(req, SEAT_HEADER);
const hostTokenOf = (req: express.Request) => tokenOf(req, HOST_HEADER);
const watchTokenOf = (req: express.Request) => tokenOf(req, WATCH_HEADER);
const devTokenOf = (req: express.Request) => tokenOf(req, DEV_HEADER);
const deviceIdOf = (req: express.Request) => tokenOf(req, DEVICE_HEADER);

function isSeat(v: unknown): v is SeatKey {
  return typeof v === 'string' && (SEAT_ORDER as string[]).includes(v);
}

function fail(res: express.Response, e: unknown) {
  if (e instanceof RoomError) {
    res.status(e.status).json({ error: e.message });
    return;
  }
  const msg = (e as Error)?.message ?? '服务器内部错误';
  console.error('[room]', msg);
  res.status(500).json({ error: msg });
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', app: '随蓝射覆对战' });
});

/** 房间大厅：落地页列出所有还活着的房间，不用先知道房号 */
app.get('/api/rooms', async (_req, res) => {
  try {
    res.json({ rooms: await listRoomSummaries() });
  } catch (e) {
    fail(res, e);
  }
});

/** 建房：房主默认是观众，可以自己坐进席位，也可以只负责审批题库 */
app.post('/api/rooms', async (req, res) => {
  try {
    const dev = req.body?.dev === true;
    res.json(await createNewRoom(String(req.body?.name ?? ''), dev, deviceIdOf(req)));
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/rooms/:code/seat', async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const seat = req.body?.seat;
    if (!isSeat(seat)) return res.status(400).json({ error: '席位不合法' });
    res.json(
      await claimSeat(
        code,
        seat,
        String(req.body?.name ?? ''),
        seatTokenOf(req),
        hostTokenOf(req),
        watchTokenOf(req),
        devTokenOf(req),
        deviceIdOf(req)
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

/** 以观众身份进入：不占席位，可看全部公开信息，也能随时接替空位 */
app.post('/api/rooms/:code/watch', async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    res.json(
      await registerSpectator(
        code,
        String(req.body?.name ?? ''),
        watchTokenOf(req),
        deviceIdOf(req),
        hostTokenOf(req)
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/rooms/:code', async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    res.json(
      await readSnapshot(
        code,
        seatTokenOf(req),
        hostTokenOf(req),
        watchTokenOf(req),
        devTokenOf(req),
        deviceIdOf(req)
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/rooms/:code/act', async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const intent = req.body?.intent;
    if (!intent || typeof intent !== 'object') {
      return res.status(400).json({ error: '缺少操作内容' });
    }
    res.json(
      await applyPlayerIntent(
        code,
        seatTokenOf(req),
        hostTokenOf(req),
        intent,
        watchTokenOf(req),
        devTokenOf(req),
        deviceIdOf(req)
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/rooms/:code/bank', async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const fileText = req.body?.fileText;
    const passphrase = req.body?.passphrase;
    if (typeof fileText !== 'string' || typeof passphrase !== 'string') {
      return res.status(400).json({ error: '缺少题库文件或口令' });
    }
    res.json(
      await importBankFile(
        code,
        seatTokenOf(req),
        hostTokenOf(req),
        watchTokenOf(req),
        fileText,
        passphrase,
        devTokenOf(req),
        deviceIdOf(req)
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/rooms/:code/bank/text', async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const words = req.body?.words;
    if (!Array.isArray(words)) return res.status(400).json({ error: '缺少词表' });
    res.json(
      await importTextBank(
        code,
        seatTokenOf(req),
        hostTokenOf(req),
        watchTokenOf(req),
        String(req.body?.name ?? ''),
        words,
        devTokenOf(req),
        deviceIdOf(req)
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/rooms/:code/bank/demo', async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    res.json(
      await importDemoBank(
        code,
        seatTokenOf(req),
        hostTokenOf(req),
        watchTokenOf(req),
        DEMO_BANK_NAME,
        DEMO_WORDS,
        devTokenOf(req),
        deviceIdOf(req)
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

/* 前端产物目录：优先 web（vite build.outDir），退回 dist 兼容老构建。
   为什么叫 web 而不叫 dist：发布工具按「构建产物」把 dist/ 整个排除在打包之外，
   留在 dist 会让线上一直跑上一次上传的旧前端（服务端代码倒是会更新）。 */
const webDir = [path.resolve(process.cwd(), 'web'), path.resolve(process.cwd(), 'dist')].find((d) =>
  fs.existsSync(path.join(d, 'index.html'))
);
if (webDir) {
  app.use(express.static(webDir, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(webDir, 'index.html'));
  });
}

app.use((_req, res) => {
  res.status(404).json({ error: '未找到' });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`随蓝射覆对战 server on :${PORT}`);
});

// 房间只存在进程内存里（server/store.ts），没有任何云服务依赖：
// 房号回收靠「活房才占号」这一步，死房的号直接回到分配池，撞号时原地覆盖。
// 代价是进程重启/重新发布后房间会清空——这是刻意的取舍，见 AGENTS 规则 R35。
