import { classifyAddress, conventionalFeeZec } from "../addresses.ts";
import type { VisualizerRegistry } from "../catalog.ts";
import { button, el, feedback, hexBitDistance, sha256Hex, shuffled, type Visualizer } from "./common.ts";

/** SEE — the key numbers of Zcash as cards. */
export const zecFacts: Visualizer = ({ host }) => {
  const grid = el("div", "lv-cards");
  const facts: [string, string, string][] = [
    ["21M", "Maximum supply", "Fixed cap of 21,000,000 ZEC."],
    ["~75 s", "Block time", "A new block about every 75 seconds."],
    ["2016", "Launched", "Mainnet since October 2016, from the Zerocash research."],
    ["~4 yrs", "Halving", "The block reward halves roughly every four years."],
    ["t / z / u", "Your choice", "Transparent (public) or shielded (encrypted) — Unified Addresses bundle both."],
    ["0.0001", "Typical fee", "ZIP-317 conventional fee for a simple payment, in ZEC."],
  ];
  for (const [value, label, text] of facts) {
    const card = el("div", "lv-card");
    card.append(el("div", "lv-card-value", value), el("div", "lv-card-label", label), el("div", "lv-card-text", text));
    grid.appendChild(card);
  }
  host.appendChild(grid);
};

/** SEE — the same payment as an observer and as the owner sees it, transparent vs shielded, one layer at a time. */
export const transparentVsShielded: Visualizer = ({ host }) => {
  let owner = false;
  let focus: string | null = null;
  const toggle = el("div", "lv-toggle");
  const observerButton = button("👁 Observer view", () => setView(false), "lv-chip active");
  const ownerButton = button("🔑 Owner view (viewing key)", () => setView(true), "lv-chip");
  toggle.append(observerButton, ownerButton);
  const layers = el("div", "lv-toggle lv-layers");
  const columns = el("div", "lv-columns");
  const explain = el("div", "lv-feedback lv-feedback-info", "Pick a layer to compare it across both payments.");
  host.append(
    el("p", "lv-hint", "The same payment — Alice pays Bob 2.5 ZEC for design work — made two ways. Switch views, then inspect each layer of information."),
    toggle,
    el("div", "lv-subtitle", "Layers"),
    layers,
    columns,
    explain,
  );

  const LAYERS: Record<string, string> = {
    From: "Transparent: Alice's address is public forever and links to her other payments. Shielded: encrypted — only Alice, Bob and anyone they give a viewing key can read it.",
    To: "Transparent: Bob's address (and every other payment he has received) is public. Shielded: encrypted to Bob.",
    Amount: "Transparent: 2.5 ZEC visible to everyone. Shielded: hidden inside note commitments; the proof still shows the values balance.",
    Memo: "Transparent payments have no private memo. Shielded memos (up to 512 bytes) are encrypted to the recipient — perfect for an invoice number.",
    "Links to history": "Transparent: anyone can build a graph of who paid whom. Shielded: there is nothing to link — each payment is unlinkable on chain.",
    "Fee & time": "Public in both: the fee and the block a transaction lands in. Shielding hides the content, not the fact that a transaction happened.",
  };
  for (const name of Object.keys(LAYERS)) {
    layers.appendChild(button(name, () => {
      focus = focus === name ? null : name;
      layers.querySelectorAll(".lv-chip").forEach((chip) => chip.classList.toggle("active", chip.textContent === focus));
      explain.textContent = focus ? LAYERS[focus]! : "Pick a layer to compare it across both payments.";
      render();
    }, "lv-chip"));
  }

  const encrypted = "▒▒▒▒ encrypted ▒▒▒▒";
  const render = (): void => {
    columns.replaceChildren();
    const card = (title: string, shielded: boolean): HTMLElement => {
      const box = el("div", `lv-tx ${shielded ? "lv-tx-shielded" : "lv-tx-transparent"}`);
      box.appendChild(el("div", "lv-tx-title", title));
      const hidden = shielded && !owner;
      const rows: [string, string, boolean][] = [
        ["From", shielded ? "Alice's shielded address" : "t1Alice7Xq…f3", hidden],
        ["To", shielded ? "Bob's shielded address" : "t1Bob9Kd…a1", hidden],
        ["Amount", "2.5 ZEC", hidden],
        ["Memo", shielded ? "Invoice #42 — thanks!" : "— (transparent has no memo)", hidden],
        ["Fee & time", "0.0001 ZEC · block 3,1xx,xxx", false],
        ["Links to history", shielded ? "None — nothing to link" : "t1Alice7Xq… → 14 earlier payments", hidden && shielded],
      ];
      for (const [label, value, isHidden] of rows) {
        const row = el("div", `lv-tx-row ${isHidden ? "lv-hidden" : "lv-visible"} ${focus === label ? "lv-layer-focus" : focus ? "lv-layer-dim" : ""}`);
        row.append(el("span", "lv-tx-label", label), el("span", "lv-tx-value", isHidden ? encrypted : value));
        box.appendChild(row);
      }
      box.appendChild(el("div", "lv-tx-note", shielded ? (owner ? "Decrypted with Bob's viewing key — only key holders see this." : "Observers see only that a valid transaction happened, its fee and time.") : "Anyone, forever: parties, amount and links to past payments."));
      return box;
    };
    columns.append(card("Transparent payment", false), card("Shielded payment", true));
  };
  const setView = (isOwner: boolean): void => {
    owner = isOwner;
    observerButton.classList.toggle("active", !owner);
    ownerButton.classList.toggle("active", owner);
    render();
  };
  render();
};

