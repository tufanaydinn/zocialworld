/**
 * The seed-phrase backup check of a new mainnet wallet (ADR-018 § 1: "a mandatory backup step (real
 * money)"): after the 24 words, the player picks the right word for three random positions from four choices each.
 * Until it passes, the wallet sends nothing and shows no address (ZcashWalletAdapter's `backupPending`).
 *
 * Pure: no DOM. The random source is injectable for tests; the decoys come from the phrase itself (no word list
 * needed), so the options never reveal anything that is not already on screen.
 */

export interface QuizQuestion {
  /** 0-based position in the phrase. */
  readonly index: number;
  /** Four distinct words, one of them right, in random order. */
  readonly options: readonly string[];
}

export function buildBackupQuiz(words: readonly string[], random: () => number = Math.random, questions = 3): QuizQuestion[] {
  const distinct = [...new Set(words)];
  const positions = [...words.keys()];
  shuffle(positions, random);
  const chosen = positions.slice(0, Math.min(questions, positions.length)).sort((a, b) => a - b);
  return chosen.map((index) => {
    const answer = words[index]!;
    const decoys = distinct.filter((word) => word !== answer);
    shuffle(decoys, random);
    const options = [answer, ...decoys.slice(0, 3)];
    shuffle(options, random);
    return { index, options };
  });
}

/** Whether every answer (word per question, same order) is right. */
export function checkBackupQuiz(words: readonly string[], quiz: readonly QuizQuestion[], answers: readonly (string | null)[]): boolean {
  return quiz.length > 0 && quiz.every((question, i) => answers[i] === words[question.index]);
}

function shuffle<T>(items: T[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}
