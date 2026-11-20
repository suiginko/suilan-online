/**
 * 跨设备同步的接口级端到端测试（新版：单页房间 / 无机器人 / 四席准备 / 题库审批 / 历史记录）。
 *
 * 覆盖：
 *   建房（房主默认观战，房号从 000 起顺序分配）→ 观众登记与改名 → 四席入座 → 任何人上传题库 → 房主审批
 *   → 四席准备后自动开局 → 选格/描述/作答 → 答错不换格 → 历史记录
 *   → 暂停与计时顺延 → 开发者模式代打四席 → 解散房间与房号回收
 * 以及两条安全线：猜词位拿不到题面、伪造凭证被拒。
 *
 * 用法：BASE=http://127.0.0.1:4519 node test/api-e2e.mjs
 *
 * 线上（app.workbuddy.host）现在要求先带 ?sharecode= 换一个 __wb_rsc cookie，否则网关直接 403「链接不完整」。
 * 所以跑线上时传 WB_COOKIE="__wb_rsc=xxxx"（从浏览器 devtools 或 curl -c 拿），脚本会给每个请求带上。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:4519';
const COOKIE = process.env.WB_COOKIE || '';

let pass = 0;
const failures = [];

function check(ok, label, extra) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
  }
}

async function api(path, { method = 'GET', body, seat, host, watch, dev, device } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (COOKIE) headers.cookie = COOKIE;
  if (seat) headers['x-seat-token'] = seat;
  if (host) headers['x-host-token'] = host;
  if (watch) headers['x-watch-token'] = watch;
  if (dev) headers['x-dev-token'] = dev;
  if (device) headers['x-device-id'] = device;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 描述必须是两个汉字且不含答案里的字：从干支表里挑两个安全的字 */
const CLUE_POOL = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
function clueFor(answer, skip = 0) {
  const banned = new Set([...(answer ?? '')]);
  return [...CLUE_POOL].filter((c) => !banned.has(c)).slice(skip, skip + 2).join('');
}

console.log(`\n== 接口级联机测试 @ ${BASE} ==\n`);

// ───────────────────────── 1. 建房与身份 ─────────────────────────
const created = await api('/api/rooms', { method: 'POST', body: { name: '房主阿蓝' } });
check(created.status === 200, '创建房间成功', created.json);
const code = created.json?.code;
check(typeof code === 'string' && /^\d{3}$/.test(code), `房号是 3 位纯数字：${code}`);
const hostKey = created.json?.hostToken;
const hostWatch = created.json?.watchToken;
check(typeof hostKey === 'string' && typeof hostWatch === 'string', '房主拿到房主凭证与观众凭证');
check(created.json?.devToken === null, '普通建房不会下发开发者凭证');

// 房号从 000 开始顺序分配：再建一间，新房号只可能更大（不会随机跳回已占用的号码）
const created2 = await api('/api/rooms', { method: 'POST', body: { name: '顺延测试' } });
check(created2.status === 200, '再次创建房间成功');
check(
  typeof created2.json?.code === 'string' &&
    /^\d{3}$/.test(created2.json.code) &&
    created2.json.code > code,
  `新房号顺序顺延：${code} → ${created2.json?.code}`
);

const hostSnap = created.json?.snapshot;
check(hostSnap?.isHost === true && hostSnap?.isSpectator === true, '房主默认坐在观战席');
check(hostSnap?.seat === null, '房主没有自动占席位（可以自己选择是否下场）');
check(hostSnap?.state?.phase === 'lobby', '新房间处于等待开局');
check(hostSnap?.state?.board?.length === 0, '没有题库时棋盘为空（界面显示等待导入）');

// 房间大厅：落地页靠它「找到房间」，不用先知道房号
const lobby = await api('/api/rooms');
check(lobby.status === 200 && Array.isArray(lobby.json?.rooms), '大厅接口返回房间列表');
const lobbyMine = lobby.json?.rooms?.find((r) => r.code === created2.json.code);
check(!!lobbyMine, '刚建的房间立刻出现在大厅里');
check(lobbyMine?.phase === 'lobby' && lobbyMine?.seated === 0, '大厅条目带阶段与入座数');
check(typeof lobbyMine?.spectators === 'number' && lobbyMine.spectators >= 1, '大厅条目带观战人数');
check(
  !JSON.stringify(lobby.json).includes('"board"') && !JSON.stringify(lobby.json).includes('"log"'),
  '大厅只给概要，不下发棋盘与对局历史'
);

// 大厅每次被访问都可能触发一轮废弃房清理（节流 60 秒、单轮最多 5 间）。
// 这里反复刷，确认清理只针对「静默超时」的房，刚建好的不会被顺手清掉。
for (let i = 0; i < 3; i++) await api('/api/rooms');
const lobbyAgain = await api('/api/rooms');
check(
  !!lobbyAgain.json?.rooms?.find((r) => r.code === created2.json.code),
  '连刷大厅不会误清新房间（清理只清静默超时的）'
);

const forgedDev = await api(`/api/rooms/${code}`, { dev: 'x'.repeat(24) });
check(forgedDev.json?.isDev === false, '乱填开发者凭证不会获得开发者权限');

// ───────────────────────── 2. 观众：昵称 ─────────────────────────
const w1 = await api(`/api/rooms/${code}/watch`, { method: 'POST', body: { name: '路人甲' } });
check(w1.status === 200 && typeof w1.json?.token === 'string', '观众用昵称进入观战席');
const watch1 = w1.json.token;
check(
  w1.json.snapshot.state.spectators.some((s) => s.name === '路人甲'),
  '观战名单里能看到自己的昵称'
);

const renamed = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  watch: watch1,
  body: { intent: { t: 'rename', name: '改名观众' } },
});
check(
  renamed.json?.state?.spectators?.some((s) => s.name === '改名观众'),
  '观众可以随时改昵称'
);

// ───────────────────────── 3. 四席入座 ─────────────────────────
const SEATS = ['RED_DESC', 'RED_GUESS', 'GREEN_DESC', 'GREEN_GUESS'];
const NAMES = { RED_DESC: '红描', RED_GUESS: '红猜', GREEN_DESC: '绿描', GREEN_GUESS: '绿猜' };
const seats = {};
for (const seat of SEATS) {
  const r = await api(`/api/rooms/${code}/seat`, { method: 'POST', body: { seat, name: NAMES[seat] } });
  check(r.status === 200 && r.json?.snapshot?.seat === seat, `${NAMES[seat]} 坐进 ${seat}`);
  seats[seat] = r.json?.token;
}

const occupied = await api(`/api/rooms/${code}/seat`, {
  method: 'POST',
  body: { seat: 'RED_DESC', name: '想抢座的人' },
});
check(occupied.status === 409, '已被占用的席位不能再入座', occupied.json);

const joinLog = await api(`/api/rooms/${code}`);
check(
  joinLog.json.state.log.some((l) => l.text.includes('红描')),
  '入座会写进房间流水'
);

