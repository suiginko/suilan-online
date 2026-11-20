import { BoardCell, WordEntry } from '../types';
import { COLS, ROWS, hexCenter, hexPoints } from '../hex';
import { layoutCellWord, lineGap } from './wordFit';

const FILL: Record<string, string> = {
  none: '#ffffff',
  RED: '#fbe9e7',
  GREEN: '#e6f4ea',
};
const STROKE: Record<string, string> = {
  none: '#d5cdc0',
  RED: '#c2605a',
  GREEN: '#5c9a76',
};
const INK: Record<string, string> = {
  none: '#1b2330',
  RED: '#8f2b23',
  GREEN: '#1c6444',
};
const SUB: Record<string, string> = {
  none: '#8b95a4',
  RED: '#a8544d',
  GREEN: '#3f7a5c',
};

/** 答案的换行与字号统一交给 wordFit（导出图复用同一套规则） */

interface Props {
  board: BoardCell[];
  currentCellId: string | null;
  canSelect: boolean;
  onSelect: (id: string) => void;
  /** 没有题库时棋盘上盖一层提示 */
  placeholder?: string | null;
  allCellWords?: Record<string, WordEntry> | null;
  showRefereeWords?: boolean;
  refereeMode?: 'edit' | 'swap' | null;
  refereeSelectedCellId?: string | null;
  onRefereeCellClick?: (cellId: string) => void;
}

export function Board({
  board,
  currentCellId,
  canSelect,
  onSelect,
  placeholder,
  allCellWords,
  showRefereeWords,
  refereeMode,
  refereeSelectedCellId,
  onRefereeCellClick,
}: Props) {
  const empty = board.length === 0;

  return (
    <div className="board-wrap">
      <div className="board-stage">
        <svg className="board-svg" viewBox="0 0 665 435" role="img" aria-label="蜂巢棋盘">
          {empty
            ? Array.from({ length: ROWS * COLS }, (_, i) => {
                const row = Math.floor(i / COLS);
                const col = i % COLS;
                const { cx, cy } = hexCenter(row, col);
                return (
                  <polygon
                    key={`ghost-${i}`}
                    points={hexPoints(cx, cy)}
                    fill="#fbf9f5"
                    stroke="#e8e2d8"
                    strokeWidth={1}
                  />
                );
              })
            : board.map((cell) => {
                const { cx, cy } = hexCenter(cell.row, cell.col);
                const isCurrent = cell.id === currentCellId;
                const isSwapSelected = refereeMode === 'swap' && cell.id === refereeSelectedCellId;
                const selectable = canSelect && !cell.owner && !refereeMode;
                const isRefereeInteractive = !!refereeMode;
                const ownerKey = cell.owner ?? 'none';
                // 已占领的词语
                const revealedWord = cell.owner && cell.revealedWord ? cell.revealedWord : null;
                // 裁判透视词语（未翻开时）
                const refereeWord = (!cell.owner && showRefereeWords && allCellWords?.[cell.id]?.word)
                  ? allCellWords[cell.id].word
                  : null;
                const displayWord = revealedWord || refereeWord;
                const fitted = displayWord ? layoutCellWord(displayWord) : null;
                const isRefWord = !revealedWord && !!refereeWord;

                const handleClick = () => {
                  if (refereeMode && onRefereeCellClick) {
                    onRefereeCellClick(cell.id);
                  } else if (selectable) {
                    onSelect(cell.id);
                  }
                };

                let strokeColor = STROKE[ownerKey];
                let strokeW = 1.1;
                if (isSwapSelected) {
                  strokeColor = '#2563eb';
                  strokeW = 3.8;
                } else if (isCurrent) {
                  strokeColor = '#c98a2b';
                  strokeW = 3.5;
                } else if (refereeMode === 'edit') {
                  strokeColor = '#8b5cf6';
                  strokeW = 1.8;
                }

                return (
                  <g
                    key={cell.id}
                    className={[
                      'hex',
                      selectable ? 'hex-selectable' : '',
                      isRefereeInteractive ? 'hex-selectable' : '',
                      isCurrent ? 'hex-current' : '',
                    ].join(' ')}
                    style={{ cursor: (selectable || isRefereeInteractive) ? 'pointer' : 'default' }}
                    onClick={handleClick}
                  >
                    <title>
                      {cell.code}
                      {cell.revealedWord ? ` · 已解：${cell.revealedWord}` : ''}
                      {!cell.revealedWord && allCellWords?.[cell.id]?.word ? ` · 题面：${allCellWords[cell.id].word}` : ''}
                      {allCellWords?.[cell.id]?.hint ? ` (${allCellWords[cell.id].hint})` : ''}
                    </title>
                    <polygon
                      points={hexPoints(cx, cy)}
                      fill={isRefWord ? '#fefce8' : FILL[ownerKey]}
                      stroke={strokeColor}
                      strokeWidth={strokeW}
                      strokeDasharray={isSwapSelected ? '6 3' : undefined}
                    />
                    {fitted ? (
                      <>
                        <text
                          x={cx}
                          y={cy - 18}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize="12.5"
                          fontWeight="500"
                          fill={isRefWord ? '#92400e' : SUB[ownerKey]}
                          style={{ letterSpacing: '0.06em' }}
                        >
                          {cell.code}
                        </text>
                        {fitted.lines.map((line, li) => (
                          <text
                            key={li}
                            x={cx}
                            y={cy + 9 + (li - (fitted.lines.length - 1) / 2) * lineGap(fitted.font)}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fontSize={fitted.font}
                            fontWeight={isRefWord ? '700' : '600'}
                            fill={isRefWord ? '#b45309' : INK[ownerKey]}
                          >
                            {line}
                          </text>
                        ))}
                      </>
                    ) : (
                      <text
                        x={cx}
                        y={cy}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize="21"
                        fontWeight="600"
                        fill={INK[ownerKey]}
                        style={{ letterSpacing: '0.02em' }}
                      >
                        {cell.code}
                      </text>
                    )}
                  </g>
                );
              })}
        </svg>

        {placeholder ? (
          <div className="board-veil">
            <div className="board-veil-card">
              <span className="tiny faint">本局棋盘</span>
              <strong>{placeholder}</strong>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
