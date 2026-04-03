// Game engines — copied verbatim from functions/src/gameEngines.ts
// Only change: import path for crypto (already standard Node)

import * as crypto from 'crypto';

export type GameType =
  | 'poker' | 'poker_pick' | 'match3' | 'lucky7' | 'treasure' | 'color_match'
  | 'dice_duel' | 'fruit_slots' | 'number_pick' | 'emoji_trio'
  | 'multiplier' | 'word_builder';

export interface GameResult {
  tierName: string;
  tierValue: number;
  displayItems: string[];
  description: string;
}

function randInt(max: number): number {
  return crypto.randomInt(max);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── 1. MATCH 3
const MATCH3_SYMBOLS = ['🍒','🍋','🍊','🍇','⭐','💎'];
export function buildMatch3Deck(): string[] {
  const deck: string[] = [];
  MATCH3_SYMBOLS.forEach((_, si) => {
    for (let i = 0; i < 3; i++) deck.push(`m3_${si}_${i}`);
  });
  return shuffle(deck);
}
export function evaluateMatch3(ids: string[]): GameResult {
  const counts = new Map<string, number>();
  ids.forEach(id => { const sym = id.split('_')[1]; counts.set(sym, (counts.get(sym) ?? 0) + 1); });
  const best = Math.max(...counts.values());
  if (best >= 3) return { tierName: 'Triple Match', tierValue: 8, displayItems: ids, description: '3 matching symbols!' };
  if (best >= 2) {
    const pairs = [...counts.values()].filter(v => v >= 2).length;
    if (pairs >= 2) return { tierName: 'Double Pair', tierValue: 4, displayItems: ids, description: 'Two matching pairs' };
    return { tierName: 'Single Pair', tierValue: 2, displayItems: ids, description: 'One matching pair' };
  }
  return { tierName: 'No Match', tierValue: 1, displayItems: ids, description: 'No matching symbols' };
}

// ── 2. LUCKY 7
export function buildLucky7Deck(): string[] {
  const deck: string[] = [];
  for (let n = 1; n <= 9; n++) deck.push(`l7_${n}_a`, `l7_${n}_b`);
  return shuffle(deck);
}
export function evaluateLucky7(ids: string[]): GameResult {
  const nums = ids.map(id => parseInt(id.split('_')[1], 10));
  const sum = nums.reduce((a, b) => a + b, 0);
  const has7 = nums.includes(7);
  const allSame = nums.every(n => n === nums[0]);
  const triple7 = nums.every(n => n === 7);
  if (triple7)   return { tierName: 'Triple 7', tierValue: 10, displayItems: ids, description: '7-7-7 jackpot!' };
  if (allSame)   return { tierName: 'Triple Match', tierValue: 7, displayItems: ids, description: `Three ${nums[0]}s` };
  if (sum === 7) return { tierName: 'Lucky Sum', tierValue: 5, displayItems: ids, description: 'Sum of 7!' };
  if (has7)      return { tierName: 'Lucky 7', tierValue: 3, displayItems: ids, description: 'A 7 revealed' };
  if (sum === 21) return { tierName: 'Lucky 21', tierValue: 4, displayItems: ids, description: 'Sum of 21!' };
  return { tierName: 'No Lucky Number', tierValue: 1, displayItems: ids, description: `Sum: ${sum}` };
}

// ── 3. TREASURE HUNT
const TREASURE_ITEMS = ['chest','coin','coin','gem','gem','blank','blank','blank','blank'];
export function buildTreasureDeck(): string[] {
  return shuffle(TREASURE_ITEMS.map((item, i) => `tr_${item}_${i}`));
}
export function evaluateTreasure(ids: string[]): GameResult {
  const items = ids.map(id => id.split('_')[1]);
  const chestPos = items.indexOf('chest');
  const coinCount = items.filter(i => i === 'coin').length;
  const gemCount  = items.filter(i => i === 'gem').length;
  if (chestPos === 4) return { tierName: 'Center Chest', tierValue: 10, displayItems: ids, description: 'Chest in the center!' };
  if (chestPos >= 0)  return { tierName: 'Hidden Chest', tierValue: 6, displayItems: ids, description: 'You found the chest!' };
  if (gemCount >= 2)  return { tierName: 'Gem Find', tierValue: 3, displayItems: ids, description: 'Two gems found' };
  if (coinCount >= 2) return { tierName: 'Coin Find', tierValue: 2, displayItems: ids, description: 'Two coins found' };
  return { tierName: 'Empty Vault', tierValue: 1, displayItems: ids, description: 'Nothing found' };
}

// ── 4. COLOR MATCH
const COLORS = ['red','blue','green','gold','purple'];
export function buildColorMatchDeck(): string[] {
  const deck: string[] = [];
  COLORS.forEach((_, ci) => { for (let i = 0; i < 4; i++) deck.push(`cm_${ci}_${i}`); });
  return shuffle(deck);
}
export function evaluateColorMatch(ids: string[]): GameResult {
  const counts = new Map<string, number>();
  ids.forEach(id => { const col = id.split('_')[1]; counts.set(col, (counts.get(col) ?? 0) + 1); });
  const best = Math.max(...counts.values());
  if (best >= 5) return { tierName: 'Full Spectrum', tierValue: 10, displayItems: ids, description: 'All 5 same color!' };
  if (best >= 4) return { tierName: 'Rainbow Run', tierValue: 7, displayItems: ids, description: '4 of the same color' };
  if (best >= 3) return { tierName: 'Color Trio', tierValue: 4, displayItems: ids, description: '3 matching colors' };
  if (best >= 2) return { tierName: 'Color Pair', tierValue: 2, displayItems: ids, description: '2 matching colors' };
  return { tierName: 'No Match', tierValue: 1, displayItems: ids, description: 'All different colors' };
}

// ── 5. DICE DUEL
export function buildDiceDeck(): string[] {
  const deck: string[] = [];
  for (let face = 1; face <= 6; face++) { for (let i = 0; i < 3; i++) deck.push(`dd_${face}_${i}`); }
  return shuffle(deck);
}
export function evaluateDice(ids: string[]): GameResult {
  const faces = ids.map(id => parseInt(id.split('_')[1], 10));
  const sum = faces.reduce((a, b) => a + b, 0);
  const allSame = faces.every(f => f === faces[0]);
  const allSix = faces.every(f => f === 6);
  if (allSix)    return { tierName: 'Max Roll', tierValue: 10, displayItems: ids, description: 'Three sixes!' };
  if (allSame)   return { tierName: 'Triple Roll', tierValue: 7, displayItems: ids, description: `Three ${faces[0]}s` };
  if (sum >= 15) return { tierName: 'High Roll', tierValue: 5, displayItems: ids, description: `Sum ${sum} — high roll` };
  if (sum >= 12) return { tierName: 'Good Roll', tierValue: 3, displayItems: ids, description: `Sum ${sum}` };
  if (sum <= 4)  return { tierName: 'Lucky Low', tierValue: 2, displayItems: ids, description: `Snake eyes! Sum ${sum}` };
  return { tierName: 'No Win', tierValue: 1, displayItems: ids, description: `Sum ${sum} — try again` };
}

// ── 6. FRUIT SLOTS
const FRUITS = ['🍒','🍋','🍊','🍇','🔔','💰','7️⃣'];
export function buildFruitDeck(): string[] {
  const deck: string[] = [];
  for (let reel = 0; reel < 3; reel++) {
    shuffle(FRUITS).forEach((_, fi) => deck.push(`fs_${reel}_${fi}`));
  }
  return deck;
}
export function evaluateFruit(ids: string[]): GameResult {
  const fruits = ids.map(id => { const fi = parseInt(id.split('_')[2], 10); return FRUITS[fi] ?? '?'; });
  const allSame = fruits.every(f => f === fruits[0]);
  const twoSame = fruits[0] === fruits[1] || fruits[1] === fruits[2] || fruits[0] === fruits[2];
  const hasSeven = fruits.includes('7️⃣');
  const hasMoney = fruits.includes('💰');
  if (allSame && hasSeven) return { tierName: 'Triple 7', tierValue: 10, displayItems: ids, description: '7-7-7 JACKPOT!' };
  if (allSame && hasMoney) return { tierName: 'Triple Money', tierValue: 8, displayItems: ids, description: 'Triple cash bags!' };
  if (allSame)             return { tierName: 'Triple Match', tierValue: 6, displayItems: ids, description: `${fruits[0]} triple!` };
  if (twoSame && hasSeven) return { tierName: 'Lucky 7 Pair', tierValue: 4, displayItems: ids, description: '7 + a matching pair' };
  if (twoSame)             return { tierName: 'Fruit Pair', tierValue: 2, displayItems: ids, description: 'Two matching fruits' };
  return { tierName: 'No Match', tierValue: 1, displayItems: ids, description: 'No matching fruits' };
}

// ── 7. NUMBER PICK
export function buildNumberPickDeck(): string[] {
  const playerPool = shuffle(Array.from({length:25}, (_,i) => `np_p_${i+1}`));
  const winPool    = shuffle(Array.from({length:30}, (_,i) => `np_w_${i+1}`)).slice(0,5);
  return [...playerPool, ...winPool];
}
export function evaluateNumberPick(ids: string[]): GameResult {
  const playerPicks = ids.slice(0, 5).map(id => id.split('_')[2]);
  const winningNums = ids.slice(5).map(id => id.split('_')[2]);
  const matches = playerPicks.filter(p => winningNums.includes(p)).length;
  if (matches === 5) return { tierName: '5 Matches', tierValue: 10, displayItems: ids.slice(0,5), description: 'All 5 numbers match!' };
  if (matches === 4) return { tierName: '4 Matches', tierValue: 7, displayItems: ids.slice(0,5), description: '4 numbers match' };
  if (matches === 3) return { tierName: '3 Matches', tierValue: 5, displayItems: ids.slice(0,5), description: '3 numbers match' };
  if (matches === 2) return { tierName: '2 Matches', tierValue: 3, displayItems: ids.slice(0,5), description: '2 numbers match' };
  if (matches === 1) return { tierName: '1 Match',   tierValue: 2, displayItems: ids.slice(0,5), description: '1 number matches' };
  return { tierName: 'No Match', tierValue: 1, displayItems: ids.slice(0,5), description: 'No matches this time' };
}

// ── 8. EMOJI TRIO
const EMOJI_SET = ['🌟','🎯','🎪','🌈','🦄'];
export function buildEmojiTrioDeck(): string[] {
  const cells: string[] = [];
  for (let i = 0; i < 9; i++) cells.push(`et_${i}_${randInt(EMOJI_SET.length)}`);
  return cells;
}
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
export function evaluateEmojiTrio(ids: string[]): GameResult {
  const emojiIdx = ids.map(id => id.split('_')[2]);
  let bestLine = 0;
  for (const line of LINES) {
    const vals = line.map(i => emojiIdx[i]);
    if (vals.every(v => v === vals[0])) {
      const isDiag = (line[0] === 0 && line[2] === 8) || (line[0] === 2 && line[2] === 6);
      if (isDiag) return { tierName: 'Diagonal Line', tierValue: 9, displayItems: ids, description: `Diagonal ${EMOJI_SET[parseInt(vals[0], 10)] ?? '?'}!` };
      bestLine = Math.max(bestLine, 6);
    }
  }
  if (bestLine >= 6) return { tierName: 'Line Match', tierValue: 6, displayItems: ids, description: 'A full line of matching emojis!' };
  const counts = new Map<string,number>();
  emojiIdx.forEach(v => counts.set(v, (counts.get(v)??0)+1));
  const best = Math.max(...counts.values());
  if (best >= 4) return { tierName: 'Near Miss', tierValue: 3, displayItems: ids, description: '4 matching emojis' };
  if (best >= 3) return { tierName: 'Trio', tierValue: 2, displayItems: ids, description: '3 matching emojis' };
  return { tierName: 'No Line', tierValue: 1, displayItems: ids, description: 'No matching lines' };
}

// ── 9. MULTIPLIER
const MULTIPLIERS = [{val:1,weight:30},{val:2,weight:25},{val:3,weight:18},{val:5,weight:12},{val:10,weight:8},{val:25,weight:4},{val:50,weight:2},{val:100,weight:1}];
export function buildMultiplierDeck(): string[] {
  const deck: string[] = [];
  MULTIPLIERS.forEach(({val, weight}) => { for (let i = 0; i < weight; i++) deck.push(`mx_${val}_${i}`); });
  return shuffle(deck);
}
export function evaluateMultiplier(ids: string[]): GameResult {
  const val = parseInt(ids[0].split('_')[1], 10);
  if (val >= 100) return { tierName: '100× Multiplier', tierValue: 10, displayItems: ids, description: '100× jackpot multiplier!' };
  if (val >= 50) return { tierName: '50× Multiplier', tierValue: 9, displayItems: ids, description: '50× your prize!' };
  if (val >= 25) return { tierName: '25× Multiplier', tierValue: 8, displayItems: ids, description: '25× your prize!' };
  if (val >= 10) return { tierName: '10× Multiplier', tierValue: 7, displayItems: ids, description: '10× your prize!' };
  if (val >= 5)  return { tierName: '5× Multiplier', tierValue: 5, displayItems: ids, description: '5× your prize!' };
  if (val >= 3)  return { tierName: '3× Multiplier', tierValue: 4, displayItems: ids, description: '3× your prize!' };
  if (val >= 2)  return { tierName: '2× Multiplier', tierValue: 3, displayItems: ids, description: '2× your prize!' };
  return { tierName: '1× (Base Prize)', tierValue: 2, displayItems: ids, description: 'Base prize amount' };
}

// ── 10. WORD BUILDER
const LETTER_POOL = 'AAABBBCDDEEEEFFFGGGHHIIIJKLLLLMMNNNOOOOPPPQRRRSSSSTTTTUUUVVWWXYYZ'.split('');
export function buildWordDeck(): string[] {
  const pool = shuffle(LETTER_POOL);
  return pool.slice(0, 18).map((letter, i) => `wb_${letter}_${i}`);
}
const LETTER_VALUES: Record<string, number> = {
  A:1,E:1,I:1,O:1,U:1,N:1,R:1,S:1,T:1,L:1,D:2,G:2,B:3,C:3,M:3,P:3,F:4,H:4,V:4,W:4,Y:4,K:5,J:8,X:8,Q:10,Z:10,
};
export function evaluateWordBuilder(ids: string[]): GameResult {
  const letters = ids.map(id => id.split('_')[1]);
  const score = letters.reduce((sum, l) => sum + (LETTER_VALUES[l] ?? 1), 0);
  const uniqueLetters = new Set(letters).size;
  if (score >= 24 && uniqueLetters >= 5) return { tierName: 'Master Word', tierValue: 10, displayItems: ids, description: 'Exceptional letter set!' };
  if (score >= 18 && uniqueLetters >= 4) return { tierName: 'Expert Word', tierValue: 7, displayItems: ids, description: 'Great letter combination' };
  if (score >= 13) return { tierName: 'Good Word', tierValue: 5, displayItems: ids, description: 'Solid letter set' };
  if (score >= 10) return { tierName: 'Decent Word', tierValue: 3, displayItems: ids, description: 'Useful letters' };
  if (score >= 7)  return { tierName: 'Simple Word', tierValue: 2, displayItems: ids, description: 'Common letters' };
  return { tierName: 'Low Value', tierValue: 1, displayItems: ids, description: 'Tough letter draw' };
}

// ── REGISTRY
export interface GameEngine {
  buildDeck: () => string[];
  evaluate: (ids: string[]) => GameResult;
  scratchLimit: number;
  displayName: string;
  description: string;
  icon: string;
}

export const GAME_ENGINES: Record<GameType, GameEngine> = {
  poker:        { buildDeck: () => { throw new Error('poker uses buildShuffledDeck'); }, evaluate: () => { throw new Error('use evaluateBestHand'); }, scratchLimit: 7, displayName: 'Poker Hands', description: 'Reveal 7 cards, best 5-card poker hand wins', icon: '🃏' },
  poker_pick:   { buildDeck: () => { throw new Error('poker_pick uses buildShuffledDeck'); }, evaluate: () => { throw new Error('use evaluateBestHand'); }, scratchLimit: 7, displayName: 'Pick Your Hand', description: 'Pick 7 from 52 face-down cards, best 5-card hand wins', icon: '🎴' },
  match3:       { buildDeck: buildMatch3Deck, evaluate: evaluateMatch3, scratchLimit: 6, displayName: 'Match 3', description: 'Reveal 6 symbols, match 3 to win', icon: '🍒' },
  lucky7:       { buildDeck: buildLucky7Deck, evaluate: evaluateLucky7, scratchLimit: 3, displayName: 'Lucky 7', description: 'Reveal 3 numbers, sum to 7 wins big', icon: '7️⃣' },
  treasure:     { buildDeck: buildTreasureDeck, evaluate: evaluateTreasure, scratchLimit: 9, displayName: 'Treasure Hunt', description: 'Uncover all 9 cells to find the chest', icon: '🏴‍☠️' },
  color_match:  { buildDeck: buildColorMatchDeck, evaluate: evaluateColorMatch, scratchLimit: 5, displayName: 'Color Match', description: 'Reveal 5 gems, match colors to win', icon: '💎' },
  dice_duel:    { buildDeck: buildDiceDeck, evaluate: evaluateDice, scratchLimit: 3, displayName: 'Dice Duel', description: 'Roll 3 dice, high score or triples win', icon: '🎲' },
  fruit_slots:  { buildDeck: buildFruitDeck, evaluate: evaluateFruit, scratchLimit: 3, displayName: 'Fruit Slots', description: 'Spin 3 reels, match fruits to win', icon: '🍋' },
  number_pick:  { buildDeck: buildNumberPickDeck, evaluate: evaluateNumberPick, scratchLimit: 5, displayName: 'Number Pick', description: 'Pick 5 numbers, match the drawn numbers', icon: '🔢' },
  emoji_trio:   { buildDeck: buildEmojiTrioDeck, evaluate: evaluateEmojiTrio, scratchLimit: 9, displayName: 'Emoji Trio', description: 'Scratch 3×3 grid, complete a line to win', icon: '🌟' },
  multiplier:   { buildDeck: buildMultiplierDeck, evaluate: evaluateMultiplier, scratchLimit: 1, displayName: 'Multiplier', description: 'Reveal your prize multiplier', icon: '✖️' },
  word_builder: { buildDeck: buildWordDeck, evaluate: evaluateWordBuilder, scratchLimit: 6, displayName: 'Word Builder', description: 'Reveal 6 letters, score by letter value', icon: '🔤' },
};

export interface GenericOddsProfile {
  prizes: Array<{ tierName: string; prizeLabel: string; prizeAmount: number; isEnabled: boolean }>;
}

export function buildGamePrizeSnapshot(result: GameResult, odds: GenericOddsProfile) {
  const prize = odds.prizes.find(p => p.tierName === result.tierName && p.isEnabled);
  return {
    handRank: result.tierName,
    handValue: result.tierValue,
    prizeLabel: prize?.prizeLabel ?? 'No prize',
    prizeAmount: prize?.prizeAmount ?? 0,
    bestCards: result.displayItems,
  };
}