// 大厅里的入座数与选手名要跟着走：这是「找到想进的房间」的主要依据
const lobbySeated = await api('/api/rooms');
const lobbyFull = (lobbySeated.json?.rooms ?? []).find((r) => r.code === code);
check(lobbyFull?.seated === 4, '四席坐满后大厅显示 4/4');
check(
  JSON.stringify(lobbyFull?.players) === JSON.stringify(['红描', '红猜', '绿描', '绿猜']),
  '大厅按席位顺序列出选手名',
  lobbyFull?.players
);

// ───────────────────────── 4. 规则设定：抢答开关（默认关） ─────────────────────────
const ruleDefault = await api(`/api/rooms/${code}`);
check(ruleDefault.json?.state?.stealEnabled === false, '抢答默认关闭');

const ruleBySpec = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  watch: watch1,
  body: { intent: { t: 'setSteal', enabled: true } },
});
check(ruleBySpec.status === 403, '观众不能改房间规则', ruleBySpec.json);

const ruleOn = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'setSteal', enabled: true } },
});
check(
  ruleOn.status === 200 && ruleOn.json?.state?.stealEnabled === true,
  '选手在开局前可以启用抢答',
  ruleOn.json
);

// ───────────────────────── 5. 题库：任何人上传、房主审批 ─────────────────────────
const propose = await api(`/api/rooms/${code}/bank/demo`, { method: 'POST', body: {}, watch: watch1 });
check(propose.status === 200, '观众也可以上传题库');
check((propose.json?.state?.bankProposals ?? []).length === 1, '上传的题库进入待审批列表');
check(propose.json?.state?.bank === null, '未经房主同意不会成为本局题库');
const proposalId = propose.json.state.bankProposals[0].id;

const badApprove = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'approveBank', id: proposalId } },
});
check(badApprove.status === 403, '选手不能替房主审批题库', badApprove.json);

const approved = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  host: hostKey,
  body: { intent: { t: 'approveBank', id: proposalId } },
});
check(approved.status === 200 && !!approved.json?.state?.bank, '房主同意后题库生效');
check((approved.json?.state?.bankProposals ?? []).length === 0, '同意后清空待审批列表');

// ───────────────────────── 5. 四席准备 → 自动开局 ─────────────────────────
for (const seat of ['RED_DESC', 'RED_GUESS', 'GREEN_DESC']) {
  await api(`/api/rooms/${code}/act`, {
    method: 'POST',
    seat: seats[seat],
    body: { intent: { t: 'ready', seat, value: true } },
  });
}
const threeReady = await api(`/api/rooms/${code}`, { seat: seats.GREEN_GUESS });
check(threeReady.json?.state?.phase === 'lobby', '三席准备时还在等待');
check(threeReady.json?.state?.ready?.GREEN_GUESS === false, '未准备的席位状态正确');

const fourth = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.GREEN_GUESS,
  body: { intent: { t: 'ready', seat: 'GREEN_GUESS', value: true } },
});
check(fourth.json?.state?.phase === 'select', '四席准备齐全后自动开局（不需要房主点开始）');
check(fourth.json?.state?.board?.length === 25, '开局后棋盘发满 25 格');

const ruleLate = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'setSteal', enabled: false } },
});
check(ruleLate.status === 409, '开局后不能再改规则', ruleLate.json);
check(
  typeof fourth.json?.state?.deadlineAt === 'number',
  '开局即开始 90 秒选格计时'
);

// ───────────────────────── 6. 对局：选格 / 描述 / 作答 / 历史记录 ─────────────────────────
const firstCell = fourth.json.state.board[0];
const selected = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'select', seat: 'RED_DESC', cellId: firstCell.id } },
});
check(selected.json?.state?.phase === 'describe', '描述位选格后进入描述阶段', selected.status, selected.json);
check(selected.json?.state?.history?.length === 1, '选中格子即建立一行公开记录', selected.json?.state?.history);

const descReveal = await api(`/api/rooms/${code}`, { seat: seats.RED_DESC });
check(typeof descReveal.json?.reveal?.word === 'string', '描述位拿到本格题面');
const answer = descReveal.json.reveal.word;

const guessReveal = await api(`/api/rooms/${code}`, { seat: seats.RED_GUESS });
check(guessReveal.json?.reveal === null, '猜词位拿不到题面');
const specReveal = await api(`/api/rooms/${code}`, { watch: watch1 });
check(specReveal.json?.reveal === null, '观众拿不到题面');
check(
  !JSON.stringify(specReveal.json?.state ?? {}).includes('"revealedWord":"'),
  '公开快照里不含未揭晓的答案'
);

const badDesc = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'describe', seat: 'RED_DESC', text: `一${answer[0]}` } },
});
check(badDesc.status === 409, '描述含答案里的字会被拒', badDesc.json);

const longDesc = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'describe', seat: 'RED_DESC', text: '一二三' } },
});
check(longDesc.status === 409, '描述必须恰好两个汉字', longDesc.json);

const clue = clueFor(answer);
const described = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'describe', seat: 'RED_DESC', text: clue } },
});
check(described.json?.state?.phase === 'guess', '描述提交后进入作答阶段', described.json?.error ?? described.json?.state?.phase);
check(described.json?.state?.description === clue, '描述对所有人公开');

const wrong = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_GUESS,
  body: { intent: { t: 'guess', seat: 'RED_GUESS', text: '肯定不是这个' } },
});
check(wrong.json?.state?.phase === 'describe', '答错后不跳到选格，仍在这一格');
check(wrong.json?.state?.activeDescriber === 'GREEN', '答错后改由对方描述');
check(wrong.json?.state?.result === null, '答错不结算');
check(wrong.json?.state?.history?.length === 1, '答错不新开记录行');

const rec = wrong.json.state.history[0];
check(rec.attempts[0]?.description === clue, '记录里保留描述内容');
check(rec.attempts[0]?.guesser === '红猜', '记录里保留猜词位昵称');
check(rec.attempts[0]?.outcome === 'wrong', '记录里保留结果');

// 观众能读到完整公开记录（这是回看与导出的数据源）
const specView = await api(`/api/rooms/${code}`, { watch: watch1 });
check(
  specView.json?.state?.history?.[0]?.attempts?.[0]?.description === clue,
  '观众也能看到公开的描述记录'
);

// 观众猜本格的词：猜中只在战况里写「观众 xx 猜中了 A2 格」，答案不出服务端
const specWrong = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  watch: watch1,
  body: { intent: { t: 'specGuess', text: '肯定不是这个' } },
});
check(
  specWrong.status === 200 && specWrong.json?.guessResult?.hit === false,
  '观众猜错只有自己知道（回执 hit=false）',
  specWrong.json
);
check(
  !(specWrong.json?.state?.log?.[0]?.text ?? '').includes('猜中了'),
  '猜错不写进公开战况'
);

const specHit = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  watch: watch1,
  body: { intent: { t: 'specGuess', text: answer } },
});
check(
  specHit.status === 200 && specHit.json?.guessResult?.hit === true,
  '观众猜中回执 hit=true',
  specHit.json?.error ?? specHit.json?.guessResult
);
const hitLine = specHit.json?.state?.log?.[0]?.text ?? '';
check(
  hitLine.includes('猜中了') && hitLine.includes('改名观众'),
  `战况写「观众 xx 猜中了 xx 格」：${hitLine}`
);
check(!hitLine.includes(answer), '战况里不出现答案本身');
check(specHit.json?.state?.phase === 'describe', '观众猜中不改变对局阶段');
check(
  specHit.json?.state?.history?.[0]?.attempts?.[0]?.outcome === 'wrong',
  '观众猜中不会被记成选手作答'
);

