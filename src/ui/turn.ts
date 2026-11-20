import { GameState, SeatKey } from '../types';
import { actingSeatOf } from '../engine';

/** 此刻轮到哪个席位行动（规则判定在 engine 里，UI 只做展示） */
export function actingSeat(state: GameState): SeatKey | null {
  return actingSeatOf(state);
}