interface Block {
  data: string;
  prev: string;
  hash: string;
}

/** TRY — tamper with an old block, watch the chain break, then try to repair it. */
export const blockChain: Visualizer = ({ host, complete }) => {
  const blocks: Block[] = [
    { data: "Genesis", prev: "0".repeat(64), hash: "" },
    { data: "Alice → Bob 1.0", prev: "", hash: "" },
    { data: "Bob → Carol 0.4", prev: "", hash: "" },
    { data: "Carol → Dan 0.1", prev: "", hash: "" },
  ];
  let tampered = false;
  let repaired = false;
  const status = feedback();
  const row = el("div", "lv-chain");
  host.append(
    el("p", "lv-hint", "1) Edit the transaction in block #1 (pretend you are rewriting history). 2) Watch the following blocks break. 3) Re-mine each broken block in order to repair the chain."),
    row,
    status.element,
  );

  const hashOf = (index: number): Promise<string> => sha256Hex(`${index}|${blocks[index]!.prev}|${blocks[index]!.data}`);
  const relinkAll = async (): Promise<void> => {
    for (let i = 0; i < blocks.length; i++) {
      if (i > 0) blocks[i]!.prev = blocks[i - 1]!.hash;
      blocks[i]!.hash = await hashOf(i);
    }
  };
  const valid = (i: number): boolean => i === 0 || blocks[i]!.prev === blocks[i - 1]!.hash;

  const render = (): void => {
    row.replaceChildren();
    blocks.forEach((block, i) => {
      const ok = blocks.slice(0, i + 1).every((_, j) => valid(j));
      const card = el("div", `lv-block ${ok ? "lv-block-ok" : "lv-block-bad"}`);
      card.appendChild(el("div", "lv-block-title", `Block #${i}`));
      const input = el("input", "lv-input");
      input.value = block.data;
      input.disabled = i === 0;
      input.addEventListener("change", async () => {
        block.data = input.value;
        block.hash = await hashOf(i);
        if (i > 0 && i < blocks.length - 1) tampered = true;
        status.info(tampered ? "History changed: every block after the edited one now points to a hash that no longer exists." : "");
        render();
      });
      card.append(input, el("div", "lv-mono", `prev ${block.prev.slice(0, 12)}…`), el("div", "lv-mono", `hash ${block.hash.slice(0, 12)}…`));
      if (!valid(i)) {
        card.appendChild(
          button("⛏ Re-mine", async () => {
            const prior = blocks.slice(0, i).every((_, j) => valid(j));
            if (!prior) {
              status.bad("Repair the earlier broken block first — each block depends on the one before it.");
              return;
            }
            status.info("Mining… (real miners need enormous work for every block)");
            await new Promise((resolve) => setTimeout(resolve, 700));
            block.prev = blocks[i - 1]!.hash;
            block.hash = await hashOf(i);
            if (tampered && blocks.every((_, j) => valid(j)) && !repaired) {
              repaired = true;
              status.ok("✓ Chain repaired — but in the real network honest miners keep adding blocks while you redo yours, so you could never catch up. That is why confirmations make payments final.");
              complete();
            } else {
              status.info("Linked. Keep going down the chain.");
            }
            render();
          }, "zw-button lv-small"),
        );
      }
      row.appendChild(card);
    });
  };
  void relinkAll().then(render);
};