// 别的设备（选手）刷新战况也只看得到「猜中了」，看不到答案
const seatView = await api(`/api/rooms/${code}`, { seat: seats.RED_GUESS });
check(
  (seatView.json?.state?.log ?? []).some((l) => l.text.includes('猜中了')),
  '其他设备在同一条战况里看到「猜中了」'
);
check(
  !JSON.stringify(seatView.json?.state ?? {}).includes(answer),
  '选手的公开快照里仍然没有答案'
);
check(seatView.json?.reveal === null, '猜词位依旧拿不到题面');

// 选手不能借「观众猜词」绕开作答（席位身份没有观战身份）
const seatAsSpec = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_GUESS,
  body: { intent: { t: 'specGuess', text: answer } },
});
check(seatAsSpec.status === 403, '坐在席位上的人没有观众猜词入口', seatAsSpec.json);

// 换题：需要双方描述位各投一票（界面上两方都有自己的入口）
const swap1 = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'swap', seat: 'RED_DESC' } },
});
check(swap1.status === 200 && swap1.json?.state?.swapVotes?.length === 1, '红方描述位发起换题，先记一票', swap1.json);
const swapAgain = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'swap', seat: 'RED_DESC' } },
});
check(swapAgain.status === 409, '同一方不能重复投换题票', swapAgain.json);

// 对方可以拒绝：申请作废、题面不变（界面上不能只有「同意」没有「拒绝」）
const specReject = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  watch: watch1,
  body: { intent: { t: 'reject', kind: 'swap', seat: 'RED_DESC' } },
});
check(specReject.status === 401 || specReject.status === 403, '观众不能替选手拒绝申请', specReject.json);

const wordBeforeReject = (await api(`/api/rooms/${code}`, { seat: seats.RED_DESC })).json.reveal.word;
const swapRejected = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.GREEN_DESC,
  body: { intent: { t: 'reject', kind: 'swap', seat: 'GREEN_DESC' } },
});
check(
  swapRejected.status === 200 && (swapRejected.json?.state?.swapVotes ?? []).length === 0,
  '对方拒绝后换题申请立即作废',
  swapRejected.json
);
check(swapRejected.json?.state?.swapUsed === false, '拒绝不算用掉本格的换题机会');
const wordAfterReject = (await api(`/api/rooms/${code}`, { seat: seats.RED_DESC })).json.reveal.word;
check(wordAfterReject === wordBeforeReject, '拒绝换题后题面不变');

// 再来一次，这回对方同意
const swapRetry = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'swap', seat: 'RED_DESC' } },
});
check(swapRetry.json?.state?.swapVotes?.length === 1, '拒绝之后可以重新发起换题');
const swap2 = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.GREEN_DESC,
  body: { intent: { t: 'swap', seat: 'GREEN_DESC' } },
});
check(swap2.status === 200 && swap2.json?.state?.swapUsed === true, '对方描述位同意后换题生效', swap2.json);
check((swap2.json?.state?.history?.[0]?.attempts ?? []).length === 0, '换题后旧的描述与作答清空');

// 防抢答只在自己作答时可用：换题后还在描述阶段，锁不上
const lockTooEarly = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_GUESS,
  body: { intent: { t: 'lock', seat: 'RED_GUESS' } },
});
check(lockTooEarly.status === 409, '描述阶段不能防抢答（还没到自己的答题时机）', lockTooEarly.json);

// 抢答：绿方猜词位在红方作答窗口抢答
const steal = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.GREEN_GUESS,
  body: { intent: { t: 'steal', seat: 'GREEN_GUESS' } },
});
check(steal.status === 200 || steal.status === 409, '抢答请求被受理或有明确拒绝原因');
if (steal.status === 200) {
  const stealWrong = await api(`/api/rooms/${code}/act`, {
    method: 'POST',
    seat: seats.GREEN_GUESS,
    body: { intent: { t: 'guess', seat: 'GREEN_GUESS', text: '也不对' } },
  });
  check(stealWrong.json?.state?.phase === 'describe' || stealWrong.json?.state?.phase === 'guess', '抢答答错后继续本题');
}

// 收尾：让当前描述方猜对
const active = (
  await api(`/api/rooms/${code}`, { seat: seats.RED_DESC })
).json.state;
const activeTeam = active.activeDescriber;
const activeDescSeat = activeTeam === 'RED' ? 'RED_DESC' : 'GREEN_DESC';
const activeGuessSeat = activeTeam === 'RED' ? 'RED_GUESS' : 'GREEN_GUESS';
const activeReveal = await api(`/api/rooms/${code}`, { seat: seats[activeDescSeat] });
const activeAnswer = activeReveal.json.reveal.word;

let cur = await api(`/api/rooms/${code}`, { seat: seats[activeDescSeat] });
if (cur.json.state.phase === 'describe') {
  await api(`/api/rooms/${code}/act`, {
    method: 'POST',
    seat: seats[activeDescSeat],
    body: { intent: { t: 'describe', seat: activeDescSeat, text: clueFor(activeAnswer, 4) } },
  });
}
const solved = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats[activeGuessSeat],
  body: { intent: { t: 'guess', seat: activeGuessSeat, text: activeAnswer } },
});
check(solved.json?.state?.phase === 'result', '猜对后进入结算');
check(solved.json?.state?.history?.[0]?.owner === activeTeam, '记录行写下归属');
check(solved.json?.state?.history?.[0]?.word === activeAnswer, '记录行留下答案（已公开）');

// 暂停：结算展示期间也可冻结
const paused = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'pause' } },
});
check(paused.json?.state?.pausedAt > 0, '选手可以随时暂停');
const paused2 = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.GREEN_DESC,
  body: { intent: { t: 'pause' } },
});
check(paused2.status === 409, '重复暂停会被拒');

const frozen = await api(`/api/rooms/${code}`);
// 结算展示只有 3 秒：若猜对到暂停之间慢过 3 秒，房间会先自动进入下一轮选格。
// 断言「暂停后相位不再变化」而不是写死 result，避免把这种正常推进误判为失败。
check(
  frozen.json?.state?.phase === paused.json?.state?.phase && frozen.json?.state?.pausedAt > 0,
  '暂停期间结算不会自动推进',
  { pausedPhase: paused.json?.state?.phase, frozenPhase: frozen.json?.state?.phase }
);

const resumed = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'resume' } },
});
check(resumed.json?.state?.pausedAt === null, '可以继续对局');

// ───────────────────────── 7. 开发者模式 ─────────────────────────
const devRoom = await api('/api/rooms', { method: 'POST', body: { name: '测试者', dev: true } });
check(typeof devRoom.json?.devToken === 'string', '开发者建房会拿到开发者凭证', devRoom.json);
const dc = devRoom.json.code;
const dh = devRoom.json.hostToken;
const dd = devRoom.json.devToken;

