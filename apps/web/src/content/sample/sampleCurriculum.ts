import type { LessonCatalog } from "../../learning/catalog.ts";
import type { Lesson, LessonMeta, QuizQuestion } from "../../learning/types.ts";

/**
 * The sample lessons: a short quiz lesson, a simulation lesson that uses the block-chain lab from
 * `learning/visualizers/basics.ts`, and a small gate quiz over both. The facts follow the ZecHub wiki
 * (https://github.com/ZecHub/zechub-wiki); the lesson text derived from it is under CC BY-SA 4.0, separate from the
 * code licence, and each lesson credits it as its source.
 */

const ZECHUB_WIKI = { name: "ZecHub wiki", url: "https://github.com/ZecHub/zechub-wiki", license: "CC BY-SA 4.0" } as const;

const meta = (difficulty: LessonMeta["difficulty"]): LessonMeta => ({
  difficulty,
  source: ZECHUB_WIKI,
  version: "sample · 2026-10",
  lastChecked: "2026-10-10",
  requiresWallet: false,
  requiresTestnet: false,
  usesRealFunds: false,
});

const q = (question: string, options: readonly string[], answer: number, explain: string): QuizQuestion => ({ question, options, answer, explain });

const LESSONS: readonly Lesson[] = [
  {
    id: "zcash-in-brief",
    title: "Zcash in Brief",
    tier: "beginner",
    zone: "first-steps",
    summary: "The coin, the network and the choice between public and private payments.",
    learn: [
      "Zcash is an open-source cryptocurrency that has been running since 2016. Its coin is ZEC, and like Bitcoin its supply is capped at 21 million coins.",
      "Anyone can run a node that checks every block against the rules, so no bank or company has to approve a payment.",
      "Zcash lets you choose how public a payment is. Transparent addresses show everything on the chain, as Bitcoin does. Shielded addresses encrypt the sender, the receiver and the amount, and the network still verifies the payment with a zero-knowledge proof.",
    ],
    see: "zec-facts",
    prove: {
      kind: "quiz",
      questions: [
        q("What is the most ZEC that will ever exist?", ["1 billion", "21 million", "There is no limit"], 1, "The supply is capped at 21 million ZEC."),
        q("Who can check that Zcash blocks follow the rules?", ["Only one company", "Only banks", "Anyone who runs a node"], 2, "Running a node and verifying blocks is open to everyone."),
        q("What does a shielded payment hide on the chain?", ["The sender, the receiver and the amount", "Nothing at all", "Only the fee"], 0, "Those are encrypted; the fee stays public."),
        q("How public is a payment between transparent addresses?", ["Fully encrypted", "As public as a Bitcoin payment", "Visible only to miners"], 1, "Transparent payments are visible to everyone, like Bitcoin."),
      ],
      draw: 3,
    },
    verification: "knowledge",
    requires: [],
    wiki: "what-is-zec",
    meta: meta(1),
  },
  {
    id: "chain-of-blocks",
    title: "A Chain of Blocks",
    tier: "beginner",
    zone: "first-steps",
    summary: "Rewrite an old block and watch every later link break.",
    learn: [
      "A blockchain is a list of blocks. Each block stores the hash, a short fingerprint, of the block before it, so every block is linked to all the blocks that came earlier.",
      "Changing anything in an old block changes its hash and breaks the link to every block after it. To hide the change, every later block would have to be mined again, faster than the rest of the network keeps adding new ones.",
      "In the lab, edit an old transaction, then re-mine the broken blocks in order.",
    ],
    try: "block-chain",
    prove: { kind: "simulation" },
    verification: "simulation",
    requires: [],
    wiki: "transactions",
    meta: meta(1),
  },
  {
    id: "first-steps-quiz",
    title: "First Steps Quiz",
    tier: "quiz",
    zone: "first-steps",
    summary: "Answer 3 of 4 to pass.",
    learn: ["Four questions drawn from both lessons. Answer three correctly to pass. A failed attempt has a short cooldown, and each attempt draws a different set."],
    prove: {
      kind: "quiz",
      draw: 4,
      pass: 3,
      questions: [
        q("What links each block to the one before it?", ["Its timestamp", "The previous block's hash", "The miner's name"], 1, "Each block stores the hash of its parent."),
        q("What happens to later blocks when an old block is edited?", ["Nothing", "Their links break", "They are deleted"], 1, "The edited block gets a new hash, so every later link points at a hash that no longer exists."),
        q("What is ZEC?", ["The coin of the Zcash network", "A wallet app", "A mining company"], 0, "ZEC is the currency; Zcash is the network."),
        q("Which kind of address encrypts the payment details?", ["Transparent", "Shielded", "Both"], 1, "Shielded addresses encrypt the sender, the receiver and the amount."),
        q("Why does each new block make an old payment harder to reverse?", ["Every later block would have to be mined again", "Old blocks are locked by a password", "Payments expire"], 0, "Rewriting history means redoing the work for every block on top."),
      ],
    },
    verification: "knowledge",
    requires: ["zcash-in-brief", "chain-of-blocks"],
    meta: meta(1),
  },
];

export const SAMPLE_CURRICULUM: LessonCatalog = {
  lessons: LESSONS,
  tierLabels: { beginner: "Beginner", quiz: "Quizzes" },
  zoneLabels: { "first-steps": "First Steps" },
  upcoming: [],
  gates: { "first-steps": "first-steps-quiz" },
  directoryIntro: "Three sample lessons that show the lesson format. In a location with lesson stations, walk to a station and press E to start its lesson.",
};
