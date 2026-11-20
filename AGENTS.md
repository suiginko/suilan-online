# AGENTS.md — 随蓝射覆 在线 2v2（OL 版）

> 给接手这个目录的 AI Agent 看的工作手册（Antigravity / WorkBuddy / 其他都可以）。
> 人类负责人：Hg。最后更新：2026-11-13（房间从云库搬回进程内存，战绩存档下线）。

---

## 1. 这是什么

无主持人的 2v2 在线猜词对战。四名选手分两队，每队一个「描述位」和一个「猜词位」，
选格方描述位写两个字的描述，本方猜词位据此猜答案；答错不换格，两队交替，直到有人猜对。

| 项目 | 值 |
|---|---|
| 线上地址 | https://suilan-online.app.workbuddy.host/ |
| WorkBuddy 应用 ID | `wbapp_6jSP6d9jaM7jLnfMFtXIqm` |
| 管理入口 | 「设置—数据管理—应用」 |
| 存储 | **进程内存**（`server/store.ts` 的 `Map`）+ `data/rooms.json` 快照；**不依赖任何云服务** |
| 原版主持人工作台 | 同级目录 `../随蓝射覆1`，**代码不共享**，见它自己的 `AGENTS.md` |

两套程序的关系：同一个游戏的两种形态。原版是「一个人当主持人、一台设备」；
OL 是「没有主持人、四台设备、服务端裁决」。规则语义可以互相参考，**但不要**把一边的组件/状态模型搬进另一边。

---

## 2. 四条硬约束（先读，能省掉半天返工）

1. **平台没有 WebSocket，也没有常驻定时器 / cron。**
   同步靠轮询（房间等待开局 1200ms、对局中 900ms、失败退避 2500ms，见 `src/net/room.ts`；
   落地页的「房间大厅」另有一个 5000ms 的列表轮询，见 `src/ui/App.tsx`）；
   超时靠「下一次有人访问时懒判定」（`tick` → `advance`）。不要为了"实时"引入 WS 或服务端 setInterval，
   部署环境会在请求结束后回收进程，定时器不会活下来。
2. **裁决必须在服务端。** 浏览器只提交 `Intent`（`src/types.ts`），状态由 `src/engine.ts` 的纯函数算出。
   答案永远不下发给非描述位（`server/service.ts` 的 `revealOf`）。
3. **状态存在服务端进程内存里**（`server/store.ts`）：`state`（公开快照）/ `sig`（HMAC）/
   `vault`（AES-GCM 密文）/ `ver`（乐观锁），形状与云库时代一致，但**没有任何云服务依赖**。
   代价：**进程重启或重新发布，房间全部清空**（R35）。不要在这上面再挂「长期存档」类需求。
4. **词表只在服务端落地。** 两条导入路线，落点一样：
   - **加密包**：`.sbank` 的 PBKDF2 解密发生在服务端请求里（`importBankFile` → `src/bank.ts`），词表只进 `vault`。
   - **明文词库**：浏览器先识别成词表（`src/bankText.ts`），明文随 `POST /bank/text` 上行，服务端用
     `normalizeEntries` **重新清洗/去重/判长度**后才进 `vault`（`importTextBank`）。
     明文因此会出现在**导入者自己那台设备**的编辑框里（这是「实时预览可改」的代价），
     但它和加密包一样**不进公开快照**：其他设备、观众、猜词位都拿不到。
   两条路都**不要**把词表挪到前端去发答案。

---

## 3. 架构

```
浏览器 × (4 选手 + N 观众)              Node/Express 进程                 进程内存 rooms Map
──────────────────────                ──────────────────               ──────────────────
每 0.9~1.2s GET /api/rooms/:code  ──▶  service.ts  用例层
提交意图 POST /act                    · 解析四枚令牌 → 身份
上传题库 POST /bank                   · 取锁（同房号串行）
                                      · load → 验签 → 解 vault
                                      ▼
                                   engine.ts  纯状态机
                                   · applyIntent（校验 + 落子）
                                   · tick（懒判定超时 / 自动开局）
                                      ▼
                                   store.ts  写回 ───────────────▶  Map.set + data/rooms.json（防抖 1.5s）
```

- **没有中间件、没有队列、没有云库**：一个房号的写操作用进程内 Promise 链串行化（`withLock`），
  `ver` 只是第二道保险（单进程本来不会撞）。
- **快照**：`GET` 只读也要推进（`readSnapshot` 里先 `advance`），所以「所有人关掉页面」时时钟停住，
  再次有人打开会按真实时间一次性追平。

---

## 4. 文件地图