const devSnap = await api(`/api/rooms/${dc}`, { dev: dd });
check(devSnap.json?.isDev === true, '带开发者凭证的快照标记 isDev');

const setup = await api(`/api/rooms/${dc}/act`, { method: 'POST', dev: dd, body: { intent: { t: 'devSetup' } } });
check(
  SEATS.every((s) => !!setup.json?.state?.players?.[s]),
  '开发者一次坐满四个测试席位'
);
check(
  setup.json.state.players.RED_DESC === '测试甲',
  '测试席位带默认昵称'
);

const devProposal = await api(`/api/rooms/${dc}/bank/demo`, { method: 'POST', body: {}, dev: dd });
check(devProposal.status === 200, '开发者上传示例题库');
const devPid = devProposal.json.state.bankProposals[0].id;
await api(`/api/rooms/${dc}/act`, {
  method: 'POST',
  host: dh,
  body: { intent: { t: 'approveBank', id: devPid } },
});
await api(`/api/rooms/${dc}/act`, { method: 'POST', dev: dd, body: { intent: { t: 'devReadyAll' } } });
const devStarted = await api(`/api/rooms/${dc}`, { dev: dd });
check(devStarted.json?.state?.phase === 'select', '开发模式下四席准备后自动开局');

const devCell = devStarted.json.state.board[0];
const devSelect = await api(`/api/rooms/${dc}/act`, {
  method: 'POST',
  dev: dd,
  body: { intent: { t: 'select', seat: 'RED_DESC', cellId: devCell.id } },
});
check(devSelect.json?.state?.phase === 'describe', '开发者可以代替描述位选格');
const devAnswer = devSelect.json?.reveal?.word;
check(typeof devAnswer === 'string', '开发者看得到当前格题面');

const devDescribe = await api(`/api/rooms/${dc}/act`, {
  method: 'POST',
  dev: dd,
  body: { intent: { t: 'describe', seat: 'RED_DESC', text: clueFor(devAnswer) } },
});
check(devDescribe.json?.state?.phase === 'guess', '开发者可以代替描述位提交描述');

const devGuess = await api(`/api/rooms/${dc}/act`, {
  method: 'POST',
  dev: dd,
  body: { intent: { t: 'guess', seat: 'RED_GUESS', text: '故意猜错' } },
});
check(devGuess.json?.state?.activeDescriber === 'GREEN', '开发者可以代替猜词位作答（走同一套规则）');

await api(`/api/rooms/${dc}/act`, {
  method: 'POST',
  dev: dd,
  body: { intent: { t: 'describe', seat: 'GREEN_DESC', text: clueFor(devAnswer, 6) } },
});
const devSolve = await api(`/api/rooms/${dc}/act`, {
  method: 'POST',
  dev: dd,
  body: { intent: { t: 'guess', seat: 'GREEN_GUESS', text: devAnswer } },
});
check(devSolve.json?.state?.result?.team === 'GREEN', '代打绿方猜词位可以正常拿下这一格');
check(devSolve.json?.state?.history?.[0]?.attempts?.length >= 2, '一次一格记录两队的描述与作答');

// 开发者专属意图在普通房间必须被拒
const devOnly = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'devSetup' } },
});
check(devOnly.status === 403, '非开发者不能使用开发者操作', devOnly.json);

// ───────────────────────── 8. 重开：四个席位全同意 ─────────────────────────
const restartBySpec = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  watch: watch1,
  body: { intent: { t: 'restart', seat: 'RED_DESC' } },
});
check(restartBySpec.status === 401, '观众不能替选手投重开票', restartBySpec.json);

const vote1 = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'restart', seat: 'RED_DESC' } },
});
check(vote1.status === 200 && vote1.json?.state?.restartVotes?.length === 1, '一席同意重开先记一票', vote1.json);

const voteUndo = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'restart', seat: 'RED_DESC' } },
});
check(voteUndo.json?.state?.restartVotes?.length === 0, '再点一次撤回同意');

await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_DESC,
  body: { intent: { t: 'restart', seat: 'RED_DESC' } },
});
await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.RED_GUESS,
  body: { intent: { t: 'restart', seat: 'RED_GUESS' } },
});
const vote3 = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.GREEN_DESC,
  body: { intent: { t: 'restart', seat: 'GREEN_DESC' } },
});
check(vote3.json?.state?.restartVotes?.length === 3, '三票还不重开', vote3.json);
check(vote3.json?.state?.phase !== 'select' || vote3.json?.state?.round !== 1, '三票时仍在对局中');

const vote4 = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: seats.GREEN_GUESS,
  body: { intent: { t: 'restart', seat: 'GREEN_GUESS' } },
});
check(vote4.json?.state?.phase === 'select', '四席同意后立即重开', vote4.json);
check(vote4.json?.state?.history?.length === 0, '重开后对局历史清空');
check(
  vote4.json?.state?.board?.length === 25 && vote4.json.state.board.every((c) => !c.owner),
  '重开后棋盘清空重发 25 格'
);
check(vote4.json?.state?.restartVotes?.length === 0, '重开后表决清零');
check(vote4.json?.state?.stealEnabled === true, '重开沿用抢答开关');

// ───────────────────────── 9. 安全：冒用与篡改 ─────────────────────────
const spectatorAct = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  watch: watch1,
  body: { intent: { t: 'describe', seat: 'RED_DESC', text: '甲乙' } },
});
check(spectatorAct.status === 401, '观众不能直接替选手操作', spectatorAct.json);

const fakeSeat = await api(`/api/rooms/${code}/act`, {
  method: 'POST',
  seat: 'f'.repeat(32),
  body: { intent: { t: 'describe', seat: 'RED_DESC', text: '甲乙' } },
});
check(fakeSeat.status === 401, '伪造席位凭证被拒', fakeSeat.json);

// ───────────────────────── 9. 解散房间与房号回收 ─────────────────────────
const doomed = await api('/api/rooms', { method: 'POST', body: { name: '待解散' } });
check(doomed.status === 200, '再建一间用于解散测试', doomed.json);
const dcode = doomed.json?.code;
const dhost = doomed.json?.hostToken;

// 游客（无任何凭证）不能解散
const closeByStranger = await api(`/api/rooms/${dcode}/act`, {
  method: 'POST',
  body: { intent: { t: 'close' } },
});
check(closeByStranger.status === 403, '游客不能解散房间', closeByStranger.json);

const closed = await api(`/api/rooms/${dcode}/act`, {
  method: 'POST',
  host: dhost,
  body: { intent: { t: 'close' } },
});
check(
  closed.status === 200 && typeof closed.json?.state?.closedAt === 'number',
  '房主可以解散房间'
);

const actAfterClose = await api(`/api/rooms/${dcode}/act`, {
  method: 'POST',
  host: dhost,
  body: { intent: { t: 'rename', name: '还想改名' } },
});
check(actAfterClose.status === 409, '解散后房间不再接受任何操作', actAfterClose.json);

const closedSnap = await api(`/api/rooms/${dcode}`);
check(
  closedSnap.status === 200 && !!closedSnap.json?.state?.closedAt,
  '解散后仍能读到快照（界面提示「房间已解散」）'
);

