import { CellRecord, GameState, teamName } from '../types';
import { HistoryEvent, eventsOf } from '../records';

/**
 * 对局历史：整局每个格子的描述与作答，一行一格。
 *
 *   红方描述（红框） → 红方猜词（红字） → 绿方描述（绿框） → 绿方猜词（绿字） → 答案 ✓
 * 超时/跳过也用本阵营的颜色标记，答对的那一条以「答案 ✓」收尾。
 *
 * 事件的展开与排序在 `records.ts`，导出图共用同一套（含抢答插队的时间排序）。
 */

function EventChip({ ev }: { ev: HistoryEvent }) {
  const title = ev.who ? `${teamName(ev.team ?? 'RED')} ${ev.who}` : undefined;
  if (ev.kind === 'desc') {
    return (
      <span className={`ev-desc ${ev.team === 'RED' ? 'is-red' : 'is-green'}`} title={title}>
        {ev.text}
      </span>
    );
  }
  if (ev.kind === 'guess') {
    return (
      <span className={`ev-guess ${ev.team === 'RED' ? 'is-red' : 'is-green'}`} title={title}>
        {ev.text}
      </span>
    );
  }
  if (ev.kind === 'answer') {
    return <span className={`ev-answer ${ev.team === 'RED' ? 'is-red' : 'is-green'}`}>{ev.text}</span>;
  }
  return (
    <span className={`ev-note ${ev.team === 'RED' ? 'is-red' : 'is-green'}`} title={title}>
      {ev.text}
    </span>
  );
}

export function RecordLegend() {
  return (
    <div className="rec-legend">
      <span className="ev-desc is-red">红方描述</span>
      <span className="ev-guess is-red">红方猜词</span>
      <span className="ev-desc is-green">绿方描述</span>
      <span className="ev-guess is-green">绿方猜词</span>
      <span className="ev-answer is-red">答对猜中 ✓</span>
    </div>
  );
}

export function Records({ state }: { state: GameState }) {
  const rows = [...(state.history ?? [])].reverse();
  const liveId = state.currentCellId;

  return (
    <div className="card stack rec-card">
      <div className="row-between">
        <h2 style={{ fontSize: 14 }}>对局历史</h2>
        <span className="tiny faint">{rows.length} / 25 格</span>
      </div>
      <RecordLegend />

      {rows.length === 0 ? (
        <p className="small faint">还没有记录</p>
      ) : (
        <div className="rec-scroll">
          <div className="rec-table">
            <div className="rec-head">
              <span>格子</span>
              <span>过程记录</span>
            </div>
            {rows.map((record) => {
              const events = eventsOf(record);
              const live = record.cellId === liveId && !record.owner;
              return (
                <div key={record.cellId} className={`rec-row ${live ? 'is-live' : ''}`}>
                  <div className="rec-cell">
                    <span className="cell-code">{record.code}</span>
                    {record.owner ? (
                      <span className={`owner-dot ${record.owner === 'RED' ? 'is-red' : 'is-green'}`} />
                    ) : null}
                    {live ? <span className="tiny faint">进行中</span> : null}
                  </div>
                  <div className="rec-flow">
                    {events.length ? (
                      events.map((ev, i) => <EventChip key={`${record.cellId}-${i}`} ev={ev} />)
                    ) : (
                      <span className="ev-note">等待描述</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