| 文件 | 职责 | 改动时需要留意的点 |
|---|---|---|
| `src/types.ts` | 全部类型 + 常量（窗口时长、上限、席位定义） | `Intent` 联合类型改动会同时影响 engine / service / UI |
| `src/engine.ts` | **规则唯一真源**：`applyIntent` / `tick` / `advance` / `passAction` / `canSteal` / `undoableOf` / `dealBoard` / `beginGame` | 纯函数，禁止 IO；最好先写 `test/engine.spec.ts` 再改。首次开局与重开共用 `beginGame`（别复制一份发牌逻辑） 观众猜词的 `specGuess` 也在这里：只记在 `vault.specGuesses`，猜中只写一句「观众 xx 猜中了 A2 格」。 |
| `src/hex.ts` | 蜂巢几何（5×5 中心区）+ 连通判胜 | 坐标/半径改动会影响 `Board.tsx` 与 `exportImage.ts` 两处绘制。**坐标是真源，id 不是**：`refereeSwapCells` 只换 row/col、id 不动，所以换格之后 `cell-<r>-<c>` 不再代表坐标。判胜走 `neighborPositions()`（坐标），不要按 id 找邻居——踩坑 #38。 |
| `src/words.ts` | 首字母、字数、展示码、判词、`validateDescription` | 判词规则前后端共用，服务端才是权威；`isAnswerMatch(guess, word, alts)` 第三个参数是词表里的斜杠别名 |
| `src/bank.ts` | `.sbank` 加解密（WebCrypto，服务端复用） | 改格式要同时改 `tools/pack-bank.mjs` 与 `test/bank.spec.ts` |
| `src/bankText.ts` | **明文词库识别**：任意分隔 → 词表；`normalizeEntries` 是服务端唯一的清洗入口 | 前后端共用一份规则；改分隔符/列语义要同步 `test/bankText.spec.ts` 与 `tools/pack-bank.mjs` 的 `.txt` 约定。**斜杠不是词分隔，是别名**（见 R30） |
| `src/data/demoBank.ts` | 内置示例题库：把 `词表随射.txt` 原文交给 `parseWordList`，所以和用户上传同一份文件结果一致 | **不要手写词表**；改词表改根目录的 `词表随射.txt`，再 `npm run demo-bank` 重新生成 `src/data/demoText.ts`（`test/demoBank.spec.ts` 会拦住忘了生成的情况） |
| `src/data/demoText.ts` | **生成物**：词表原文（2579 行）以字符串常量形式内联，服务端打包后不依赖磁盘文件 | 只由 `tools/build-demo-bank.mjs` 写，不要手改 |
| `tools/build-demo-bank.mjs` | `npm run demo-bank`：`词表随射.txt` → `src/data/demoText.ts` | 中文不转义逐行字符串拼接，diff 里能直接看词 |
| `src/net/api.ts` | HTTP 客户端 + 凭证（localStorage） | 凭证是 `{seat, host, watch, dev}` 四枚令牌；另有 `deviceId()` 设备号，**不随 `clearCreds` 清除**；`apiListRooms()` 是落地页大厅的数据源 |
| `src/ui/App.tsx` | 落地页：昵称 / 建房 / 房号进入 / **房间大厅** | 大厅用 `GET /api/rooms`，5 秒轮询，且**只在 `stage.mode === 'landing'` 时跑**；手动输入房号与点大厅行都走同一个 `enterByCode()`——不要写两条进房路径，另一条很容易漏掉「按房号读凭据」这一步（会看到两个自己）**地址栏改写一律走 `src/share.ts`**（`roomQuery` / `landingHref`）：进房 `?room=000`、离房回落地页都必须保住 `?sharecode=`，抹掉之后玩家复制出去的邀请链接就是「链接不完整」——踩坑 #39。 |
| `src/share.ts` | 分享码（sharecode）在地址栏里的保留规则 | 纯函数，无副作用：`shareParam` 取码（小写/驼峰都认，输出统一小写）、`roomQuery` 拼进房地址、`landingHref` 拼离房地址。平台网关不带 sharecode 会 403，所以这里宁可多留不可少留。`test/share.spec.ts` 覆盖。 |
| `src/net/room.ts` | 轮询 hook，`send()` / `watch()` / `importBank()` / `importText()` | 老房间缺字段时 `normalize()` 兜底，别删；`send()` 返回 Promise，离席要等它落库；`watch()` 可能返回**席位令牌**（服务端认回座位时），按 `seat` 非空决定写哪个槽`specGuess()` 是唯一会读回执的发送口——回执只挂在那一次响应上（`guessResult`），不进 state。 |
| `src/ui/Room.tsx` | 单页房间：棋盘（席位卡浮在棋盘两侧的三角空地上）、行动面板、题库、战况、解散房间、开发者席位开关、复制局面图 | 所有操作按「席位视角」渲染，`can(seat)` 是权限唯一入口；解散是两步确认，`state.closedAt` 命中即整页早退为「房间已解散」；席位卡由 `seatCard()` 渲染、装进 `.board-area` 的两条 `.seat-rail`（绝对定位，不占网格列），DOM 顺序仍是 `SEAT_ORDER`（e2e 按下标取 `.roster-seat`）；战况在右栏最下方、**常驻展开**（早先的「展开/收起」按钮已删，日志最新在前、`log-item:first-child` 加粗）；对局历史装在 `.room-main` 里，**和棋盘同一列、同一条 flex 轴**（`gap:20px`）——不要把它放回「下一行栅格」，那一行的高度由更高的右栏决定，棋盘比右栏矮多少、棋盘下面就会空多少（Hg 报过「棋盘和对局历史之间出现空隙」）；单列（≤1120）时 `.room-main` / `.room-side` 都用 `display:contents` 拆开、靠 `order` 排成「棋盘 → 作答 → 对局历史 → 战况 → 题库」（所以右栏拆成 `.panel`(作答) 与 `.panel-more`(战况+题库) 两个盒子，桌面端靠 `.room-side` 拼回一列；**题库在战况下面**——它只在开局前用，战况是每回合都要看的）；手机上席位卡退化成角上一行字（`.seats-compact`），离席按钮在顶栏；`swapRow()` / `judgeRow()` / `undoRow()` 是三条申请行，发起方看到「撤销申请」、对方看到「同意」「拒绝」（R12c）；`ruleRow`（大厅「启用抢答功能」勾选框）在右栏那张行动卡里；**`restartButton()` 在顶栏**（对局级动作，见 R28）。行动卡头部 `.act-head` **只占一行**（代号 + 首字/字数 + 阶段 … 倒计时），且描述/作答/抢答三个阶段不再写阶段名（下面 `.turn-title` 已经写着「哪一方、做什么」）——Hg 报过「答题框太占地方，输入框上面还能合并精简」。**`swapDescSeat` 必须优先用 `devSeat`**（开发者可能一边坐着某席位一边代打另一席位，先取 `mySeat` 会让表态作用到自己身上）观众猜词行（`.spec-guess` / `data-spec-guess`）只在「不在席位上 + 有正在猜的格子」时出现，放在对局卡最后一行，不打断「轮到谁做什么」的主线。 |
| `src/ui/Board.tsx` | 蜂巢棋盘（无题库时画 25 个虚位并盖提示） | 已占领格两行显示代号 + 答案；答案的折行/字号**只在 `wordFit.ts` 里定**，别在组件里另写一套 |
| `src/ui/wordFit.ts` | 格子内答案的折行与字号（界面与导出图共用） | ≤6 字一行、≥7 字折两行；改阈值要同步 `test/wordFit.spec.ts` |
| `src/ui/Records.tsx` | 对局历史表（一格一行），只负责画 | 事件顺序由 `src/records.ts` 决定，别在组件里再写一套展开。**记录行只用正文字体**：格子码不套等宽、描述不套宋体（`.cell-code` / `.ev-desc` 都不写 `font-family`）；答对不加粗（`.ev-answer` 与 `.ev-guess` 同为 500），阵营只靠颜色与胶囊边框区分 |
| `src/ui/turn.ts` | `actingSeat()`，转发到 `engine.actingSeatOf` | 只是别名，别在这重复规则 |
| `src/ui/exportImage.ts` | Canvas 手绘局面图 → 剪贴板 | 不引第三方截图库；字体/坐标改动要看 `shot/export.png`；**版式必须与界面一致**（不做界面没有的装饰，不给对局中的座位挂「已准备」）。记录区的字体在 `evFont()` 里定，改界面 `.ev-*` 的字体/字重要同步这里 |
| `src/ui/Bank.tsx` | 题库面板：明文词库（粘贴/读文件 + 实时预览 + 逐条改）与加密包两条导入路线，外加审批 | 明文路线是「输入即解析」，改分隔规则看 `src/bankText.ts`；不要给编辑框加 maxLength，否则粘贴会被静默截断 |
| `src/records.ts` | **对局历史的事件展开 + 时间排序**（界面与导出图共用） | 抢答会插进对方的记录中间，必须按 `descAt`/`guessAt` 排序；改这里要同步 `test/records.spec.ts` |
| `src/identity.ts` | **身份解析（纯函数）**：令牌 → 设备号的双钥匙认人 + 幽灵条目清扫 | 改这里要同步 `test/identity.spec.ts`；deviceId 只进 vault，**绝不进公开快照** |
| `src/lobby.ts` | **大厅判废（纯函数）**：`abandonOf(state, updatedAt, now)` 与三档静默阈值 `ABANDON_IDLE_MS`（大厅 20 分钟 / 对局中 1 小时 / 已结束 2 小时）、`HEARTBEAT_MS` | 判废看的是「最后一次有人在线」（`updated_at`，由快照心跳续期），**不是**「最后一次状态变化」；改阈值同步 `test/abandon.spec.ts` |
| `server/index.ts` | 路由 + 静态 web | `GET /api/rooms` = 房间大厅（公开摘要列表）；四枚令牌 header：`x-seat-token` / `x-host-token` / `x-watch-token` / `x-dev-token`，外加 `x-device-id`（只做「认回同一个人」，不是权限位） |
| `server/service.ts` | 用例层：建房/入座/观战/意图/题库 + `listRoomSummaries()`（大厅列表）+ `sweepAbandoned()`（大厅顺手清理废房） | `listRoomSummaries()` **只读 `state`、不读 `vault`**，并在这里按「大厅房 → 对局中 → 已结束」+ 入座数排序；权限分组 `DEV_ONLY` / `HOST_ONLY` / `DISSOLVE` / `NEED_SEAT` / `RULE_SET` / `ANY_PARTICIPANT`；`restart` 在 `NEED_SEAT` 里（席位以令牌为准，不能替别人投票）；`specGuess` 在 `SPEC_ONLY` 里（有席位的人没有入口），身份由观战令牌覆盖。**结算不再落库**（R35），结束时什么都不用写 |
| `server/store.ts` | **进程内存存储**（`Map`）+ `data/rooms.json` 防抖快照：`loadRoom` / `insertRoom` / `casUpdate` / `listRoomCodes` / `listLiveRooms` / `touchRoom` / `reclaimExpiredRoom`，接口与云库版完全一致 | `liveOf()` 是唯一的「活房」判定（8 小时 TTL 内且未解散），`listRoomCodes` 与 `listLiveRooms` 必须共用它，否则大厅会列出点进去 404 的死房；`loadRoom` 对已解散的房按 `closedAt` 起算保留 10 分钟（`CLOSED_KEEP_MS`）再丢弃；**写盘只走防抖 + 原子 rename**，不要在每个请求里同步写文件；SIGINT/SIGTERM 会先 flush 再退出 |
| `server/crypto.ts` | vault 加解密、快照签名、令牌、房号分配（`nextRoomCode`，从 000 起顺序取最小空号） | 默认密钥可用 `SUILAN_SECRET` 覆盖 |
| `build-server.mjs` | esbuild 把 server 打成单文件 `dist-server/index.mjs` | 依赖保持 external，运行时靠 `npm install` |
| `test/*` | 三套测试，见第 8 节 | 改规则必须补断言 |

---

## 5. 规则不变量（产品决定，不要自行改回旧语义）

下表每一条都是用户明确拍过的。要动必须先问，不要"顺手优化"。