// 大厅不能列出已解散的房间：否则点进去就是「房间已解散」，等于大厅在骗人
const lobbyAfterClose = await api('/api/rooms');
check(
  !(lobbyAfterClose.json?.rooms ?? []).some((r) => r.code === dcode),
  '解散的房间立刻从大厅消失'
);

// 房号回收：解散的房间号会被下一间新房原地复用（不需要 DELETE 权限）
const reused = await api('/api/rooms', { method: 'POST', body: { name: '回收测试' } });
check(
  reused.status === 200 && reused.json?.code === dcode,
  `解散后房号立即回收：${dcode} → ${reused.json?.code}`,
  reused.json
);

// 开发者也可以解散：测试房间用完即走，不在表里留垃圾
const devClose = await api(`/api/rooms/${dc}/act`, {
  method: 'POST',
  dev: dd,
  body: { intent: { t: 'close' } },
});
check(
  devClose.status === 200 && typeof devClose.json?.state?.closedAt === 'number',
  '开发者也可以解散房间'
);

// ───────────────────────── 10. 明文词库：文本导入 + 服务端二次清洗 ─────────────────────────
// 前端把粘贴的文本识别成数组，服务端不相信这个数组：重新判长度、重新去重、重新过滤。
const textRoom = await api('/api/rooms', { method: 'POST', body: { name: '明文房主' } });
const tcode = textRoom.json.code;
const thost = textRoom.json.hostToken;
const twatch = textRoom.json.watchToken;

const few = await api(`/api/rooms/${tcode}/bank/text`, {
  method: 'POST',
  watch: twatch,
  body: { name: '太少', words: [{ word: '甲' }, { word: '乙' }] },
});
check(few.status === 400, '明文词库不足 25 词被拒', few.json);

const junk = await api(`/api/rooms/${tcode}/bank/text`, {
  method: 'POST',
  watch: twatch,
  body: { name: '垃圾', words: ['***', '2026', { word: '' }, null] },
});
check(junk.status === 400, '全是垃圾词时被拒（不是空词库进审批）', junk.json);

const plainWords = Array.from({ length: 30 }, (_, i) => ({ word: `词语${i}` }));
const plain = await api(`/api/rooms/${tcode}/bank/text`, {
  method: 'POST',
  watch: twatch,
  body: { name: '明文题库', words: plainWords },
});
check(plain.status === 200, '观众也能提交明文词库', plain.json);
check(plain.json?.state?.bankProposals?.[0]?.count === 30, '30 个词进入待审批');
check(!JSON.stringify(plain.json).includes('词语0'), '公开快照里读不到任何词（只有词数/指纹）');
const plainPid = plain.json.state.bankProposals[0].id;

// 重复、首尾空白、超长提示：都在服务端被洗掉，不会被当成新词
const dirtyWords = [
  ...plainWords,
  ...plainWords.slice(0, 5),
  { word: '  词语99  ', hint: 'x'.repeat(200) },
  { word: '词语100' },
];
const dirty = await api(`/api/rooms/${tcode}/bank/text`, {
  method: 'POST',
  watch: twatch,
  body: { name: '脏数据', words: dirtyWords },
});
const dirtyProposal = (dirty.json?.state?.bankProposals ?? []).find((p) => p.name === '脏数据');
check(dirtyProposal?.count === 32, `重复被合并、空白被修剪（${dirtyProposal?.count} = 30 + 1 + 1）`, dirty.json);

const again = await api(`/api/rooms/${tcode}/bank/text`, {
  method: 'POST',
  watch: twatch,
  body: { name: '同内容', words: plainWords },
});
const againProposal = (again.json?.state?.bankProposals ?? []).find((p) => p.name === '同内容');
check(
  againProposal?.fingerprint === plain.json.state.bankProposals[0].fingerprint,
  '同样内容的词表指纹一致（与传输形式无关）',
  again.status,
  againProposal?.fingerprint,
  plain.json.state.bankProposals[0].fingerprint,
  again.json
);

const strangerBank = await api(`/api/rooms/${tcode}/bank/text`, {
  method: 'POST',
  body: { name: '路人', words: plainWords },
});
check(strangerBank.status === 401, '不在房间里的人不能提交词库', strangerBank.json);

const textApproved = await api(`/api/rooms/${tcode}/act`, {
  method: 'POST',
  host: thost,
  body: { intent: { t: 'approveBank', id: plainPid } },
});
check(
  textApproved.status === 200 &&
    textApproved.json?.state?.bank?.count === 30 &&
    textApproved.json?.state?.bank?.name === '明文题库',
  '房主同意后明文题库生效',
  textApproved.json
);
check(textApproved.json?.state?.bank?.fingerprint?.length === 12, '带 12 位内容指纹');
check(!JSON.stringify(textApproved.json).includes('词语0'), '生效后的快照依然不含词表');

// ───────────────────────── 8. 观众裁判系统 ─────────────────────────
console.log('\n== 8. 观众裁判权限与操作 ==');
// 新建一间带开发者模式的房间，快速坐满开局
const refRoomRes = await api('/api/rooms', { method: 'POST', body: { name: '裁判房主', dev: true } });
check(refRoomRes.status === 200, '创建裁判测试房间成功');
const rCode = refRoomRes.json?.code;
const rHost = refRoomRes.json?.hostToken;
const rDev = refRoomRes.json?.devToken;

// 开发者一键坐满并导入示例题库
await api(`/api/rooms/${rCode}/act`, { method: 'POST', dev: rDev, body: { intent: { t: 'devSetup' } } });
const rDemoProp = await api(`/api/rooms/${rCode}/bank/demo`, { method: 'POST', body: {}, dev: rDev });
const rDemoPid = rDemoProp.json?.state?.bankProposals?.[0]?.id;
if (rDemoPid) {
  await api(`/api/rooms/${rCode}/act`, {
    method: 'POST',
    host: rHost,
    body: { intent: { t: 'approveBank', id: rDemoPid } },
  });
}
await api(`/api/rooms/${rCode}/act`, { method: 'POST', dev: rDev, body: { intent: { t: 'devReadyAll' } } });
const rStart = await api(`/api/rooms/${rCode}`, { dev: rDev });
check(rStart.json?.state?.phase === 'select', '四席准备开局成功，棋盘已发满 25 格');

// 注册新观众
const refSpecRes = await api(`/api/rooms/${rCode}/watch`, { method: 'POST', body: { name: '执法裁判员' } });
check(refSpecRes.status === 200, '观众进入房间成功');
const refWatch = refSpecRes.json?.token;
const refSpecId = refSpecRes.json?.snapshot?.spectator?.id;

// 普通观众快照：拿不到全局题面
const normalSnap = await api(`/api/rooms/${rCode}`, { watch: refWatch });
check(normalSnap.json?.isReferee === false, '初始进入默认为普通观众（非裁判）');
check(normalSnap.json?.allCellWords === null, '普通观众快照拿不到全知题面');

// 普通观众尝试改词被拒 (403)
const illegalEdit = await api(`/api/rooms/${rCode}/act`, {
  method: 'POST',
  watch: refWatch,
  body: { intent: { t: 'refereeEditCell', cellId: 'cell-0-0', word: '非法修改' } },
});
check(illegalEdit.status === 403, '非裁判尝试修改格子被拒 403', illegalEdit.json);