/** TRY — live SHA-256: change the input and count how many output bits flip. */
export const hashLab: Visualizer = ({ host, complete }) => {
  const input = el("input", "lv-input lv-input-wide");
  input.value = "Zcash";
  const output = el("div", "lv-mono lv-hash");
  const diff = el("div", "lv-hint");
  const status = feedback();
  let previous = "";
  let changes = 0;
  host.append(el("p", "lv-hint", "Type anything. Change a single character at least three times and watch the fingerprint."), input, output, diff, status.element);
  const update = async (): Promise<void> => {
    const hash = await sha256Hex(input.value);
    output.replaceChildren();
    [...hash].forEach((char, i) => {
      const span = el("span", previous && previous[i] !== char ? "lv-changed" : "", char);
      output.appendChild(span);
    });
    if (previous && previous !== hash) {
      changes++;
      diff.textContent = `${hexBitDistance(previous, hash)} of 256 bits changed (about half is what a good hash does).`;
    }
    previous = hash;
    if (changes >= 3) {
      status.ok("✓ Avalanche effect observed: tiny input changes, unrecognisable outputs — and no way back to the input.");
      complete();
    }
  };
  input.addEventListener("input", () => void update());
  void update();
};

/**
 * TRY — the anatomy of a transaction: pick inputs to cover a payment, work out
 * change and the ZIP-317 fee, broadcast and watch confirmations arrive, then read
 * addresses by their prefix.
 */