| # | 规则 | 备注 |
|---|---|---|
| R1 | 四人四席：`RED_DESC` / `RED_GUESS` / `GREEN_DESC` / `GREEN_GUESS` | 席位即身份，服务端按令牌反查 |
| R2 | 描述**必须正好两个汉字**，且不能含答案里的任何一个字 | `validateDescription`；前后端同一份判定 |
| R3 | 描述违规**只在点提交后**提示，输入过程中不提前警告 | 也不要给 `maxLength=2`，否则粘贴三字会被静默截断 |
| R4 | 描述与作答是**两段独立行动**，各自 90 秒 | 描述提交后进入作答窗口 |
| R5 | **描述超时不换人**：描述作废，仍由**本方猜词位**作答（可凭格子信息盲猜）；作答也超时才交棒给对方描述 | 见 `passAction`；这是用户第三轮明确要求 |
| R6 | 答错**不换格**，改由对方描述，两队交替直到有人猜对 | 极端情况下格子可以永远不了结 |
| R7 | 四席坐满 + 题库就绪 + **四人都准备** → 自动开局，不需要房主点开始 | `canStart` / `advance` |
| R8 | 房主默认是**观众**，可以一直不下场，只负责审批题库 | 建房不再自动占席 |
| R9 | **任何人**（含观众）都能上传题库，房主同意后才生效 | 词表进 `vault.proposals`，公开快照只有元信息 |
| R10 | 抢答只能发生在**对方描述已提交、对方作答之前**；只能由**猜词位**发起 | 描述位不显示抢答/防抢按钮 |
| R11 | **只有「抢」消耗预算**（红按行、绿按列各一次），**没抢到不消耗**；防抢答抢的是本应自己答的题，**不占次数、也不受预算限制** | `canSteal` / `consumeSteal` 只在 `case 'steal'` 里调用；`case 'lock'` 不碰 `stealUsed` |
| R12 | 抢答窗口 20 秒；防抢答锁定后本方作答也压到 20 秒 | `WINDOW_STEAL` |
| R12b | **防抢答 = 在自己的作答时机抢答本应自己答的题**：只在 `phase='guess'`（本方作答窗口已开）可用，描述还没写完时不算答题时机，引擎直接拒；效果等同抢答落地——20 秒独占、对方抢不了 | `case 'lock'`：`phase !== 'guess'` 即 fail；不调 `consumeSteal`。UI 的 `canLockNow` 同步只认 `guess`，按钮也不再因预算而禁用 |
| R12c | **每一条「申请」都要有同意和拒绝两个出口**：换题/判对（双票制）与撤回（单同意制）上，发起方看到「撤销申请」，对方看到「同意」「拒绝」；任一方作废都清空这条申请，不消耗本格换题机会 | `Intent {t:'reject', kind:'swap'\|'judge'\|'undo'}`；服务端把它归在 `NEED_SEAT`（席位以令牌为准）。换题/判对只有描述位能表态，撤回任意选手都能拒 |
| R12d | **抢答 / 防抢答谁先成功：不比时间戳，比服务端队列顺序**——两者共用 `state.steal` 的 `by` / `lockedBy` 一个互斥位，先写进去的占住，后到者直接被拒 | 引擎在做事前先查 `if (s.steal.by \|\| s.steal.lockedBy) return fail('本格抢答权已被占用')`（`case 'steal'` 与 `case 'lock'` 各一处），没有「谁的点击时间更早」这种比较；请求在 `withLock(房号)` 的 Promise 链上串行（`service.ts`），`now = Date.now()` 是**拿到锁之后**取的，所以日志时间也是排队时间。实测（本地用 `Promise.all` 同时发 steal/lock，两种顺序各 3 轮）：6/6 只有一个成功，0 平局、0 互相让路，先发出的那个总赢——玩家感到的「谁快」实质是**网络包到达顺序**。前提是**单进程部署**（锁是进程内的）；将来多副本时 `ver` 乐观锁会让落败方拿到 409「房间正忙」而非引擎拒绝。副作用：抢答成功后 `phase` 已变 `steal`，对方此时点防抢答先撞 `phase !== 'guess'`，回的是「只有在自己作答时才能防抢答」而不是「已被占用」 |
| R13 | 任何选手可**主动跳过**自己此刻的行动，规则与超时完全一致 | `Intent {t:'skip'}`，只允许当前行动席位发起 |
| R14 | 任意选手可随时**暂停**，计时冻结；继续后整体顺延 | 暂停条保持原长度与秒数，不要写成满条 |
| R15 | 超时/跳过记录**用本阵营颜色**，不用灰字 | `descPass` / `guessPass` → `ev-note.is-red/is-green` |
| R16 | 公开记录叫「**对局历史**」，显示整局所有格子（不只当前格） | 一词一格一行，答对那一条以「答案 ✓」收尾，不重复显示猜测词 |
| R17 | 房间号是 **3 位数字，从 000 起顺序分配**（`nextRoomCode` 取最小空号）；对局中观众可接替空位 | 对局中不允许换席（除非先离席） |
| R18 | 局面图是**复制到剪贴板**，不是下载文件 | 剪贴板不可用才降级下载 |
| R19 | 机器人已下线，改为**开发者模式**：隐藏口令 `suilan`（落地页依次敲键）→ 建房才发 dev 令牌 | 开发者可代打四席、看题面、一键坐满/准备；**不会自己行动** |
| R20 | 开发者代打时先选席位（顶栏 红描/红猜/绿描/绿猜），界面只显示该席位该看到的操作 | `can(seat)`，别回到「四个席位按钮全亮」的旧写法 |
| R21 | 房主或开发者可**解散房间**（两步确认：先进入「确认解散？」4 秒态，再点才生效） | 解散后房间视为已销毁：除幂等 close 外一切意图被拒、懒判定不推进，**房号立即回收**可被新房重用；界面整页切「房间已解散」 |
| R22 | 题库支持**明文词库**：粘贴或读入文本，任意分隔（换行/逗号/顿号/分号/空格/Tab）自动识别，**识别结果实时预览且可逐条改** | 识别规则在 `src/bankText.ts`；服务端 `normalizeEntries` 再洗一遍（长度、去重、类型）。别加「点一下才解析」的按钮，也别在输入时就抛错 |
| R23 | **一台设备在一个房间里只有一个身份**：同一台设备重复进出、清掉本机凭据、换标签页，都必须是同一个 specId/席位 | 靠 `deviceId` + vault 的 `devices` / `seatDevices` / `hostDevice`；「我」的标记只认服务端下发的 `spectator.id`，**不按昵称判断**（重名是合法的） |
| R24 | **换题要双方描述位各投一票**，两边界面上都要有入口：发起方看到「请求换题」，对方看到「同意换题」 | 引擎 `swapVotes` 满 2 才生效；入口判断用「我是不是描述位」，**不能用 `activeDescriber`**（那是当前行动方，会把对方挡在外面，换题永远停在 1/2） |
| R25 | **判对也要双方描述位各投一票**：最新一次猜词若其实是正确答案，双方描述位各投一票即可改判，格子归猜词的那一方 | 引擎 `judgeVotes` 满 2 才生效；首票用 `judgeTarget` 锁定目标猜词（之后再有人猜也不改对象）。改判走 `settleClaim`，与正常答对完全同一条路径 |
| R26 | **撤回只作废「还没结算的描述/作答」**，要对方队**任意一人**同意（不是双票、不限制角色）：撤回描述 → 回到该队描述阶段重写；撤回作答 → 回到该队作答窗口重答 | 引擎 `undoRequest` + `undoableOf()`；答对已落格归「判对/改判」管，这里一律拒绝。发起方必须是做错动作的那一队，**本方不能自己批**。撤回同时清掉已投出的换题/判对票，并把计时重置为整段（90s）。任何推进（新描述/作答/抢答/超时/结算）都会清空申请，不会跨回合滞留 |
| R27 | **抢答是开局前可选的房间规则，默认关闭**：大厅里一个「启用抢答功能」勾选框，选手/房主/裁判/开发者可改，开局后不可改 | `GameState.stealEnabled`（默认 `false`）+ `Intent {t:'setSteal'}`。关闭时 `steal`/`lock` 两个意图**在引擎里**直接拒（不是只藏按钮），界面也不给入口；重开沿用本局设定 |
| R28 | **重开要四个席位各点一次同意**（不是双票、不是房主说了算），对局中与结束后都能发起，**入口在顶栏**（对局级动作，不塞进答题卡）；四票齐了立即开新局：棋盘/历史/回合/抢答预算清零，人员、题库与规则沿用 | `GameState.restartVotes: SeatKey[]` + `Intent {t:'restart'}`；再点一次 = 撤回同意，离席/换人会收走该席位的票。重开优先发**题库里还没上过场的词**（`Secrets.used` 跨局累计），不够 25 个才整份重洗 |
| R30 | **词表里的斜杠 `/` 是「同一个答案的另一种写法」，不是词分隔符**：`言不二价/言无二价` 算一个词，猜中任一种都判对；展示（棋盘代号、结算、对局历史）永远只用斜杠前那个 | `WordEntry.alt?: string[]`（最多 4 个，见 `MAX_ALTS`）。解析在 `parseWordList`，清洗在 `normalizeEntries`/`altListOf`，判对在 `isAnswerMatch(guess, word, alts)`。别名**不出服务端**：`Reveal` 与 `publicSnapshot` 里只有 `word`，只有裁判/开发者的 `allCellWords` 会带 alt。裁判改格子词时整条换成 `{word}`，旧别名不能留 |
| R29 | **胜利条件常驻写在棋盘正下方**（`.board-hint`，11px `var(--muted)`，白底 5.67:1）：「红方纵向或绿方横向连成一条线即可胜利」 | 这行 `<p>` 必须放在 `.board-area` **之外**、`.board-card` 之内：席位栏 `[data-rail="GREEN"]` 是相对 `.board-area` 的 `bottom: 0`，塞进去会把右下角绿方席位卡一起往下推 |
| R31 | **落地页提供「房间大厅」**：列出所有还活着的房间（房号 / 阶段+回合 / 入座数 / 观战人数 / 题库名 / 选手），点一行即进房，不用先要到房号 | `GET /api/rooms` → `listRoomSummaries()`；只读公开快照，不下发棋盘与日志；已解散与超 TTL 的房不列出（点进去就是 404）。前端 5 秒轮询，且只在落地页轮询 |
| R32 | **房间只存在服务端进程内存里，不依赖任何云服务**：`Map<房号, 行>` + `data/rooms.json` 防抖快照（1.5 秒，原子 rename），进程重启能从快照捞回房间。**注意：重新发布并不会清空房间**——沙箱里那份 `data/rooms.json` 还在，新进程起来照样恢复（2026-11-13 实测，踩坑 #43） | 行形状仍是 `state`/`sig`/`vault`/`ver`，`service.ts` 不知道存储换了。为什么搬：云库时代一行 63.7KB（96% 是整份词表），对局中每 0.9 秒读一次、每次落子整行写一次，把资源点烧光后数据库被平台隔离（HTTP 402 `DATABASE_RESOURCE_ISOLATED`）。用户原话：「可以放弃战绩保存功能，改成不需要云服务的」。`data/` 已进 `.gitignore`——它若随发布包走，新部署会把上次的旧房间捞回来 |
| R33 | **大厅会顺手清掉废弃房间**：有人访问 `/api/rooms` 时，把「静默超时」的房标记成解散（写 `closedAt` + `updated_at` 置 1970，房号立即释放，不出现在列表） | 判废阈值：**大厅 20 分钟 / 对局中 1 小时 / 已结束 2 小时**，都以「最后一次有人在线」为准（`abandonOf`）。清理挂在真实请求上（平台没有定时器），**节流 60 秒一轮、单轮最多 5 间**，且 `void` 不阻塞列表返回；已结算但未入档的房先补档再清。用户原话：「适时清理房间大厅中的废弃房间」 |
| R34 | **观众也能在过程中猜本格的词，但只公开「猜中了」**：战况写一句「观众 xx 猜中了 A2 格」，**词本身一个字都不出**；猜错只回给那一台设备一句「未命中」，不写战况（否则等于逐字排除答案）；猜中**不改变对局**（不占格、不计分、不推进计时，双方还得自己打） | 入口只对「不在席位上的人」开（`specGuessOpen`），三个阶段（描述/作答/抢答）都算「过程中」；身份由服务端按**观战令牌**覆盖，客户端自报 id/昵称不作数。记账在 `vault.specGuesses`（观众 id → `{tries, hit}`），**每格/换题/重开清零**、上限 `MAX_SPEC_GUESS = 10` 次，挡暴力试词。回执走 `snapshotOf` 的一次性 `guessResult` 字段，**不进 state**——公开快照是全房间共享的。用户原话：「允许观众也在过程中猜当前的词是什么，但是猜中后只会显示猜中（如在战况中显示"观众 xxx 猜中了A2），不会告诉其他人词是什么」 |
| R35 | **不再有「我的战绩」**：结算后不落任何持久存档，`/api/records` 与落地页那一块都已删除 | 这是 R32 的直接代价：进程一重启，打过的局就查不到了。想恢复必须重新引入云库或外部存储，届时按 R32 重新评估体积与读写频率。「谁赢了多少」这类长期数据**不要**再往内存里堆——它活不过一次发布 |