// 房主将该观众设为裁判
const setRefRes = await api(`/api/rooms/${rCode}/act`, {
  method: 'POST',
  host: rHost,
  body: { intent: { t: 'setReferee', spectatorId: refSpecId, enabled: true } },
});
check(setRefRes.status === 200, '成功将观众设为裁判');
check(setRefRes.json?.state?.refereeIds?.includes(refSpecId), '状态中包含该裁判 ID');

// 裁判获取快照：成功下发全知题面用于透视
const refSnap = await api(`/api/rooms/${rCode}`, { watch: refWatch });
check(refSnap.json?.isReferee === true, '裁判身份生效');
check(refSnap.json?.allCellWords && Object.keys(refSnap.json.allCellWords).length === 25, '裁判快照成功获得全部 25 格题面供透视');

// 裁判直接修改格子词语和外显代号（中途有效）
const editCellRes = await api(`/api/rooms/${rCode}/act`, {
  method: 'POST',
  watch: refWatch,
  body: { intent: { t: 'refereeEditCell', cellId: 'cell-0-0', word: '海豚', code: 'HT2' } },
});
check(editCellRes.status === 200, '裁判修改格子成功');
const cell00 = editCellRes.json?.state?.board?.find((c) => c.id === 'cell-0-0');
check(cell00?.code === 'HT2', '格子代号成功改为 HT2');
check(editCellRes.json?.allCellWords?.['cell-0-0']?.word === '海豚', '透视题面中词语已更新为海豚');

// 裁判改变格子的位置
const swapRes = await api(`/api/rooms/${rCode}/act`, {
  method: 'POST',
  watch: refWatch,
  body: { intent: { t: 'refereeSwapCells', cellIdA: 'cell-0-0', cellIdB: 'cell-0-1' } },
});
check(swapRes.status === 200, '裁判改变格子位置成功');
const swappedA = swapRes.json?.state?.board?.find((c) => c.id === 'cell-0-0');
check(swappedA?.row === 0 && swappedA?.col === 1, '格子位置成功互换');

// 裁判撤销上一步操作
check(swapRes.json?.state?.canUndo === true, '存在可撤销的历史步骤');
const undoRes = await api(`/api/rooms/${rCode}/act`, {
  method: 'POST',
  watch: refWatch,
  body: { intent: { t: 'refereeUndo' } },
});
check(undoRes.status === 200, '裁判成功撤销上一步');
const restoredA = undoRes.json?.state?.board?.find((c) => c.id === 'cell-0-0');
check(restoredA?.row === 0 && restoredA?.col === 0, '撤销后格子位置成功恢复');

// 裁判恢复操作
check(undoRes.json?.state?.canRedo === true, '存在可恢复的历史步骤');
const redoRes = await api(`/api/rooms/${rCode}/act`, {
  method: 'POST',
  watch: refWatch,
  body: { intent: { t: 'refereeRedo' } },
});
check(redoRes.status === 200, '裁判成功恢复撤销的操作');
const redoneA = redoRes.json?.state?.board?.find((c) => c.id === 'cell-0-0');
check(redoneA?.row === 0 && redoneA?.col === 1, '恢复后位置再次变为互换后的位置');

// 裁判撤销/恢复后系统已自动安全暂停对局
check(typeof redoRes.json?.state?.pausedAt === 'number', '撤销/恢复后对局已自动安全暂停');

// 裁判继续对局
const resumeRes1 = await api(`/api/rooms/${rCode}/act`, {
  method: 'POST',
  watch: refWatch,
  body: { intent: { t: 'resume' } },
});
check(resumeRes1.status === 200 && !resumeRes1.json?.state?.pausedAt, '裁判成功继续对局');

// 裁判主动暂停对局
const pauseRes = await api(`/api/rooms/${rCode}/act`, {
  method: 'POST',
  watch: refWatch,
  body: { intent: { t: 'pause' } },
});
check(pauseRes.status === 200 && typeof pauseRes.json?.state?.pausedAt === 'number', '裁判成功暂停对局');

// 裁判再次继续对局
const resumeRes2 = await api(`/api/rooms/${rCode}/act`, {
  method: 'POST',
  watch: refWatch,
  body: { intent: { t: 'resume' } },
});
check(resumeRes2.status === 200 && !resumeRes2.json?.state?.pausedAt, '裁判再次继续对局');

await api(`/api/rooms/${rCode}/act`, { method: 'POST', host: rHost, body: { intent: { t: 'close' } } });

// ─────────────── 身份识别：同一台设备不该在房间里变成两个人 ───────────────
// 曾经的 bug：进房 → 点「返回」（清本机凭据）→ 再进，服务端每次都当新观众，
// 观战名单里于是留下两条同名记录；坐在席位上退出再进更糟——席位里一个你、
// 观战名单里又一个你。修法见 src/identity.ts：令牌丢了按设备号认回同一个人。
const idRoom = await api('/api/rooms', {
  method: 'POST',
  body: { name: '身份房主' },
  device: 'dev-host-0001',
});
const idCode = idRoom.json?.code;
const idHost = idRoom.json?.hostToken;
check(typeof idCode === 'string', `身份用例：建房成功 ${idCode}`);

// 1) 房主清掉本机凭据后回到同一房号：靠设备号仍然是房主
const hostBack = await api(`/api/rooms/${idCode}`, { device: 'dev-host-0001' });
check(hostBack.json?.isHost === true, '房主丢了房主令牌，靠设备号仍是房主');

// 2) 同一设备反复进房（每次都不带令牌）：始终是同一个身份，名单里只有一条
const g1 = await api(`/api/rooms/${idCode}/watch`, {
  method: 'POST',
  body: { name: '阿蓝' },
  device: 'dev-guest-0001',
});
const guestId = g1.json?.snapshot?.spectator?.id;
const g2 = await api(`/api/rooms/${idCode}/watch`, {
  method: 'POST',
  body: { name: '阿蓝' },
  device: 'dev-guest-0001',
});
check(!!guestId && g2.json?.snapshot?.spectator?.id === guestId, `重进房间仍是同一身份：${guestId}`);
const dupGuest = g2.json?.snapshot?.state?.spectators?.filter((s) => s.name === '阿蓝').length ?? -1;
check(dupGuest === 1, `观战名单里「阿蓝」只有一条（实际 ${dupGuest}）`);

// 3) 坐进席位后清掉席位令牌再进房：服务端直接把座位还回来，不再登记观众
const gSeat = await api(`/api/rooms/${idCode}/seat`, {
  method: 'POST',
  body: { seat: 'RED_DESC', name: '阿蓝' },
  device: 'dev-guest-0001',
});
const guestSeatToken = gSeat.json?.token;
check(gSeat.status === 200 && gSeat.json?.snapshot?.seat === 'RED_DESC', '阿蓝坐上红方描述位');
const backSeated = await api(`/api/rooms/${idCode}/watch`, {
  method: 'POST',
  body: { name: '阿蓝' },
  device: 'dev-guest-0001',
});
check(backSeated.json?.snapshot?.seat === 'RED_DESC', '丢掉席位令牌后进房，座位被认回');
check(backSeated.json?.token === guestSeatToken, '还回来的是原来那枚席位令牌');
const ghostSelf = backSeated.json?.snapshot?.state?.spectators?.filter((s) => s.name === '阿蓝').length ?? -1;
check(ghostSelf === 0, `同一个人没有同时出现在观战名单里（避免「两个自己」，实际 ${ghostSelf}）`);

