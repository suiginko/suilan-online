import { isAnswerMatch } from '../src/words';

/**
 * 判词：一个答案可以有好几种写法（词表里的 `言不二价/言无二价`）。
 *
 * 这些断言盯的是「同一个答案被写成两种，玩家猜了另一种却判错」的问题——
 * 别名只影响判对，不影响棋盘代号、结算文案与对局历史（那里永远只有展示词）。
 */

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

console.log('\n判词：基本等价');
check(isAnswerMatch('言不二价', '言不二价'), '完全相同');
check(isAnswerMatch(' 言不二价 ', '言不二价'), '首尾空白不影响');
check(isAnswerMatch('《言不二价》', '言不二价'), '书名号被洗掉');
check(isAnswerMatch('言，不二价', '言不二价'), '中间的标点被洗掉');
check(!isAnswerMatch('言不二价', '言无二价'), '没写进词表的另一种写法仍然判错');
check(!isAnswerMatch('', '言不二价'), '空猜测不判对');
check(!isAnswerMatch('言不二价', ''), '空答案不判对');

console.log('\n判词：别名');
check(isAnswerMatch('言无二价', '言不二价', ['言无二价']), '猜别名判对');
check(isAnswerMatch('言不二价', '言不二价', ['言无二价']), '猜展示词也判对');
check(isAnswerMatch('《言无二价》', '言不二价', ['言无二价']), '别名同样享有标点清洗');
check(isAnswerMatch('重为', '重复', ['重做', '重为']), '多个别名里任意一个都行');
check(!isAnswerMatch('重来', '重复', ['重做', '重为']), '别名之外的写法不判对');
check(!isAnswerMatch('言无二价', '言不二价', []), '没有别名时按老规则判');
check(!isAnswerMatch('言无二价', '言不二价', ['']), '空别名不会把一切都判对');

console.log('\n判词：拼音');
check(isAnswerMatch('yanbuerjia', '言不二价'), '整串拼音猜展示词');
check(isAnswerMatch('yanwuerjia', '言不二价', ['言无二价']), '整串拼音猜别名');

console.log(`\n结果：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