---

## 6. 数据模型要点

`GameState`（`src/types.ts`）里几个容易踩的字段：

- `phase`：`lobby | select | describe | guess | steal | result | finished`。答错会在这几个状态间来回，
  不要假设"一格只走一遍"。
- `activeDescriber`：本格**当前**描述方（答错会易手），`firstDescriber` 是本格首描述方。
- `history: CellRecord[]`：整局流水。选中格子时建一行，答对后**保留**。
- `CellRecord.attempts: AttemptLog[]`：一队一次尝试。`outcome` 是猜词结果
  （`correct | wrong | passed | null`），`descPass` / `guessPass` 记录「描述/作答没发生」的原因
  （`timeout | skip`）。`outcome === null` 表示这条还没结算。**不要**再用多条记录表达同一轮。
- `steal: {by, lockedBy}`：本格抢答占用；`stealUsed: {RED: row[], GREEN: col[]}`
- `stealEnabled`：本局是否启用抢答（大厅勾选，默认 `false`，重开沿用）；`restartVotes: SeatKey[]`：重开表决（满 4 立即开局）
- `pausedAt` / `pausedBy`：暂停时 `deadlineAt` 不动，`resume` 时整体加 `now - pausedAt`。
- `closedAt: number | null`：房主/开发者解散时写下时间戳。非 null = 房间已销毁（冰雕）：
  引擎顶部守卫会拒掉除幂等 close 外的一切意图，`tick`/`advance` 也不推进；
  `loadRoom` 对它豁免 TTL（界面要能显示「房间已解散」）。
- 上限常量：`MAX_ATTEMPTS 30` / `MAX_HISTORY 25` / `MAX_SPECTATORS 200`。

`vault`（服务端密文，客户端不可解）：

```ts
{
  secrets: { all: WordEntry[], cellWords: {cellId: WordEntry}, pool: WordEntry[], used: string[] } | null,
  // WordEntry = { word, alt?: string[], hint?, category? } —— alt 是词表里「甲/乙」的另一种写法
  proposals: { [id]: { words, name, count, fingerprint, by } },
  seatTokens: { [seat]: token },
  hostToken, devToken?,
  spectators: { [watchToken]: { id, name } }
}
```

`secrets.used` 是**跨重开累计的「上过场的词」**：发牌（`dealBoard`）与换题上场的词都记进去，重开时先发没上过场的；老房间没有这个字段，按 `[]` 兜底。

---

## 7. 安全模型

| 想作弊的方式 | 被什么挡住 |
|---|---|
| 猜词位翻控制台找答案 | 题面只发给描述位；公开快照里没有未揭晓的 `word` |
| 伪造席位偷看题面 | `x-seat-token` 反查席位，客户端自报的 `seat` 一律被覆盖（开发者除外） |
| 冒充房主审批题库 | 服务端按令牌判定身份，只有 `x-host-token` 对得上的请求能通过 |
| 直连数据库改棋盘/胜负 | `state` 有 HMAC（`code.ver.state`），对不上返回 409「房间数据校验失败」 |
| 读表偷答案 | 答案和令牌都在 `vault`（AES-256-GCM），密钥只在进程里 |
| 冒用别人的设备身份 | `deviceId` 只存在那台设备的 localStorage 与 `vault` 里，**从不下发给其他客户端**；它是 16 字节随机数，和令牌同级，猜不到也读不到。它只用来「认回自己」，不新增任何权限位 |

改 `canon()`（稳定序列化）会让所有现存房间的签名失效，等于清空所有进行中的对局，谨慎。

---

## 8. 开发与测试

```bash
npm install                 # 本机较慢，建议后台跑
npm run dev                 # Vite 前端，/api 代理到 3000
npm run dev:server          # 另开终端：build-server + 起服务
npm run build               # vite build → web/ + dist-server/index.mjs
PORT=4519 node dist-server/index.mjs    # 本地起服务
```

十四套测试（12 份单元 + 接口级 + 浏览器。当前规模：规则 246 / 判词 16 / 示例题库 9 / 题库包 9 / 明文词表 61 / 身份 17 / 棋盘排版 21 / 历史排序 6 / 大厅判废 19 / 观战猜词 34 / 判胜换格 11 / 分享码 15 / 接口 203 / 浏览器 107）：

```bash
npm run test                                        # 十二份单元测试：engine / answer / demoBank / bank / bankText / identity / wordFit / records / abandon / spectatorGuess / refereeWin / share
BASE=http://127.0.0.1:4519 node test/api-e2e.mjs    # 接口级，会真建房、真打一局
BASE=http://127.0.0.1:4519 node test/e2e.mjs        # 裸 CDP 开 2 个独立 browser context = 两台设备
node test/layoutProbe.mjs                           # 布局回归：8 个视口下量棋盘宽 + 席位卡距六边形
node test/layoutProbe.mjs 430 390 375 360 320       # 同上，只量手机宽度（席位卡改成角上小字后必跑）
node test/shotMobile.mjs shot/mobile.html 390 844 shot/m.png   # 按真实视口截图（含 2x 像素）
```

