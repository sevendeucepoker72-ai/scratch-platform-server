// Poker evaluator — copied from functions/src/poker.ts
// Removed Firebase type imports, self-contained.

import * as crypto from 'crypto';

export type PokerHandRank =
  | 'Royal Flush' | 'Straight Flush' | 'Four of a Kind' | 'Full House'
  | 'Flush' | 'Straight' | 'Three of a Kind' | 'Two Pair' | 'One Pair' | 'High Card';

type Rank = '2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'10'|'J'|'Q'|'K'|'A';
type SuitCode = 'S'|'H'|'D'|'C';

interface Card {
  id: string;
  rank: Rank;
  suitCode: SuitCode;
  rankValue: number;
}

export interface PrizeSnapshot {
  handRank: string;
  handValue: number;
  prizeLabel: string;
  prizeAmount: number;
  bestCards: string[];
}

const RANK_ORDER: Rank[] = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const HAND_VALUES: Record<PokerHandRank, number> = {
  'Royal Flush': 10, 'Straight Flush': 9, 'Four of a Kind': 8,
  'Full House': 7, 'Flush': 6, 'Straight': 5,
  'Three of a Kind': 4, 'Two Pair': 3, 'One Pair': 2, 'High Card': 1,
};

export function buildShuffledDeck(): string[] {
  const suits: SuitCode[] = ['S','H','D','C'];
  const deck: string[] = [];
  for (const s of suits) {
    for (const r of RANK_ORDER) { deck.push(`${r}${s}`); }
  }
  // CSPRNG Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function parseCard(id: string): Card {
  const suitCode = id.slice(-1) as SuitCode;
  const rank = id.slice(0, -1) as Rank;
  return { id, rank, suitCode, rankValue: RANK_ORDER.indexOf(rank) + 2 };
}

function getCombinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [
    ...getCombinations(rest, k - 1).map(c => [first, ...c]),
    ...getCombinations(rest, k),
  ];
}

function isFlush(cards: Card[]): boolean {
  return cards.every(c => c.suitCode === cards[0].suitCode);
}

function isStraight(sorted: Card[]): boolean {
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].rankValue !== sorted[i-1].rankValue + 1) return false;
  }
  return true;
}

function isWheel(sorted: Card[]): boolean {
  const vals = sorted.map(c => c.rankValue);
  return vals.includes(14) && vals.includes(2) && vals.includes(3) && vals.includes(4) && vals.includes(5);
}

function evaluate5(cards: Card[]) {
  const sorted = [...cards].sort((a, b) => b.rankValue - a.rankValue);
  const groups = new Map<number, Card[]>();
  for (const c of cards) {
    if (!groups.has(c.rankValue)) groups.set(c.rankValue, []);
    groups.get(c.rankValue)!.push(c);
  }
  const sizes = [...groups.values()].map(g => g.length).sort((a,b) => b-a);
  const flush = isFlush(cards);
  const straight = isStraight(sorted) || isWheel(sorted);
  const best = sorted.map(c => c.id);

  const make = (hr: PokerHandRank, desc: string) => ({
    handRank: hr, handValue: HAND_VALUES[hr], bestCards: best, description: desc,
  });

  if (flush && straight && sorted[0].rankValue === 14 && sorted[4].rankValue === 10)
    return make('Royal Flush', 'Royal flush!');
  if (flush && straight) return make('Straight Flush', `${sorted[0].rank}-high straight flush`);
  if (sizes[0] === 4) {
    const quad = [...groups.values()].find(g => g.length === 4)!;
    return make('Four of a Kind', `Four ${quad[0].rank}s`);
  }
  if (sizes[0] === 3 && sizes[1] === 2) {
    const trip = [...groups.values()].find(g => g.length === 3)!;
    const pair = [...groups.values()].find(g => g.length === 2)!;
    return make('Full House', `${trip[0].rank}s full of ${pair[0].rank}s`);
  }
  if (flush) return make('Flush', `${sorted[0].rank}-high flush`);
  if (straight) return make('Straight', `${sorted[0].rank}-high straight`);
  if (sizes[0] === 3) {
    const trip = [...groups.values()].find(g => g.length === 3)!;
    return make('Three of a Kind', `Three ${trip[0].rank}s`);
  }
  if (sizes[0] === 2 && sizes[1] === 2) {
    const pairs = [...groups.values()].filter(g => g.length === 2).sort((a,b) => b[0].rankValue - a[0].rankValue);
    return make('Two Pair', `${pairs[0][0].rank}s and ${pairs[1][0].rank}s`);
  }
  if (sizes[0] === 2) {
    const pair = [...groups.values()].find(g => g.length === 2)!;
    return make('One Pair', `Pair of ${pair[0].rank}s`);
  }
  return make('High Card', `${sorted[0].rank} high`);
}

export interface HandResult {
  handRank: PokerHandRank;
  handValue: number;
  bestCards: string[];
  description: string;
}

function cardRankValues(bestCards: string[]): number[] {
  return bestCards.map(id => {
    const rank = id.slice(0, -1);
    return RANK_ORDER.indexOf(rank) + 2;
  }).sort((a, b) => b - a);
}

function isBetterHand(a: { handValue: number; bestCards: string[] }, b: { handValue: number; bestCards: string[] }): boolean {
  if (a.handValue !== b.handValue) return a.handValue > b.handValue;
  // Same hand rank — compare card values (kicker comparison)
  const aVals = cardRankValues(a.bestCards);
  const bVals = cardRankValues(b.bestCards);
  for (let i = 0; i < aVals.length; i++) {
    if (aVals[i] !== bVals[i]) return aVals[i] > bVals[i];
  }
  return false;
}

export function evaluateBestHand(cardIds: string[]): HandResult {
  const cards = cardIds.map(parseCard);
  const combos = getCombinations(cards, 5);
  let best: HandResult | null = null;
  for (const combo of combos) {
    const result = evaluate5(combo);
    if (!best || isBetterHand(result, best)) best = result;
  }
  return best!;
}

export function buildPrizeSnapshot(
  handResult: HandResult,
  oddsProfile: { prizes: Array<{ handRank: string; prizeLabel: string; prizeAmount: number; isEnabled: boolean }> }
): PrizeSnapshot {
  const prize = oddsProfile.prizes.find(
    p => p.handRank === handResult.handRank && p.isEnabled
  );
  return {
    handRank: handResult.handRank,
    handValue: handResult.handValue,
    prizeLabel: prize?.prizeLabel ?? 'No prize',
    prizeAmount: prize?.prizeAmount ?? 0,
    bestCards: handResult.bestCards,
  };
}