// 4) 换一台设备用同昵称进来：那是另一个人，必须拿到独立身份（不按昵称合并）
const otherDev = await api(`/api/rooms/${idCode}/watch`, {
  method: 'POST',
  body: { name: '阿蓝' },
  device: 'dev-guest-0002',
});
check(
  !!otherDev.json?.snapshot?.spectator?.id && otherDev.json.snapshot.spectator.id !== guestId,
  '换设备视为另一个人，拿到独立身份（不按昵称去重）'
);

// 5) 离席再观战：仍然是原来那个观众身份，不会又多一条
const leftSeat = await api(`/api/rooms/${idCode}/act`, {
  method: 'POST',
  seat: guestSeatToken,
  device: 'dev-guest-0001',
  body: { intent: { t: 'leave' } },
});
check(leftSeat.json?.seat === null, '离席后不再占席位');
const specAgain = await api(`/api/rooms/${idCode}/watch`, {
  method: 'POST',
  body: { name: '阿蓝' },
  device: 'dev-guest-0001',
});
check(specAgain.json?.snapshot?.spectator?.id === guestId, '离席再观战仍是原来那个观众身份');
const twoPeople = specAgain.json?.snapshot?.state?.spectators?.filter((s) => s.name === '阿蓝').length ?? -1;
check(twoPeople === 2, `两台设备两个「阿蓝」是合法的（实际 ${twoPeople} 条）`);

await api(`/api/rooms/${idCode}/act`, {
  method: 'POST',
  host: idHost,
  device: 'dev-host-0001',
  body: { intent: { t: 'close' } },
});

// ───────────────────────── 9. 判对申请（双票改判） ─────────────────────────
const jRoom = await api('/api/rooms', { method: 'POST', body: { name: '判对房主', dev: true } });
const jc = jRoom.json.code;
const jh = jRoom.json.hostToken;
const jd = jRoom.json.devToken;
await api(`/api/rooms/${jc}/act`, { method: 'POST', dev: jd, body: { intent: { t: 'devSetup' } } });
const jBank = await api(`/api/rooms/${jc}/bank/demo`, { method: 'POST', body: {}, dev: jd });
await api(`/api/rooms/${jc}/act`, {
  method: 'POST',
  host: jh,
  body: { intent: { t: 'approveBank', id: jBank.json.state.bankProposals[0].id } },
});
await api(`/api/rooms/${jc}/act`, { method: 'POST', dev: jd, body: { intent: { t: 'devReadyAll' } } });
const jStarted = await api(`/api/rooms/${jc}`, { dev: jd });
check(jStarted.json?.state?.phase === 'select', '判对用房已开局');
const jCell = jStarted.json.state.board[0];
const jSelect = await api(`/api/rooms/${jc}/act`, {
  method: 'POST',
  dev: jd,
  body: { intent: { t: 'select', seat: 'RED_DESC', cellId: jCell.id } },
});
const jAnswer = jSelect.json?.reveal?.word;
await api(`/api/rooms/${jc}/act`, {
  method: 'POST',
  dev: jd,
  body: { intent: { t: 'describe', seat: 'RED_DESC', text: clueFor(jAnswer) } },
});
const jGuess = await api(`/api/rooms/${jc}/act`, {
  method: 'POST',
  dev: jd,
  body: { intent: { t: 'guess', seat: 'RED_GUESS', text: '同义说法' } },
});
check(jGuess.json?.state?.activeDescriber === 'GREEN', '判对场景：红方猜错后转绿方描述');

const jFirst = await api(`/api/rooms/${jc}/act`, {
  method: 'POST',
  dev: jd,
  body: { intent: { t: 'judge', seat: 'RED_DESC' } },
});
check(jFirst.json?.state?.judgeVotes?.length === 1, '描述位申请判对，先记一票', jFirst.json);
check(jFirst.json?.state?.judgeTarget?.guess === '同义说法', '首票锁定要改判的那句猜词');
check(jFirst.json?.state?.board?.find((c) => c.id === jCell.id)?.owner === null, '一票不结算');
const jGuessSeatVote = await api(`/api/rooms/${jc}/act`, {
  method: 'POST',
  dev: jd,
  body: { intent: { t: 'judge', seat: 'RED_GUESS' } },
});
check(jGuessSeatVote.status === 409, '猜词位不能申请判对', jGuessSeatVote.json);

const jSecond = await api(`/api/rooms/${jc}/act`, {
  method: 'POST',
  dev: jd,
  body: { intent: { t: 'judge', seat: 'GREEN_DESC' } },
});
check(jSecond.json?.state?.board?.find((c) => c.id === jCell.id)?.owner === 'RED', '双方描述位同意后改判给猜词方', jSecond.json);
check(jSecond.json?.state?.phase === 'result', '改判后进入结算');
check(
  (jSecond.json?.state?.history?.[0]?.attempts ?? []).some((a) => a.guess === '同义说法' && a.outcome === 'correct'),
  '那次猜词被记成 correct'
);
check((jSecond.json?.state?.judgeVotes ?? []).length === 0, '改判后清空投票状态');

await api(`/api/rooms/${jc}/act`, { method: 'POST', host: jh, dev: jd, body: { intent: { t: 'close' } } });

// ─────────────────── 10. 撤回申请（对方任意一人同意） ───────────────────
const uRoom = await api('/api/rooms', { method: 'POST', body: { name: '撤回房主', dev: true } });
const uc = uRoom.json.code;
const uh = uRoom.json.hostToken;
const ud = uRoom.json.devToken;
await api(`/api/rooms/${uc}/act`, { method: 'POST', dev: ud, body: { intent: { t: 'devSetup' } } });
const uBank = await api(`/api/rooms/${uc}/bank/demo`, { method: 'POST', body: {}, dev: ud });
await api(`/api/rooms/${uc}/act`, {
  method: 'POST',
  host: uh,
  body: { intent: { t: 'approveBank', id: uBank.json.state.bankProposals[0].id } },
});
await api(`/api/rooms/${uc}/act`, { method: 'POST', dev: ud, body: { intent: { t: 'devReadyAll' } } });
const uStarted = await api(`/api/rooms/${uc}`, { dev: ud });
check(uStarted.json?.state?.phase === 'select', '撤回用房已开局');
const uCell = uStarted.json.state.board[0];
const uSelect = await api(`/api/rooms/${uc}/act`, {
  method: 'POST',
  dev: ud,
  body: { intent: { t: 'select', seat: 'RED_DESC', cellId: uCell.id } },
});
const uAnswer = uSelect.json?.reveal?.word;
await api(`/api/rooms/${uc}/act`, {
  method: 'POST',
  dev: ud,
  body: { intent: { t: 'describe', seat: 'RED_DESC', text: clueFor(uAnswer) } },
});