- `test/layoutProbe.mjs` 是唯一能验「席位卡有没有压到棋盘」的工具（e2e 只点元素、不看位置）。
  先 `npx vite build && npx tsx test/renderSwap.tsx` 生成页面，再从输出里看「棋盘宽」与「距六边形」
  两列——后者出现负数或个位数就是挤住了。改动 `.board-area` / `.seat-rail` / `.shell-room` 后必跑。
- `test/shotMobile.mjs` 用 CDP 的 `Emulation.setDeviceMetricsOverride` 定视口，**不要用
  `chrome --window-size=390,...`**：Windows 有最小窗宽，实际按 ~500 布局再裁到 390，看上去像棋盘被切了。
- 手机端整页探针：`npx tsx test/__probe_mobile.tsx` 生成真实昵称 + 几轮历史的 `shot/mobile.html`、
  lobby 版 `shot/mobile-lobby.html`、**终局版 `shot/mobile-finished.html`（对局结束 + 两条记录）**，
  配合 `shotMobile.mjs` 截图核对版面。
- 紧凑度用数字说话：`node test/measureBlocks.mjs shot/mobile-finished.html 390` 直接打印
  「整页高 / 答题卡高 / 对局历史卡高 / 图例行数 / 记录行高」——截图看不出 5~15px 的差别，
  调内边距、字号、列宽之前先量一次基线，改完再量一次对比。

约定：

- `test/engine.spec.ts` 是**规则层**，用 `check(cond, '中文断言')` 累加计数，最后打印「结果：N 项通过」。
- `test/bankText.spec.ts` 只测**纯函数**：分隔符、序号、包装符号、去重、上限、服务端清洗、GBK 兜底解码。
  加一条分隔符就补一条断言，别只改代码。
- `test/api-e2e.mjs` 覆盖权限、令牌、签名、审批、开发者代打、数据库篡改拦截、明文词库上行与二次清洗，
  以及房间大厅列表（新建即出现、入座数/选手名同步、解散后立刻消失、不下发棋盘与日志）。
- `test/e2e.mjs` 覆盖真实渲染：落地页 → **房间大厅点行进房**（`02b-lobby.png`）→ 建房 → 观众 → 明文词库（粘贴 → 预览 → 删改 → 提交 → 拒绝）
  → 题库审批 → 自动开局 → 描述校验 → 跳过流程
  → 暂停（冻结不变量：暂停后两次读数必须一致）→ 复制局面图 → 解散房间（两步确认，两端同步「房间已解散」）。
  截图写到 `shot/`（`03a-bank-text-draft.png` 是明文词库的校对界面）。
- 改规则必须同时在 `engine.spec.ts` 和 `api-e2e.mjs`（必要时 e2e）补断言；
  只跑单元测试不算验证过。
- e2e 的小坑：SVG 没有 `click()`，用 `dispatchEvent(new MouseEvent('click',{bubbles:true}))`；
  受控输入要用原生 setter + `input` 事件（脚本里有 `setValue`）；
  剪贴板要注入假 `ClipboardItem` 再覆盖 `navigator.clipboard`。

---

## 9. 发布

用 WorkBuddy 的站点发布能力（`workbuddy_sites_deploy` / 设置里的应用管理），覆盖式发布，链接不变：

```
directory  = C:/Users/Hg/Downloads/随蓝射覆-online
language   = node
port       = 3000
domainPrefix = suilan-online
appName    = 随蓝射覆在线对战
startCmd   = sh -c "npm run build && node dist-server/index.mjs"
```

**发布包会整目录排除 `dist/`**（工具按「构建产物」判断），但不会排除 `web/`。所以前端产物目录
已经改名成 `web/`（`vite.config.ts` 的 `build.outDir`，服务端优先读 `web/`、退回 `dist/`）。
改名之前踩过两次：发布看着成功，线上 `index.html` 的 `Last-Modified` 还是几周前、bundle 指纹没变。

**仍然传 `startCmd` 让沙箱自己 build**：双保险，且能挡住「上传漏了产物」这种静默失败。

发布后必须核对「线上 bundle 指纹 == 本地 `web/index.html` 里的指纹」，只看发布成功不算：

```bash
curl -s https://suilan-online.app.workbuddy.host/api/health
curl -s "https://suilan-online.app.workbuddy.host/?t=$(date +%s)" | grep -o 'index-[A-Za-z0-9_-]*\.js'
grep -o 'index-[A-Za-z0-9_-]*\.js' web/index.html      # 两个指纹必须一致
BASE=https://suilan-online.app.workbuddy.host node test/api-e2e.mjs
```

**线上核对的坑（2026-11-12 起）**：网关要求链接带 `?sharecode=`，不带就是 403「链接不完整」
（返回的是 HTML，`res.json()` 直接失败）。所以上面两条 curl **必须加 cookie**，测试脚本也要带参数：

```bash
# 1) 先换 cookie（sharecode 由发布工具返回，形如 ?sharecode=EZH2JALIDX）
curl -s -c /tmp/jar -o /tmp/idx.html "https://suilan-online.app.workbuddy.host/?sharecode=<CODE>"
grep -o 'index-[A-Za-z0-9_-]*\.js' /tmp/idx.html        # 线上指纹从这里读

# 2) 带 cookie 跑接口级；带 sharecode 跑浏览器级（每个 context 会先预热 cookie）
BASE=https://suilan-online.app.workbuddy.host WB_COOKIE="__wb_rsc=<值>" node test/api-e2e.mjs
BASE=https://suilan-online.app.workbuddy.host WB_SHARECODE=<CODE> node test/e2e.mjs
```

**发给玩家的链接必须带 `sharecode`**（发布工具返回的 `shareLink` 就是完整形式）。前端已经把分享码
在 `?room=xxx` 跳转里保住了（`src/share.ts`，踩坑 #39），所以玩家从地址栏复制出来的链接是完整的——
但只要有人手工把参数删掉，就会看到「链接不完整」。

冷启动约 5~8 秒（要等 `npm run build`），期间链接可能 502，属正常。

**测试数据的清理**：本地跑完测试留下的房间随进程退出就没了。**线上不能靠「重新发布」清**——沙箱里的
`data/rooms.json` 还在，新进程会把它恢复回来（踩坑 #43）。要清就带 `startCmd: "rm -rf data && node dist-server/index.mjs"`
发布一次，发完换回正常启动命令。`data/rooms.json` 已在 `.gitignore`，不会跟着发布包上传（否则新部署会把上次的旧房间捞回来）。

---

## 10. 踩坑清单（都是实际踩过的）

> **云库时代的条目（#2、#13~#16、#36、#37 一半）已经失效**：2026-11-13 起房间存在进程内存里，
> 不再有 `rt_rooms` / `rt_records`、SDK 重试、乐观锁跨进程竞争、DELETE 权限这些事。
> 保留它们是因为「为什么不该再走回去」的教训仍然有效。

1. **部署脚本跳过 build** → 线上还是旧版。startCmd 固定为「先 build 再起服务」。
2. **SDK 泛型退化**：`createWorkBuddyCloud(...)` 不传 schema 时 `from()` 返回 `never[]`，类型全挂。
   必须写 `createWorkBuddyCloud<{Tables:{rt_rooms:RoomTable; rt_records:RecordTable}}>`（两张表都要声明）。
3. **服务端必须用令牌解析出的席位覆盖客户端自报的 `seat`**，否则可以冒名代打。
4. **同队同一格的尝试记录不要新建第二条**：`attemptOf` 只认 `outcome === null` 的那条。
5. **审批题库后推进要用新词表**：`approveBank` 那一轮的 `res.secrets` 还是旧的（可能是 null），
   不换成 vault 里的新 secrets 会把刚激活的题库又写回 null。
6. **观众改名要同时改 vault**，否则下次快照退回旧昵称。
7. **离席要让位**：删掉该席位的 seat token，否则席位永久占死；行动方离席要立刻按超时推进，
   否则整桌空等 90 秒（`passUntilFilled`）。
8. **3 位房号只有 1000 个，回收不依赖 DELETE**：从 000 起顺序分配（`nextRoomCode(used)` + `listRoomCodes()`），
   撞上过期房间用 `reclaimExpiredRoom` **原地 CAS 覆盖**（`UPDATE ... WHERE code=? AND ver=<旧ver>` 写入新房间），
   撞上并发活房间顺延。`listRoomCodes()` 只把 `updated_at` 在 8 小时 TTL 内的房间算占号；
   解散时 `casUpdate(..., { keepAlive: false })` 把 `updated_at` 置成 1970 当场置死。
   启动时**没有任何清理动作**——云库 key 没有 DELETE 权限，批量删必然失败，见 #14。
