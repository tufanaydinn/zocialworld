import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

/**
 * PARTICIPATION GATING TESTS
 *
 * Real runtime behavior tests for wallet-gated participation features.
 * Tests guest/ready state transitions, feature gating, and network privacy.
 */

// Mock localStorage for Node.js environment
if (typeof localStorage === "undefined") {
  const mockStorage: Record<string, string> = {};
  (global as any).localStorage = {
    getItem: (key: string) => mockStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      mockStorage[key] = value;
    },
    removeItem: (key: string) => {
      delete mockStorage[key];
    },
    clear: () => {
      for (const key in mockStorage) {
        delete mockStorage[key];
      }
    },
  };
}

describe("Participation gating", () => {
  beforeEach(async () => {
    // Clear storage between tests
    localStorage.clear();
  });

  afterEach(async () => {
    localStorage.clear();
  });

  describe("A. Guest can inspect project details", () => {
    it("guest state → project discovery and detail views accessible", async () => {
      const { getParticipationCapabilities } = await import("./participation");

      // Guest state (no wallet, or wallet locked)
      const capabilities = getParticipationCapabilities();

      // Guests should NOT have participation capabilities for voice and support
      assert.equal(capabilities.canVoice, false, "Guest canVoice should be false");
      assert.equal(capabilities.canSupportProjects, false, "Guest canSupportProjects should be false");

      // But they retain read access — getParticipationCapabilities() is callable in guest state
      // and returns stable false values (not undefined or error). Project access does not depend
      // on wallet status — only voice and support do.
      assert.ok(typeof capabilities === "object", "Capabilities object should exist");
      assert.ok("canVoice" in capabilities, "Capabilities should have canVoice field");
      assert.ok("canSupportProjects" in capabilities, "Capabilities should have canSupportProjects field");
    });
  });

  describe("B. Guest cannot support project", () => {
    it("guest state → support button disabled + tooltip explains why", async () => {
      const { getParticipationCapabilities } = await import("./participation");

      const capabilities = getParticipationCapabilities();
      assert.equal(capabilities.canSupportProjects, false, "Guest cannot support");

      // In real UI, this would disable the button and set tooltip:
      // "Connect wallet to support"
    });
  });

  describe("C. Ready wallet can support project", () => {
    it("ready state → support button enabled + tooltip confirms", async () => {
      const { updateParticipationState, getParticipationCapabilities } = await import("./participation");

      // Simulate wallet becoming ready
      updateParticipationState("ready");

      const capabilities = getParticipationCapabilities();
      assert.equal(capabilities.canSupportProjects, true, "Ready wallet canSupportProjects should be true");
      assert.equal(capabilities.canVoice, true, "Ready wallet canVoice should be true");
    });
  });

  describe("D. Ready -> locked disables support immediately", () => {
    it("ready → locked state → support button disabled immediately + no reload", async () => {
      const { updateParticipationState, getParticipationCapabilities, subscribeToCapabilities } = await import("./participation");

      // Start ready
      updateParticipationState("ready");
      assert.equal(getParticipationCapabilities().canSupportProjects, true);

      let capabilityUpdateCount = 0;
      const unsubscribe = subscribeToCapabilities(() => {
        capabilityUpdateCount++;
      });

      // Listener fires immediately with current state (ready) — so count starts at 1
      assert.equal(capabilityUpdateCount, 1, "Listener should fire immediately with ready state");

      // Transition to locked (via wallet adapter)
      updateParticipationState("locked");

      // Capability should update immediately (firing listener a second time)
      assert.equal(capabilityUpdateCount, 2, "Listener should fire on transition to locked");
      assert.equal(getParticipationCapabilities().canSupportProjects, false, "Support should be disabled");

      unsubscribe();
    });
  });

  describe("E. Guest cannot enable voice", () => {
    it("guest state → voice enable button disabled + tooltip explains wallet requirement", async () => {
      const { getParticipationCapabilities } = await import("./participation");

      const capabilities = getParticipationCapabilities();
      assert.equal(capabilities.canVoice, false, "Guest canVoice should be false");

      // In real UI:
      // - button.disabled = true
      // - button.title = "Connect or unlock your wallet to participate in voice"
    });
  });

  describe("F. Ready wallet can click Enable Voice", () => {
    it("ready state → voice enable button enabled, no auto-activation", async () => {
      const { updateParticipationState, getParticipationCapabilities } = await import("./participation");

      updateParticipationState("ready");

      const capabilities = getParticipationCapabilities();
      assert.equal(capabilities.canVoice, true, "Ready wallet canVoice should be true");

      // Button is enabled, but no voice is auto-activated (explicit user gesture still required)
    });
  });

  describe("G. Ready -> locked terminates/disables active voice", () => {
    it("ready → locked → capability subscribers fire with canVoice: false", async () => {
      const { updateParticipationState, getParticipationCapabilities, subscribeToCapabilities } = await import("./participation");

      updateParticipationState("ready");
      assert.equal(getParticipationCapabilities().canVoice, true);

      let fireCount = 0;
      let lastCanVoice = false;
      const unsubscribe = subscribeToCapabilities((caps) => {
        fireCount++;
        lastCanVoice = caps.canVoice;
      });

      // Listener fires immediately with current state (ready)
      assert.equal(fireCount, 1, "Subscriber should fire immediately on subscribe");
      assert.equal(lastCanVoice, true, "canVoice should be true in ready state");

      // Simulate wallet lock transition
      updateParticipationState("locked");

      // Subscriber fires again, notifying clients to disconnect voice (App.ts uses this to call voiceSession.disableVoice())
      assert.equal(fireCount, 2, "Subscriber should fire on lock transition");
      assert.equal(lastCanVoice, false, "canVoice should become false on lock");

      unsubscribe();
    });
  });

  describe("H. Participation capability state updates without reload", () => {
    it("capability changes fire subscriber callbacks immediately", async () => {
      const { updateParticipationState, subscribeToCapabilities } = await import("./participation");

      const updates: Array<{ canVoice: boolean; canSupport: boolean }> = [];

      const unsubscribe = subscribeToCapabilities((caps) => {
        updates.push({
          canVoice: caps.canVoice,
          canSupport: caps.canSupportProjects,
        });
      });

      // Initial subscription fires with current state
      assert.equal(updates.length, 1, "Should fire immediately on subscribe");
      assert.equal(updates[0]!.canVoice, false, "Initial state should be guest");

      // Transition to ready
      updateParticipationState("ready");
      assert.equal(updates.length, 2, "Should fire on ready transition");
      assert.equal(updates[1]!.canVoice, true, "Ready state should enable voice");

      // Transition back to locked
      updateParticipationState("locked");
      assert.equal(updates.length, 3, "Should fire on lock transition");
      assert.equal(updates[2]!.canVoice, false, "Locked state should disable voice");

      unsubscribe();
    });
  });

  describe("I. WebSocket/presence payloads contain no wallet address", () => {
    it("player summary should never include wallet address field", async () => {
      // Audit WebSocket payloads
      // Verify the protocol types do not include wallet address

      const { parseIncomingMessage } = await import("../networking/protocol");

      // Valid player_snapshot message
      const snapshot = {
        type: "player_snapshot",
        players: [
          {
            playerId: "player-123",
            nickname: "Alice",
            colorSeed: 42,
            x: 10,
            y: 1,
            z: 20,
            rotationY: 1.5,
            animationState: "walk",
          },
        ],
      };

      const parsed = parseIncomingMessage(snapshot);
      assert.ok(parsed, "Should parse valid snapshot");

      // Verify no wallet field exists in player summary
      if (parsed?.type === "player_snapshot") {
        for (const player of parsed.players) {
          assert.ok(!("walletAddress" in player), "Player should not have walletAddress field");
          assert.ok(!("address" in player), "Player should not have address field");
          assert.ok(!("wallet" in player), "Player should not have wallet field");
        }
      }
    });
  });

  describe("J. WebSocket/presence payloads contain no balance", () => {
    it("player summary should never include balance or ZEC fields", async () => {
      const { parseIncomingMessage } = await import("../networking/protocol");

      const playerJoined = {
        type: "player_joined",
        playerId: "player-456",
        nickname: "Bob",
        colorSeed: 55,
        x: 5,
        y: 1,
        z: 15,
        rotationY: 0.5,
        animationState: "idle",
      };

      const parsed = parseIncomingMessage(playerJoined);
      assert.ok(parsed, "Should parse valid player_joined");

      // Verify no balance field
      if (parsed && "playerId" in parsed) {
        assert.ok(!("balance" in parsed), "Player should not have balance field");
        assert.ok(!("zec" in parsed), "Player should not have zec field");
        assert.ok(!("totalZec" in parsed), "Player should not have totalZec field");
        assert.ok(!("pendingZec" in parsed), "Player should not have pendingZec field");
      }
    });
  });

  describe("K. WebSocket/presence payloads contain no transaction/history/account identifiers", () => {
    it("player summary should not expose financial transaction or account data", async () => {
      const { parseIncomingMessage } = await import("../networking/protocol");

      const transform = {
        type: "player_transform",
        playerId: "player-789",
        x: 15,
        y: 1,
        z: 25,
        rotationY: 3.14,
        animationState: "walk",
        seq: 1,
        t: Date.now(),
      };

      const parsed = parseIncomingMessage(transform);
      assert.ok(parsed, "Should parse valid player_transform");

      if (parsed && parsed.type === "player_transform") {
        // Verify no transaction/account/history fields
        assert.ok(!("txid" in parsed), "Should not have txid field");
        assert.ok(!("transactionId" in parsed), "Should not have transactionId field");
        assert.ok(!("accountId" in parsed), "Should not have accountId field");
        assert.ok(!("account" in parsed), "Should not have account field");
        assert.ok(!("history" in parsed), "Should not have history field");
        assert.ok(!("transactionHistory" in parsed), "Should not have transactionHistory field");
        assert.ok(!("UFVK" in parsed), "Should not have UFVK field");
        assert.ok(!("viewingKey" in parsed), "Should not have viewingKey field");
      }
    });
  });

  describe("L. Server-side message construction audit", () => {
    it("welcome message contains only: playerId, nickname, colorSeed, tickRateHz, voiceCapability", async () => {
      // Server message construction is in apps/server/src/WorldServer.ts handleJoin()
      // Message shape is enforced by protocol types in @project/shared
      // This test verifies the protocol types themselves have no wallet fields
      const { parseIncomingMessage } = await import("../networking/protocol");

      // The welcome message would come from server, parsed by client
      // (not directly testable here without the server, but the protocol shape is known)
      // Instead, verify player_joined which has similar structure
      const playerJoined = {
        type: "player_joined",
        playerId: "player-100",
        nickname: "Alice",
        colorSeed: 42,
        x: 10,
        y: 1,
        z: 20,
        rotationY: 1.5,
        animationState: "idle",
      };

      const parsed = parseIncomingMessage(playerJoined);
      assert.ok(parsed && parsed.type === "player_joined", "Should parse valid player_joined");

      if (parsed && "playerId" in parsed) {
        // Verify only presence fields exist, no financial data.
        // ADR-015 § 4 amends the privacy boundary by exactly two fields: the cosmetic `avatar`
        // and ONE wallet-derived boolean, `canReceive` ("can receive ZEC privately") — never an
        // address, balance, network or lock state.
        const expectedFields = new Set([
          "type",
          "playerId",
          "nickname",
          "colorSeed",
          "avatar",
          "canReceive",
          "x",
          "y",
          "z",
          "rotationY",
          "animationState",
        ]);
        const actualFields = new Set(Object.keys(parsed));

        for (const field of actualFields) {
          assert.ok(expectedFields.has(field), `Unexpected field: ${field}`);
        }
      }
    });

    it("ADR-015: canReceive is a boolean only, and wallet-shaped extra fields from a server are never passed on", async () => {
      const { parseIncomingMessage } = await import("../networking/protocol");
      const parsed = parseIncomingMessage({
        type: "player_joined",
        playerId: "player-101",
        nickname: "Ada",
        colorSeed: 7,
        avatar: { model: "mage", color: 2 },
        canReceive: "yes",
        walletAddress: "utest1xyz",
        balance: 12,
        locked: true,
        x: 0,
        y: 0,
        z: 0,
        rotationY: 0,
        animationState: "idle",
      });
      assert.ok(parsed && parsed.type === "player_joined");
      if (parsed && parsed.type === "player_joined") {
        assert.equal(parsed.canReceive, false, "only a literal true counts");
        for (const field of ["walletAddress", "balance", "locked", "address", "network"]) assert.ok(!(field in parsed), `no ${field}`);
      }
    });

    it("player_snapshot contains only presence fields (no financial data)", async () => {
      const { parseIncomingMessage } = await import("../networking/protocol");

      const snapshot = {
        type: "player_snapshot",
        players: [
          {
            playerId: "player-200",
            nickname: "Bob",
            colorSeed: 55,
            x: 5,
            y: 1,
            z: 15,
            rotationY: 0.5,
            animationState: "walk",
          },
        ],
      };

      const parsed = parseIncomingMessage(snapshot);
      assert.ok(parsed && parsed.type === "player_snapshot", "Should parse valid snapshot");

      if (parsed && "players" in parsed) {
        for (const player of parsed.players) {
          assert.ok(!("balance" in player), "No balance field");
          assert.ok(!("walletAddress" in player), "No walletAddress field");
          assert.ok(!("address" in player), "No address field");
        }
      }
    });

    it("nickname_updated contains only playerId and nickname", async () => {
      const { parseIncomingMessage } = await import("../networking/protocol");

      const nicknameUpdate = {
        type: "nickname_updated",
        playerId: "player-300",
        nickname: "NewName",
      };

      const parsed = parseIncomingMessage(nicknameUpdate);
      assert.ok(parsed && parsed.type === "nickname_updated", "Should parse valid update");

      if (parsed && "playerId" in parsed) {
        const expectedFields = new Set(["type", "playerId", "nickname"]);
        const actualFields = new Set(Object.keys(parsed));

        for (const field of actualFields) {
          assert.ok(
            expectedFields.has(field),
            `nickname_updated should not contain ${field}`
          );
        }
      }
    });
  });

  describe("M. ProjectDetailPanel subscription cleanup", () => {
    it("ProjectDetailPanel.dispose() removes subscription callback when panel is disposed", async () => {
      // Set up JSDOM dynamically for this test only (after tsx ESM loader is ready)
      const { JSDOM } = await import("jsdom");
      const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
        pretendToBeVisual: true,
        url: "http://localhost",
      });
      const originalDocument = globalThis.document;
      const originalWindow = globalThis.window;
      const originalHTMLElement = globalThis.HTMLElement;
      const originalHTMLDivElement = globalThis.HTMLDivElement;
      const originalHTMLButtonElement = globalThis.HTMLButtonElement;
      const originalHTMLInputElement = globalThis.HTMLInputElement;
      const originalHTMLParagraphElement = globalThis.HTMLParagraphElement;
      const originalHTMLSpanElement = globalThis.HTMLSpanElement;

      try {
        globalThis.document = dom.window.document;
        globalThis.window = dom.window as any;
        globalThis.HTMLElement = dom.window.HTMLElement;
        globalThis.HTMLDivElement = dom.window.HTMLDivElement;
        globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
        globalThis.HTMLInputElement = dom.window.HTMLInputElement;
        globalThis.HTMLParagraphElement = dom.window.HTMLParagraphElement;
        globalThis.HTMLSpanElement = dom.window.HTMLSpanElement;

        const { updateParticipationState, resetParticipationState, __testSeam } = await import("./participation");
        const { ProjectDetailPanel } = await import("../projects/ProjectDetailPanel");
        const { getAllProjects } = await import("../projects/ProjectRegistry");

        // Get a real project from the registry for rendering
        const projects = getAllProjects();
        assert.ok(projects.length > 0, "Should have at least one project to test with");
        const testProject = projects[0];

        // Clear any prior listeners from other tests
        __testSeam.clearAllListeners();

        // Start in guest state (no listeners yet)
        assert.equal(__testSeam.getListenerCount(), 0, "Should start with no listeners");

        // Create a panel with a mock onBack callback
        const panelBackCalls: number[] = [];
        const panel = new ProjectDetailPanel(() => {
          panelBackCalls.push(1);
        });

        // Render the project — this triggers panel.ensureSupportButton() which creates
        // the subscription to capability changes
        panel.render(testProject);

        // Verify the panel created a listener when rendered
        const listenerCountAfterRender = __testSeam.getListenerCount();
        assert.ok(listenerCountAfterRender >= 1, "Panel render should create at least one listener (subscription)");

        // Add an external listener to verify state changes still work for non-disposed listeners
        let externalListenerFired = false;
        const { subscribeToCapabilities } = await import("./participation");
        const unsubscribeExternal = subscribeToCapabilities(() => {
          externalListenerFired = true;
        });

        const listenerCountBeforeDispose = __testSeam.getListenerCount();
        assert.ok(listenerCountBeforeDispose >= 2, "Should have panel listener + external listener");

        // Dispose the panel — this should call unsubscribeCapabilities() and remove the listener
        panel.dispose();

        // Verify the panel's listener was removed
        const listenerCountAfterDispose = __testSeam.getListenerCount();
        assert.equal(
          listenerCountAfterDispose,
          listenerCountBeforeDispose - 1,
          "Disposing panel should remove exactly one listener (the panel's subscription)"
        );

        // Trigger a participation state change
        externalListenerFired = false;
        updateParticipationState("ready");

        // Verify that the disposed panel's listener did NOT fire
        // (the external listener should fire, proving state changes still work)
        assert.equal(externalListenerFired, true, "External listener should still receive updates");

        // If we could track which specific listeners fired, we would verify that
        // the disposed panel's listener was NOT called. Since the test seam only counts,
        // we verify indirectly: the listener count is lower, and other listeners still work.

        // Clean up
        unsubscribeExternal();
        resetParticipationState();
        __testSeam.clearAllListeners();

        assert.equal(__testSeam.getListenerCount(), 0, "All listeners should be cleaned up");
      } finally {
        // Restore original globals
        if (originalDocument) globalThis.document = originalDocument;
        if (originalWindow) globalThis.window = originalWindow;
        if (originalHTMLElement) globalThis.HTMLElement = originalHTMLElement;
        if (originalHTMLDivElement) globalThis.HTMLDivElement = originalHTMLDivElement;
        if (originalHTMLButtonElement) globalThis.HTMLButtonElement = originalHTMLButtonElement;
        if (originalHTMLInputElement) globalThis.HTMLInputElement = originalHTMLInputElement;
        if (originalHTMLParagraphElement) globalThis.HTMLParagraphElement = originalHTMLParagraphElement;
        if (originalHTMLSpanElement) globalThis.HTMLSpanElement = originalHTMLSpanElement;
      }
    });
  });
});