// 没有席位凭证的人不能发起撤回
const uAsViewer = await api(`/api/rooms/${uc}/act`, {
  method: 'POST',
  body: { intent: { t: 'undo', seat: 'RED_DESC' } },
});
check(uAsViewer.status === 401, '没有席位凭证不能发起撤回', uAsViewer.json);

const uAsk = await api(`/api/rooms/${uc}/act`, {
  method: 'POST',
  dev: ud,
  body: { intent: { t: 'undo', seat: 'RED_DESC' } },
});
check(uAsk.json?.state?.undoRequest?.kind === 'desc', '提交描述后可以申请撤回描述', uAsk.json);
check(uAsk.json?.state?.phase === 'guess', '申请不影响当前阶段');

const uSelf = await api(`/api/rooms/${uc}/act`, {
  method: 'POST',
  dev: ud,
  body: { intent: { t: 'undoAgree', seat: 'RED_GUESS' } },
});
check(uSelf.status === 409, '本队不能自己批准撤回', uSelf.json);

const uAgreed = await api(`/api/rooms/${uc}/act`, {
  method: 'POST',
  dev: ud,
  body: { intent: { t: 'undoAgree', seat: 'GREEN_GUESS' } },
});
check(uAgreed.json?.state?.phase === 'describe', '对方猜词位同意后回到描述阶段', uAgreed.json);
check(uAgreed.json?.state?.description === null, '被撤回的描述已作废');
check((uAgreed.json?.state?.undoRequest ?? null) === null, '撤回后申请被清空');

// 重新描述 → 猜错 → 撤回作答
const uDesc = clueFor(uAnswer);
await api(`/api/rooms/${uc}/act`, {
  method: 'POST',
  dev: ud,
  body: { intent: { t: 'describe', seat: 'RED_DESC', text: uDesc } },
});
const uWrong = await api(`/api/rooms/${uc}/act`, {
  method: 'POST',
  dev: ud,
  body: { intent: { t: 'guess', seat: 'RED_GUESS', text: '不对的说法' } },
});
check(uWrong.json?.state?.activeDescriber === 'GREEN', '答错后交棒给绿方');

const uGuessAsk = await api(`/api/rooms/${uc}/act`, {
  method: 'POST',
  dev: ud,
  body: { intent: { t: 'undo', seat: 'RED_GUESS' } },
});
check(uGuessAsk.json?.state?.undoRequest?.kind === 'guess', '可以申请撤回刚才的作答', uGuessAsk.json);

const uGuessOk = await api(`/api/rooms/${uc}/act`, {
  method: 'POST',
  dev: ud,
  body: { intent: { t: 'undoAgree', seat: 'GREEN_DESC' } },
});
check(uGuessOk.json?.state?.phase === 'guess', '同意后回到作答阶段', uGuessOk.json);
check(uGuessOk.json?.state?.activeDescriber === 'RED', '作答权回到红方');
check(uGuessOk.json?.state?.description === uDesc, '描述保留，可以直接重答');
check(
  !(uGuessOk.json?.state?.tried ?? []).includes('RED'),
  '红方不再算本格已试过'
);

await api(`/api/rooms/${uc}/act`, { method: 'POST', host: uh, dev: ud, body: { intent: { t: 'close' } } });

// ─────────────────── 11. 别名答案：词表里的「甲/乙」 ───────────────────
// 词表里写「天地/天地别」= 一个词、两种写法都算答对；棋盘与历史只显示斜杠前那个。
{
  const POOL = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙';
  const pairs = Array.from({ length: 26 }, (_, i) => POOL.slice(i * 2, i * 2 + 2));
  const altWords = pairs.map((w) => ({ word: w, alt: [`${w}别`] }));

  const aRoom = await api('/api/rooms', { method: 'POST', body: { name: '别名房主', dev: true } });
  const ac = aRoom.json.code;
  const ah = aRoom.json.hostToken;
  const ad = aRoom.json.devToken;
  await api(`/api/rooms/${ac}/act`, { method: 'POST', dev: ad, body: { intent: { t: 'devSetup' } } });

  const aProposal = await api(`/api/rooms/${ac}/bank/text`, {
    method: 'POST',
    dev: ad,
    body: { name: '别名题库', words: altWords },
  });
  check(aProposal.json?.state?.bankProposals?.[0]?.count === 26, '带别名的词表按「词」计数，别名不额外占位', aProposal.json);
  check(!JSON.stringify(aProposal.json).includes('天地别'), '公开快照里看不到别名');

  await api(`/api/rooms/${ac}/act`, {
    method: 'POST',
    host: ah,
    body: { intent: { t: 'approveBank', id: aProposal.json.state.bankProposals[0].id } },
  });
  await api(`/api/rooms/${ac}/act`, { method: 'POST', dev: ad, body: { intent: { t: 'devReadyAll' } } });

  const aStarted = await api(`/api/rooms/${ac}`, { dev: ad });
  const aCell = aStarted.json.state.board[0];
  const aSelect = await api(`/api/rooms/${ac}/act`, {
    method: 'POST',
    dev: ad,
    body: { intent: { t: 'select', seat: 'RED_DESC', cellId: aCell.id } },
  });
  const aAnswer = aSelect.json?.reveal?.word;
  check(typeof aAnswer === 'string' && aAnswer.length === 2, '描述位只拿到展示词（两字）', aSelect.json);

  const aClue = [...'甲乙丙丁'].find((c) => !aAnswer.includes(c));
  const clue2 = [...'甲乙丙丁'].filter((c) => !aAnswer.includes(c)).slice(0, 2).join('');
  await api(`/api/rooms/${ac}/act`, {
    method: 'POST',
    dev: ad,
    body: { intent: { t: 'describe', seat: 'RED_DESC', text: clue2 || aClue + aClue } },
  });
  const aAliasGuess = await api(`/api/rooms/${ac}/act`, {
    method: 'POST',
    dev: ad,
    body: { intent: { t: 'guess', seat: 'RED_GUESS', text: `${aAnswer}别` } },
  });
  check(aAliasGuess.json?.state?.phase === 'result', '用别名作答同样判对', aAliasGuess.json);
  check(
    aAliasGuess.json?.state?.board?.find((c) => c.id === aCell.id)?.owner === 'RED',
    '别名答对后正常占格'
  );
  check(
    aAliasGuess.json?.state?.history?.[0]?.word === aAnswer,
    '历史里写的是展示词，不是别名'
  );
  // 玩家自己打出来的猜测词会进对局历史（本来就公开）；要验的是「词表里的 alt 字段不出服务端」。
  // 裁判/开发者本来就能看全部题面（含别名），所以这里查无凭证的公开快照。
  const aPublic = await api(`/api/rooms/${ac}`);
  check(!JSON.stringify(aPublic.json).includes('"alt"'), '公开快照里没有别名字段');
  check(aPublic.json?.allCellWords == null, '公开快照不下发题面');

  await api(`/api/rooms/${ac}/act`, { method: 'POST', host: ah, dev: ad, body: { intent: { t: 'close' } } });
}

console.log(`\n结果：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