9. **CDP 里 `awaitPromise` 拿不到 promise 结果**：改成页面里写 `window.__xxx`，外面轮询。
10. **本机 `http_proxy` 没设 `no_proxy`**：`curl http://127.0.0.1:PORT` 可能拿到 502 而不是 connection refused，
    核对本地服务要加 `--noproxy '*'`。
11. **`navigator.clipboard.write` 在无焦点/非安全上下文会抛**，一定要 catch 后降级下载。
12. **暂停时把 `width` 写成 100%** 会让进度条突变成满条（用户已投诉过一次），
    正确做法是用 `deadlineAt - pausedAt` 算剩余。
13. **云库 SDK 只自动重试 GET**：长跑进程的 keep-alive 连接被对端重置时，
    PATCH/INSERT/DELETE 直接抛 `TypeError: terminated`（或空 message），连锁反应是
    「入座写丢失 → 401 席位凭证无效 → 描述提交 500」。修法：`server/store.ts` 的
    `retryCloud()` 统一包一层重试（3 次、120/240ms 退避）。安全性：读幂等；
    CAS 是 `WHERE ver = ?` 条件更新，重试同参数要么再成一次要么条件不符返回 false；
    insert 重试退化为「房号冲突」，由建房流程处理。
14. **云库 publishable key 没有 DELETE 权限**（`42501 permission denied for table rt_rooms`）：
    任何 DELETE 都必然失败。解法不是申请权限，而是**根本不删**：`listRoomCodes` 过滤死房 +
    `reclaimExpiredRoom` 原地 CAS 覆盖（见 #8）。行数受主键限制最多 1000，永远删不出空间，
    「覆盖复用」是唯一可行的回收路径。另：本地测试与线上部署共用同一张 `rt_rooms` 表，
    测试房间（固定昵称）会占号，回归跑完记得手动清（§9 的 SQL）。
15. **云库在并发负载下会秒级挂起**（不抛错也不返回，实测 4~6 秒；也有 5 秒后空消息失败）：
    e2e 连跑时单个用例可见 5~9 次。修法：`store.ts` 的 `withTimeout`（`CLOUD_TIMEOUT_MS = 4000`，
    正常调用实测 143~809ms，4 秒是其 5 倍）包住 `retryCloud`。超时/放弃都安全：
    读幂等；CAS 带 `ver` 条件；insert 撞号有回收路径（#16）。慢调用 >2000ms 打日志定位。
16. **insert 撞号不要只认 `e.code === '23505'`**：云库会把 Postgres unique violation 原样透出，
    `code` 字段缺失，只有消息文本。必须同时匹配 `/duplicate key|unique constraint|already exists/i`，
    否则「解散后房号立即回收」这条路径第一次被真实走到时就会 500。
17. **客户端时钟不能全盘采纳服务端时间**：`adoptClock` 只接受 ±30s 内的偏移。
    响应被链路拖延时 `serverNow` 可能比到达时间早好几秒，全盘采纳会让 90 秒窗口显示成 98 秒（实测踩过）。
18. **清掉本地凭据 ≠ 离开房间**：`exitRoom` 只清 localStorage 里的四枚令牌时，服务端仍然认为你坐在席位上。
    下次进房你既在席位里（旧名字）、又以新观众身份出现在观战名单——**「看到两个自己」**，
    而且再也坐不回自己那一席（`该席位已被其他设备占用`）。两条修法缺一不可：
    ① 退出前先发 `leave` 把席位让出来；② 服务端按 `deviceId` 认人，令牌丢了也能认回原身份。
19. **不能按昵称判「哪个是我」**：`sp.name === nick` 一撞名就两条都标「我」。名单里出现重名是合法的
    （两台设备两个「阿蓝」），所以只认服务端下发的 `spectator.id`。同样地，
    **不要用昵称去重**——那会把两个真的同名玩家合并成一个。
20. **界面与导出图是两套绘制，会各自漂移**：`Board.tsx` 用 SVG、`exportImage.ts` 用 Canvas，
    同一个东西（格子里答案的折行、座位卡片的装饰、超时文案）必须共用一套规则。
    折行/字号已收进 `src/ui/wordFit.ts`，历史事件（含 `PASS_TEXT` 文案与排序）已收进 `src/records.ts`。
    验证别靠肉眼猜：`npx tsx test/renderBoard.tsx` + 无头截图看棋盘，
    `node test/exportShot.mjs` 看导出图（它用 CDP 真等 `toBlob` 回调，
    `chrome --screenshot` 配 `--virtual-time-budget` 只会截到「渲染中…」）。
21. **准备状态只在大厅有意义**：对局开始后 `ready` 字段仍然保留，直接渲染会让座位卡一直挂着
    「已准备」。界面用 `phase === 'lobby'` 拦住了，导出图以前没拦——截图里就出现已过期的「已准备」。
22. **记录是按「队」存的，不是按时间存的**：红方一条、绿方一条，答错就交替往下写。
    抢答会插进对方记录中间（红描述 → **绿抢答** → 红猜中），可红方的描述和猜中写在同一条记录里。
    只按记录建立顺序渲染，答案 ✓ 就会跑到抢答记录前面。修法是 `AttemptLog.descAt / guessAt`
    + `src/records.ts` 按时间合并排序。**别在 `Records.tsx` 或 `exportImage.ts` 里再各写一份展开**。
23. **席位卡拆成两条 `seat-rail` 时，DOM 顺序必须还是 `SEAT_ORDER`**：e2e 按 `.roster-seat` 的
    下标点席位（0=红描、1=红猜、2=绿描、3=绿猜）。把两列拆开渲染没问题，但别按「视觉上左右」
    重排成 `RED_DESC, GREEN_DESC, RED_GUESS, GREEN_GUESS`——那样点击会坐到错的席位。
24. **席位卡别用网格列去「让位」，要浮在三角空地上**：蜂巢是斜的平行四边形，左上/右下各一块
    三角形空地。曾经用 `grid-template-columns: 116px 1fr 116px` 把它当两列，代价是棋盘整整少
    252px。正确做法是 `.board-area` 只留一列，`.seat-rail` 绝对定位到左上/右下角——棋盘拿满卡片宽度
    （实测 1440 视口 718→970，1600 视口 734→986）。
    **几何约束**：左卡右边缘必须小于第 3 行最左六边形（102/665 = 15.34% 的棋盘宽），
    所以 `left: max(0px, calc(15.34% - 126px))`（126 = 卡片 112 + 12px 呼吸位）；
    由此推出棋盘宽 ≥ 730px 才浮得住，`@container (max-width: 800px)` 就是折返点。
    改卡片宽度/内边距后必须重跑 `node test/layoutProbe.mjs` 看「距六边形」列，出现负值就是压住了。
    **手机（棋盘 270~400px）不适用上面的公式**：左上第一行空地只有 81~103px、第二行只有
    63~79px，四张 112px 卡怎么放都会压住六边形。所以开局后（`.seats-compact`）席位卡退化成
    一行字「● 描 宁」：字号 11px、行高 14px、两颗叠起来 34px，正好落在一行六边形（约 37px）内，
    宽度上限 `min(90px, 29%)`（29% = 199/665，即第一行左侧空地占比），320 小屏自动收窄到 81px。
    lobby 阶段卡片要带准备按钮，仍用 2×2 折返，别把紧凑版套过去。
25. **`layoutProbe.mjs` 测「有没有压到棋盘」的三个坑**：① `.hex` 是 `<g>`，开局前棋盘只有 ghost
    `polygon`、没有 `.hex`，选择器要用 `.board-svg polygon`；② `rails` 是 DOM 元素数组，
    直接传给按 `{x,y,w,h}` 取值的函数会静默算出 `NaN`（表格里显示 0px，看起来一切正常）；
    ③ 一对矩形的最小间距要用 `max(各轴分离量)`，用 `min` 会把「某一轴重叠」的远处格子也算成碰撞。
26. **清空可选字段要用 `delete`，不能写 `x = undefined`**：落库签名的 `canon()` 会把「键存在但值为
    `undefined`」算成 `null`，而 `JSON.stringify` 存库时又把这个键丢掉 —— 读回来签名必然对不上，
    表现为下一次请求 409「房间数据校验失败，已被外部改写」。撤回实现里抹掉 `descAt / guessAt /
    descPass / guessPass / stolen` 时踩过；想置空就 `delete obj.key`，或干脆写 `null`。
27. **发布成功后线上前端可能还是旧版**：发布工具会把 `dist/` 当构建产物排除掉，而启动命令
    `node dist-server/index.mjs` 读的正是 `./dist`；于是 `dist-server/` 更新了、前端没更新，
    「发布成功」但按钮/文案还是几周前的。判据是 `index.html` 的 `Last-Modified` 和 bundle 指纹，
    不是发布返回的 200。已把前端产物目录改成 `web/` 规避（见第 9 节），部署时仍建议带
    `startCmd = sh -c "npm run build && node dist-server/index.mjs"` 双保险。
