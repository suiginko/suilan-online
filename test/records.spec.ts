import { AttemptLog, CellRecord } from '../src/types';
import { eventsOf } from '../src/records';

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

const record = (attempts: AttemptLog[], word: string | null = '答案'): CellRecord => ({
  cellId: 'c1',
  code: 'A1a',
  owner: word ? 'RED' : null,
  word,
  attempts,
});

const brief = (r: CellRecord) => eventsOf(r).map((e) => `${e.team}:${e.kind}:${e.text}`);

console.log('== 抢答插入后的时间排序 ==');

{
  // 红描述(100) → 绿抢答未命中(200) → 红猜中(300)
  // 存储顺序是「红一条、绿一条」，时间顺序却被抢答隔开
  const r = record([
    { team: 'RED', describer: '红描', description: '甲乙', guesser: '红猜', guess: '答案', outcome: 'correct', descAt: 100, guessAt: 300 },
    { team: 'GREEN', describer: '绿描', description: null, guesser: '绿猜', guess: '不是它', outcome: 'wrong', stolen: true, guessAt: 200 },
  ]);
  check(
    brief(r).join(' | ') ===
      'RED:desc:甲乙 | GREEN:guess:不是它 | RED:answer:答案 ✓',
    '抢答记录排在「描述之后、答案之前」'
  );
}

{
  // 抢答直接命中：绿方只有一条猜中记录
  const r = record([
    { team: 'RED', describer: '红描', description: '甲乙', guesser: '红猜', guess: null, outcome: null, descAt: 100 },
    { team: 'GREEN', describer: '绿描', description: null, guesser: '绿猜', guess: '答案', outcome: 'correct', stolen: true, guessAt: 200 },
  ]);
  check(brief(r).join(' | ') === 'RED:desc:甲乙 | GREEN:answer:答案 ✓', '抢答命中不把答案提前');
}

console.log('\n== 超时 / 放弃 ==');

{
  const r = record([
    { team: 'RED', describer: '红描', description: null, guesser: '红猜', guess: null, outcome: 'passed', descPass: 'timeout', descAt: 100 },
    { team: 'RED', describer: '红描', description: null, guesser: '红猜', guess: null, outcome: 'passed', guessPass: 'skip', guessAt: 200 },
  ]);
  check(brief(r).join(' | ') === 'RED:note:描述超时 | RED:note:（放弃）', '描述超时与（放弃）文案正确');
}

{
  // 抢答方超时没作答：也应落在对方作答之前
  const r = record([
    { team: 'RED', describer: '红描', description: '甲乙', guesser: '红猜', guess: '答案', outcome: 'correct', descAt: 100, guessAt: 400 },
    { team: 'GREEN', describer: '绿描', description: null, guesser: '绿猜', guess: null, outcome: 'passed', guessPass: 'timeout', guessAt: 300 },
  ]);
  check(brief(r).join(' | ') === 'RED:desc:甲乙 | GREEN:note:（超时） | RED:answer:答案 ✓', '抢答超时排在答案之前');
}

console.log('\n== 老房间（没有时间戳） ==');

{
  // 云库里已存在的房间没有 descAt/guessAt：必须保持原来的存储顺序，不能乱序
  const r = record([
    { team: 'RED', describer: '红描', description: '甲乙', guesser: '红猜', guess: '错', outcome: 'wrong' },
    { team: 'GREEN', describer: '绿描', description: '丙丁', guesser: '绿猜', guess: '答案', outcome: 'correct' },
  ]);
  check(
    brief(r).join(' | ') === 'RED:desc:甲乙 | RED:guess:错 | GREEN:desc:丙丁 | GREEN:answer:答案 ✓',
    '无时间戳时保持原顺序'
  );
}

{
  // 一半新一半老（房间中途升级）：有时间的按时间，没时间的接在后面，不能插到最前
  const r = record([
    { team: 'RED', describer: '红描', description: '甲乙', guesser: '红猜', guess: '错', outcome: 'wrong' },
    { team: 'GREEN', describer: '绿描', description: '丙丁', guesser: '绿猜', guess: '答案', outcome: 'correct', descAt: 100, guessAt: 200 },
  ]);
  const order = brief(r).join(' | ');
  check(
    order === 'RED:desc:甲乙 | RED:guess:错 | GREEN:desc:丙丁 | GREEN:answer:答案 ✓',
    '混合数据不会把老记录甩到最前'
  );
}

console.log(`\n结果：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