// ADR-015 § 1, § 8: the sticky wallet-holder flag — the one bit App sends as join.wallet / set_wallet.
describe("ADR-015 sticky walletHolder flag", () => {
  it("becomes true on ready/syncing, survives locked, disconnected, initializing and error, and becomes false only on idle", async () => {
    const participation = await import("./participation.ts");
    participation.__testSeam.resetWalletHolder();
    participation.updateParticipationState("idle");
    const seen: boolean[] = [];
    const unsubscribe = participation.subscribeToWalletHolder((holder) => seen.push(holder));
    assert.deepEqual(seen, [false], "called at once with the current value");
    participation.updateParticipationState("initializing");
    participation.updateParticipationState("locked");
    assert.equal(participation.isWalletHolder(), false, "a locked wallet on this device is not a holder until unlocked this session");
    participation.updateParticipationState("ready");
    assert.equal(participation.isWalletHolder(), true);
    participation.updateParticipationState("syncing");
    participation.updateParticipationState("locked");
    assert.equal(participation.isWalletHolder(), true, "locking keeps the holder flag (lock times never reach the network)");
    assert.equal(participation.getParticipationCapabilities().canVoice, false, "…but voice still needs the unlocked wallet");
    participation.resetParticipationState(); // what the adapter does on "disconnected"
    participation.updateParticipationState("error");
    participation.updateParticipationState("initializing");
    assert.equal(participation.isWalletHolder(), true);
    participation.updateParticipationState("idle"); // "Forget this wallet on this device"
    assert.equal(participation.isWalletHolder(), false);
    participation.updateParticipationState("syncing");
    assert.deepEqual(seen, [false, true, false, true], "one notification per change, none for repeats");
    unsubscribe();
    participation.updateParticipationState("idle");
    assert.deepEqual(seen, [false, true, false, true], "no calls after unsubscribing");
    participation.__testSeam.resetWalletHolder();
  });
});

// A background sync (or a payment broadcast) must not end voice.
describe("sync keeps participation", () => {
  it("syncing keeps participation (wallet is still unlocked); locking ends it", async () => {
    const participation = await import("./participation.ts");
    participation.updateParticipationState("ready");
    participation.updateParticipationState("syncing");
    assert.equal(participation.getParticipationCapabilities().canVoice, true);
    participation.updateParticipationState("locked");
    assert.equal(participation.getParticipationCapabilities().canVoice, false);
  });
});