28. **渲染探针拿到的可能是过期样式**：`test/renderSwap.tsx` / `renderBoard.tsx` 是把构建产物的
    `.css` 链接进探针页面的，产物目录改到 `web/` 之后还按 `dist/assets` 找，就会静默用上几周前的
    那个 CSS——量出来的结果和线上完全不同（本次表现为「刚加的 flex gap 量出来是 0px」）。两个目录
    都要找，且先看 `web/`；改完 CSS 记得先 `npm run build` 再跑探针。
29. **`vite build` 会清空产物目录，旧的探针 HTML 会指向已删除的 CSS**：探针页里写的是带 hash 的
    文件名，重新 build 后 hash 变了，之前生成的 `shot/*.html` 就变成「有 DOM、零样式」——
    截图出来是纯文本竖排，很容易被误判成布局崩了。每次 build 之后先重跑 `npx tsx test/renderSwap.tsx`。
30. **别用 `chrome --window-size=390,844` 截手机**：Windows 有最小窗宽，实际按 ~500px 布局再裁到
    390，右边六边形被切掉，看起来像棋盘溢出。用 `test/shotMobile.mjs`（CDP `setDeviceMetricsOverride`），
    它能同时给出真实 `scrollWidth/scrollHeight`。
31. **重开的「没用过的词」靠 `secrets.used` 累计，只记「上过场」而不是「被猜中」**：棋盘上 25 格一发出
    就全算用过（哪怕还没人猜），换题换上台的词也算。反过来说，**上线前就开局的房间没有这个字段**，
    它们的第一次重开会把整份题库当未使用（可能与上一局重复）——这是老房间兼容代价，不必回填。
    另一个坑：`dealBoard` 必须在 `beginGame` 里只调用一次，且**不要**在 `restart` 分支里另写一份
    重置逻辑，否则很容易漏掉 `swapUsed` / `stealUsed` / `history`（漏一个下次重开就会带着旧状态）。
32. **探针脚本「全 null + 整页高 900」＝连到了上一轮没退干净的 headless chrome**：
    `chrome.kill()` 只杀父进程，残留实例会继续占着固定调试端口（`layoutProbe` 9381 / `shotMobile` 9393 /
    `measureBlocks` 9397），新脚本连上去拿到的是那个空白的 `about:blank`，于是所有 `querySelector`
    都是 null。先 `Get-Process chrome | Stop-Process -Force` 再跑；同一条命令里连跑多个探针时中间加
    `sleep 1`，别让它们抢同一个端口。
33. **开发者模式下「我的席位」和「代打席位」同时有值时，所有按角色找入口的逻辑都要优先 `devSeat`**：
    开发者可能一边坐着 RED_DESC、一边代打 GREEN_DESC。`can()` 同时认两个，但
    `[mySeat, devSeat].find(roleOf === 'DESC')` 会先命中 `mySeat`，于是切到对方描述位后
    「换题」那一行仍以原来的席位渲染（显示「撤销申请」，发不出对方的票）。凡是「当前视角该用谁」一律先看 `devSeat`。

34. **房间大厅（`GET /api/rooms`）有三个坑**：① 必须复用 `listRoomCodes()` 那套「活房」判定
    （8 小时 TTL 内 **且** 未解散），只按主键列表格会把已解散 / 过期房间列出来，点进去就是
    「房间不存在或已过期」；② 只读 `state` 行、不要读 `vault`——vault 是密文且装着整份题库
    （示例题库约 82KB），大厅只需要公开快照，读它纯属浪费；③ **排序要把空房沉底**：
    本机与线上共用同一张 `rt_rooms`，回归跑完会残留几十间「0/4 入座 + 1 观战」的测试房，
    只按「最近活跃」排会让它们占满大厅首屏。现在按「大厅房 → 对局中 → 已结束」+ 入座数降序。
   补充：`listLiveRooms()` 把「过滤 / 排序 / 截断」全交给云库（`.gte('updated_at', …)` + `.order(…, {ascending:false})` + `.limit(60)`，
   这套 SDK 支持，已实测）——房号只有 1000 个且死房删不掉，整表拉回来再筛，等表快满时每次大厅轮询都要传上兆字节。
35. **作答卡头部别再拆成两行**：`phaseLabel` 与「代号 / 首字·字数」曾经各占一行（外加两个胶囊的内边距），
    输入框上方凭空多出约 70px（Hg 报「答题框太占地方」）。`act-head` 现在是**一行**：
    代号 + 首字/字数 + 阶段 ……… 倒计时；描述/作答/抢答三个阶段连阶段名都不写，因为下面的
    `.turn-title` 已经写着「哪一方、做什么」。验证用 `node test/measureBlocks.mjs shot/mobile.html 390`，
    它会打印答题卡子块（第一项是 `act-head`，约 21px）；不要靠截图估像素。

36. **`rt_records` 是第二张表，权限要单独给。** 建表只完成一半：`rt_rooms` 对 `anon` 是
    `ALL/true`（靠 sig 防伪），新表必须自己走完「`GRANT SELECT, INSERT, UPDATE` → `ENABLE ROW LEVEL SECURITY`
    → `CREATE POLICY ... FOR ALL TO anon, authenticated`」三步，漏任何一步查询都会 42501。
    **不要给 DELETE**（和 `rt_rooms` 一致）：存档只增不改，误删没有回收路径。
    另外三个坑：① 归档**必须幂等**——主键是 `房号 + startedAt`，结算请求、结算后的轮询、两个标签页
    同时刷都会来抢着写，撞主键当成功（`insertMatchRecord` 返回 false），不要抛错；
    ② 归档挂在**两条**写路径上（结算的那个 intent + `readSnapshot`），只挂一处的话「赢完立刻关页面」
    或「进程被回收」那局就永远丢档；进程内 `archivedMatches` 只用来省掉重复请求，别拿它当唯一判据；
    ③ 检索别整表拉回来筛——存档只增不减，把 `.like('device_keys', '%|dev|%')` + `.order('ended_at')`
    + `.limit(50)` 全下推到云库（SDK 支持，已实测）。

37. **「清理废弃房」不能按「最后一次状态变化」判。** `updated_at` 早先只在真实写入时刷新，
    「建完房静静等朋友」和「人早走了」在库里长得一模一样——按这个判，真人等人 20 分钟就被清掉。
    现在快照读取路径上挂了**节流心跳**（`touchRoom`，`HEARTBEAT_MS` 90 秒最多一次），
    页面开着就续期，静默时长才真的等于「没人在看」。三个必须守住的点：
    ① 心跳**只更新 `updated_at` 一列**，不要走 `casUpdate`——那要重签快照并把整份 vault 传回去
    （示例题库约 82KB），90 秒一次能把流量吃光；
    ② `HEARTBEAT_MS` 必须远小于最短判废阈值（20 分钟），`test/abandon.spec.ts` 里有断言盯着；
    ③ 清理前若 `phase === 'finished'` 且 `archiveIfFinished()` 返回 false（存档没写进去），
    **这一轮就不许清**——否则「打完立刻关页面、之后再没人打开」的那局会永久丢档。

38. **判胜只能按 `row/col` 走，绝不能拿「`cell-<r>-<c>` 这个 id」当邻接键。**
    事故现场（2026-11-10 房号 000）：裁判「改格子 + 换格子位置」之后，绿方正常答对一格，
    同一毫秒战况却写「红方 连通成线，对局结束」，还落了一条战绩存档。
    根因是 `findWinner` 以前用 `neighbors(row,col) → ['cell-r-c', …]` 拿 id 去 `Map` 里找邻居，
    而 `refereeSwapCells` **只交换 row/col、不动 id**（id 是发牌时按初始坐标生成的）。
    换完格，id 与坐标就对不上，BFS 在 id 网格上乱走：`cell-0-0@(0,0)` 一步就"连"到了
    `cell-1-1@(4,1)`——两格隔着四行，却凑出一条从行 0 到行 4 的线。实测旧算法在这块棋盘上返回
    `winner=RED, path=[cell-0-0 → cell-1-1]`。
    现在 `hex.neighborPositions()` 返回**坐标**、`findWinner` 以 `"r,c"` 为键遍历；
    `test/refereeWin.spec.ts` 锁住三件事：不相邻不能判胜、换格后绿方答对不许判红方赢、
    真连成 5 格的换格仍然照常判胜。
    **推论**：任何新代码都不要假设 `cell.id` 编码坐标（换格之后就不成立），几何一律读 `row/col`；
    渲染（`Board.tsx` / `exportImage.ts`）本来就是按 row/col 画的，所以界面一直是对的——
    错的只有判胜这一处，这也解释了「界面看着没连成线，却突然判胜」。