export const txAnatomy: Visualizer = ({ host, complete, state }) => {
  const saved = state.get<{ built?: boolean; confirmed?: boolean; read?: boolean }>() ?? {};
  const progress = { built: Boolean(saved.built), confirmed: Boolean(saved.confirmed), read: Boolean(saved.read) };
  const save = (): void => state.set(progress);
  const status = feedback();
  const stages = el("div", "lv-steps");
  const body = el("div", "lv-step-body");
  host.append(el("p", "lv-hint", "Three short tasks: build a payment, get it confirmed, read addresses."), stages, body, status.element);
  let stage = progress.read ? 2 : progress.confirmed ? 2 : progress.built ? 1 : 0;

  const finish = (): void => {
    save();
    if (progress.built && progress.confirmed && progress.read) {
      status.ok("✓ You can read a transaction: inputs, outputs, change, fee, confirmations and address types.");
      complete();
    }
  };
  const renderStages = (): void => {
    stages.replaceChildren();
    ["1. Build", "2. Confirm", "3. Read addresses"].forEach((label, i) => {
      const done = [progress.built, progress.confirmed, progress.read][i];
      const chip = button(label, () => {
        if (i === 0 || [progress.built, progress.confirmed][i - 1]) {
          stage = i;
          render();
        }
      }, `lv-chip ${i === stage ? "active" : ""} ${done ? "lv-chip-done" : ""}`);
      stages.appendChild(chip);
    });
  };

  const build = (): void => {
    const coins = [0.4, 1.0, 0.8, 0.25];
    const picked = new Set<number>();
    body.append(el("p", "", "Pay Bob 1.5 ZEC from your transparent wallet. Tick the coins (unspent outputs) you want to use as inputs."));
    const list = el("div", "lv-coins");
    const summary = el("div", "lv-small-text");
    const change = el("input", "lv-input");
    change.type = "number";
    change.step = "0.00001";
    change.placeholder = "Change back to you (ZEC)";
    const update = (): void => {
      const total = [...picked].reduce((sum, i) => sum + coins[i]!, 0);
      const fee = conventionalFeeZec(Math.max(picked.size, 2));
      summary.textContent = `Inputs: ${picked.size} coin(s) = ${total.toFixed(2)} ZEC · outputs: Bob + your change · ZIP-317 fee: ${fee.toFixed(5)} ZEC`;
    };
    coins.forEach((value, i) => {
      const coin = button(`${value} ZEC`, () => {
        if (picked.has(i)) picked.delete(i);
        else picked.add(i);
        coin.classList.toggle("active", picked.has(i));
        update();
      }, "lv-coin");
      list.appendChild(coin);
    });
    update();
    body.append(list, summary, change, button("Create transaction", () => {
      const total = [...picked].reduce((sum, i) => sum + coins[i]!, 0);
      const fee = conventionalFeeZec(Math.max(picked.size, 2));
      if (total < 1.5 + fee - 1e-9) return status.bad("✗ The inputs don't cover 1.5 ZEC plus the fee. Add a coin.");
      if (picked.size > 2) return status.bad(`✗ It works, but ${picked.size} inputs raise the ZIP-317 fee to ${fee.toFixed(5)} ZEC. Two coins are enough — use fewer inputs.`);
      const expected = Math.round((total - 1.5 - fee) * 1e5) / 1e5;
      if (Math.abs(Number(change.value) - expected) > 1e-6) return status.bad(`✗ Values must balance: inputs ${total.toFixed(2)} = 1.5 (Bob) + change + ${fee.toFixed(4)} (fee).`);
      progress.built = true;
      status.ok(`✓ Inputs ${total.toFixed(2)} = 1.5 to Bob + ${expected} change + ${fee.toFixed(4)} fee. On a transparent chain all of this is public.`);
      finish();
      body.appendChild(button("Next: broadcast it →", () => { stage = 1; render(); }, "zw-button zw-button-primary"));
    }, "zw-button"));
  };

  const confirm = (): void => {
    let confirmations = progress.confirmed ? 3 : 0;
    let broadcast = progress.confirmed;
    body.append(el("p", "", "Broadcast the payment, then mine blocks. Watch it move from the mempool into a block and collect confirmations."));
    const chain = el("div", "lv-mini-chain");
    const info = el("div", "lv-small-text");
    const draw = (): void => {
      chain.replaceChildren();
      for (let i = 0; i < 4; i++) {
        const block = el("div", `lv-mini-block ${i < confirmations ? "lv-mini-filled" : ""} ${i === 0 && confirmations > 0 ? "lv-mini-mine" : ""}`, i === 0 && confirmations > 0 ? "your tx" : i < confirmations ? "block" : "…");
        chain.appendChild(block);
      }
      info.textContent = !broadcast ? "Not broadcast yet." : confirmations === 0 ? "In the mempool — waiting for a miner (0 confirmations)." : `${confirmations} confirmation${confirmations > 1 ? "s" : ""}${confirmations >= 3 ? " — settled for everyday payments." : "."}`;
    };
    const mine = button("⛏ Mine next block", () => {
      if (!broadcast) return status.bad("Broadcast it first — miners can only include transactions they have heard about.");
      if (confirmations >= 3) return;
      confirmations++;
      draw();
      if (confirmations >= 3) {
        progress.confirmed = true;
        status.ok("✓ Three confirmations. Reversing it now would mean out-mining the whole network for three blocks.");
        finish();
        body.appendChild(button("Next: read addresses →", () => { stage = 2; render(); }, "zw-button zw-button-primary"));
      } else status.info(confirmations === 1 ? "Included in a block: confirmation 1." : "Another block on top: one more confirmation.");
    }, "zw-button");
    body.append(button("📡 Broadcast", () => {
      broadcast = true;
      status.info("Broadcast: nodes relay it to each other and keep it in their mempools.");
      draw();
    }, "zw-button"), mine, chain, info);
    draw();
  };

  const read = (): void => {
    const samples = shuffled([
      // Placeholders, not valid encodings (mixed case and the letter O are outside the address alphabets), so no
      // wallet accepts them; only the prefix matters here.
      "t1ExampleOnlyTransparentNotValid",
      "zs1exampleONLYsaplingaddressnotvalidforteaching",
      "u1exampleONLYunifiedaddressnotvalidforteaching",
      "utest1exampleONLYtestnetunifiednotvalid",
    ]);
    const choices = ["Transparent (mainnet)", "Sapling (mainnet)", "Unified (mainnet)", "Unified (testnet)"];
    const answerOf = (address: string): string => {
      const info = classifyAddress(address)!;
      if (info.pool === "transparent") return choices[0]!;
      if (info.pool === "sapling") return choices[1]!;
      return info.network === "mainnet" ? choices[2]! : choices[3]!;
    };
    let index = 0;
    body.append(el("p", "", "Which kind of address is this? The prefix tells you the pool and the network. (Placeholder examples — not real addresses; never send to them.)"));
    const box = el("div", "lv-scenario-box");
    body.appendChild(box);
    const next = (): void => {
      box.replaceChildren();
      const address = samples[index];
      if (!address) {
        progress.read = true;
        finish();
        box.appendChild(el("div", "lv-feedback lv-feedback-ok", "All four read correctly."));
        return;
      }
      box.append(el("div", "lv-mono lv-address", `${address.slice(0, 26)}…`));
      const options = el("div", "lv-actions");
      for (const choice of choices) {
        options.appendChild(button(choice, () => {
          if (choice !== answerOf(address)) return status.bad(`✗ Look at the first characters: ${address.slice(0, 6)}…`);
          status.ok(`✓ ${choice}.`);
          index++;
          next();
        }, "lv-chip"));
      }
      box.appendChild(options);
    };
    next();
  };

  const render = (): void => {
    renderStages();
    body.replaceChildren();
    [build, confirm, read][stage]!();
  };
  render();
};

/** The visualizers above, keyed by the ids lessons use in their SEE and TRY steps. */
export const BASIC_VISUALIZERS: VisualizerRegistry = {
  "zec-facts": zecFacts,
  "transparent-vs-shielded": transparentVsShielded,
  "block-chain": blockChain,
  "hash-lab": hashLab,
  "tx-anatomy": txAnatomy,
};