39. **平台的分享链接带 `?sharecode=`，改写地址栏时绝不能把它抹掉。**
    2026-11-12 用户报「别人打开就显示链接不完整」。查下来不是代码 403，是**平台网关**：
    `*.app.workbuddy.host` 的 node 应用，链接不带 `sharecode`、浏览器又没有 `__wb_rsc` cookie 时，
    网关照例返回 403「链接不完整」（域名不存在则是 404「链接已失效」，两者要分清）。
    带 `?sharecode=xxx` 打开一次后，服务端下发 `__wb_rsc`（30 天、HttpOnly、Secure、SameSite=None），
    之后同域名下的请求都放行——所以**页面内 `fetch('/api/...')` 不用手动带参数**，别去改请求层。
    真正的 bug 在前端：`enterRoom` 以前 `replaceState(null,'','?room=000')`、`exitRoom` 用
    `pathname`，都把 `sharecode` 洗掉了。玩家分享房间就是复制地址栏，于是复制出去的链接必然失效。
    现在统一走 `src/share.ts` 的 `shareParam / roomQuery / landingHref`（`test/share.spec.ts` 15 项锁住），
    小写 `sharecode` 与驼峰 `shareCode` 都认、输出统一小写。
    **推论**：以后任何新加的 `pushState/replaceState/复制链接` 都要经过这三个函数；
    排查「链接打不开」先 `curl -s -o /dev/null -w '%{http_code}'` 分清 403（缺 sharecode）与 404（应用没了）。

40. **线上回归测试现在要先换 cookie / 带 sharecode。**
    同一个网关校验也挡测试脚本：`BASE=https://suilan-online.app.workbuddy.host` 直接打 `/api/*` 会拿到
    403 的 HTML（`res.json()` 解析失败，看起来像「接口全挂」）。两个脚本各自支持：
    `api-e2e.mjs` 传 `WB_COOKIE="__wb_rsc=xxxx"`（每个请求带 cookie）；`e2e.mjs` 传
    `WB_SHARECODE=xxxx`（每个浏览器上下文导航前先落地 cookie，否则上下文之间 cookie 不共享）。
    拿 cookie：`curl -c jar -o /dev/null ".../?sharecode=xxxx"`，值在 jar 里。


41. **内存存储的三条硬边界（换架构时最容易忘）。**
    ① **进程死了就没了**：沙箱被平台回收、重新发布、崩溃重启，房间全部清空。所以任何「长期保存」类需求
    都不能再往这里堆（战绩已按 R35 下线）；要恢复必须先选一个外部存储，并按「一次写入多大、多久写一次」算账。
    ② **`data/rooms.json` 必须留在 `.gitignore`**：它在运行时才生成，一旦混进发布包，新部署启动时会把
    上一次的房间捞回来——玩家会看到一间「上次残留、状态还是终局」的房，且带旧 `updated_at`，判废逻辑要等一轮才清。
    ③ **别在请求路径上同步写文件**：对局中每 0.9 秒就有一次写入，整份快照几十 KB，同步写会把轮询拖垮。
    统一走 `schedulePersist()` 的 1.5 秒防抖 + 临时文件 rename；SIGINT/SIGTERM 只负责最后一次 flush。

42. **线上首跑必挂「题库提案」三条，但那是假阴性，不是产品 bug。**
    症状：刚发布后第一轮线上 `e2e` 稳定出现 3 项失败——`提交后立刻进入待审批（本端）` / `另一端看到这份明文题库` /
    `提案里显示的是改完之后的确切词数（29）`；紧接着第二轮 107 全过，本地也从来没有过。
    根因是两个测试写法不够硬，叠上沙箱刚醒来的首次往返：① 提交这份 30 词明文，线上首跑往返能到十几秒，
    原来用默认 15 秒，紧贴边界；② 第 393 行用**即时** `host.eval` 读「29 词」，而提案卡的昵称和词数不在同一帧到齐，
    上一行刚等到昵称就立刻读词数，慢网络下必然读到 false。
    改法：三条都改成真正的等待（提交侧 30 秒，词数侧 `waitFor` 10 秒），不要用「加 sleep」糊过去。
    判据：**同一份代码第二轮能全过、本地能全过 → 先怀疑等待，不要怀疑业务**。

43. **线上回归会在大厅留下假房间；清掉它不能靠「重新发布」，要靠启动时删快照。**
    每跑一轮线上 `api-e2e` / `e2e` 都会留下几个 `seated=0` 的 lobby 房，它们要等 8 小时 TTL 才消失，
    期间真实玩家在落地页大厅能看到这些「0/4」的空房；`e2e` 还会留下 4 座 + 观众的 `select` 房（看着像真人在打）。
    **踩过的错**：以为「重新发布 = 重启进程 = 房间清空」，结果重发两次房间原封不动，
    `updatedAt` 前后一模一样——因为沙箱里的 `data/rooms.json` 没被删，新进程启动时照 `loadSnapshot` 恢复回来，
    重新发布只覆盖代码、不清沙箱数据目录。
    真正有效的做法（2026-11-13 验证，清完 `GET /api/rooms` 返回 `{"rooms":[]}`）：
    发布时把启动命令临时改成先删快照再起服务——
    `startCmd: "rm -rf data && node dist-server/index.mjs"`，发完记得下一次发布换回 `node dist-server/index.mjs`，
    否则每次沙箱重启都会顺手清房（对「房间活不过重启」这个语义其实无害，但会让快照形同虚设，别再依赖它做任何恢复）。
    清之前**务必**先 `GET /api/rooms` 看一眼有没有真人在打——这一步执行下去是全局清空，没有回滚。
---

## 11. 已知取舍 / 待办

- **房间只活在内存里，但「发布」本身并不清房。** 存储改回进程内存（R32）之后，沙箱被回收、进程崩溃会清空房间；
  同一个进程内的重启还能从 `data/rooms.json` 快照恢复。**重新发布不清空**——只要沙箱里那份快照还在，新进程起来照样恢复
  （实测两次重发房间原封不动，见踩坑 #43），要主动清必须用 `rm -rf data &&` 前缀启动。这是为了不再消耗云服务资源点
  刻意接受的代价——用户明确说了「可以放弃战绩保存功能」。要长期保存必须重新引入外部存储（R35）。
- **没有战绩了。** 落地页不再有「我的战绩」，打过的局在进程重启后查不到；`/api/records` 已删除。
- **vault 仍然装着整份题库**（`all` + `pool` + 25 个 `cellWords`，示例题库 2577 词 ≈ 62KB），
  每次动作整体 seal/unseal。内存版这些开销不花钱、也不落网络，但单次约 0.2~0.3ms；
  房间多、轮询密时要留意 CPU（40 间 × 5 台设备 × 0.9 秒 ≈ 220 次/秒的解密）。真要优化再拆词表。
- **同步延迟约 1 秒**：回合制、操作低频，实际无感；但卡在最后 1 秒的操作会有边界抖动。
- **懒判定**：所有人都断线时计时停住，恢复后按真实时间一次性追平（可能连跳好几步）。
- **观众名单不做超时清理**：关掉页面的观众仍会留在列表里（展示截断到最近 200 位）；
  但**同一个人不会再有第二条**——重新进房时按设备号认回原身份，并顺手扫掉没有令牌认领的幽灵条目。
- **描述超时后仍可盲猜**：这是 R5 的直接结果，等于给了一次「没有描述的机会」。
  如果产品上要改回「超时即失去本轮」，只需改 `passAction` 的 describe 分支，但**先问用户**。
- **题库 hint 质量**：现在描述必须两字，hint 只在开发者/描述位参考，人机局已不存在。
- **自定义词表不保密**：只有 `.sbank` 走服务端解密，内置示例题库是公开词库。

---

## 12. 与 WorkBuddy / Antigravity 的分工

- 这个目录和 `../随蓝射覆1` **都没有 git**。改大块之前请先复制一份或依赖编辑器 checkpoint，
  不要把 `node_modules`、`dist` 之类纳入版本控制。
- 每次有实质改动，追加到 `C:/Users/Hg/Downloads/随蓝射覆-online/.workbuddy/memory/YYYY-MM-DD.md`（append-only），
  写清「改了什么 / 为什么 / 怎么验证」。这是跨 Agent 的唯一交接记录。
- 不要删除 `.workbuddy/`、`.wbapp_*.genie`、`metadata.json`（后两个是发布标记）。
- 两边同时改同一个文件前，先在 memory 里写一行「正在改 X」，避免互相覆盖。
- 术语统一：描述位 / 猜词位 / 格子 / 对局历史 / 抢答 / 防抢答 / 换题 / 局面图。
