import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

/**
 * WALLET LIFECYCLE TESTS
 *
 * Real runtime behavior tests for wallet state transitions, storage preservation,
 * and participation gating. Tests the actual ZcashWalletAdapter with a test seam
 * to mock the WebZjs boundary.
 */

// Mock localStorage for Node.js environment (set up at module level)
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

// Mock wallet implementation
interface MockZecWallet {
  accountId: number;
  address(): Promise<string>;
  exportDb(): Promise<Uint8Array>;
  sync(): Promise<void>;
  balances(): Promise<{ totalZec: number; pendingZec: number; transparentZec: number; chainTipHeight: number; fullyScannedHeight: number; raw: unknown }>;
  sendWithMemo(toAddress: string, amountZatoshi: bigint, memo: string): Promise<string>;
  send(toAddress: string, amountZatoshi: bigint): Promise<string>;
  shield(): Promise<boolean>;
  tip(): Promise<number>;
  getTransactionHistory(limit?: number, offset?: number): Promise<any>;
  createdWithBirthday: number | null;
  transparentAddress(): Promise<string>;
}

function createMockWallet(dbBytes?: Uint8Array): MockZecWallet {
  return {
    accountId: 0,
    createdWithBirthday: null,
    address: async () => "utest1qyc8r68amxslqclppwv2g3e5xz3dq0ey6xgwvpw5ht0f4gf3z67mxn7a0n",
    transparentAddress: async () => "t1EZhqt4YvwUx2zksggq91MQWGu3DHreom",
    exportDb: async () => dbBytes || new Uint8Array([0, 1, 2, 3]),
    sync: async () => {},
    balances: async () => ({
      totalZec: 0,
      pendingZec: 0,
      transparentZec: 0,
      chainTipHeight: 1000000,
      fullyScannedHeight: 1000000,
      raw: null,
    }),
    sendWithMemo: async () => "mock_txid_123",
    send: async () => "mock_txid_456",
    shield: async () => true,
    tip: async () => 1000000,
    getTransactionHistory: async () => ({ transactions: [] }),
  };
}

describe("Wallet lifecycle", () => {
  beforeEach(async () => {
    // Clear storage between tests
    localStorage.clear();

    // Install test wallet factory via test seam
    const walletMod = await import("./core/wallet");
    walletMod.__testSeam.walletFactory = async () => createMockWallet();
  });

  afterEach(async () => {
    // Clean up test seam
    const walletMod = await import("./core/wallet");
    walletMod.__testSeam.walletFactory = null;

    localStorage.clear();
  });

  describe("A. Initialize with stored encrypted seed → LOCKED state", () => {
    it("stored encrypted seed exists + initialize → status === 'locked'", async () => {
      // Arrange: store encrypted seed (simulating prior create/import)
      const { setSeed } = await import("./core/store");
      await setSeed("test seed phrase words here now", "test_passphrase_123");

      const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");

      // Act: initialize adapter
      await ZcashWalletAdapter.initialize("http://localhost:9000");

      // Assert
      assert.equal(ZcashWalletAdapter.state.status, "locked", "Status should be 'locked' when encrypted seed exists");
      assert.equal(ZcashWalletAdapter.state.error, null, "No error on successful initialize");
    });
  });

  // Tests B, E, F, G require IndexedDB which is not available in Node.js test environment
  // These would pass with a proper IndexedDB mock; currently skipped to verify passphrase/participation logic

  describe("B. LOCKED + unlock(correctPassphrase) → READY state", () => {
    it("locked + unlock(correctPassphrase) → status === 'ready'", async () => {
      // Arrange: create and encrypt seed
      const { setSeed } = await import("./core/store");
      const testPassphrase = "correctPassphrase123";
      const testSeed = "test seed phrase words here now";

      await setSeed(testSeed, testPassphrase);

      const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
      await ZcashWalletAdapter.initialize("http://localhost:9000");
      assert.equal(ZcashWalletAdapter.state.status, "locked", "Setup: should be locked");

      // Act: unlock with correct passphrase
      await ZcashWalletAdapter.unlock(testPassphrase);

      // Assert
      assert.equal(ZcashWalletAdapter.state.status, "ready", "Status should transition to 'ready' on correct unlock");
      assert.equal(ZcashWalletAdapter.state.error, null, "No error on successful unlock");
      assert.notEqual(ZcashWalletAdapter.state.account, null, "Account should be populated");
    });
  });

  describe("C. LOCKED + unlock(wrongPassphrase) → LOCKED state", () => {
    it("locked + unlock(wrongPassphrase) → status === 'locked' (error set)", async () => {
      // Arrange: create and encrypt seed with one passphrase
      const { setSeed } = await import("./core/store");
      const correctPassphrase = "correctPassphrase123";
      const wrongPassphrase = "wrongPassphrase456";
      const testSeed = "test seed phrase words here now";

      await setSeed(testSeed, correctPassphrase);

      const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
      await ZcashWalletAdapter.initialize("http://localhost:9000");
      assert.equal(ZcashWalletAdapter.state.status, "locked", "Setup: should be locked");

      // Act: attempt unlock with wrong passphrase
      let unlockError = null;
      try {
        await ZcashWalletAdapter.unlock(wrongPassphrase);
      } catch (e) {
        unlockError = e;
      }

      // Assert
      assert.ok(unlockError, "Unlock should throw on wrong passphrase");
      assert.equal(ZcashWalletAdapter.state.status, "locked", "Status should remain 'locked' after wrong passphrase");
      assert.ok(ZcashWalletAdapter.state.error?.includes("passphrase"), "Error should mention wrong passphrase");
    });
  });

  describe("D. Wrong passphrase → encrypted seed still exists", () => {
    it("wrong unlock → encrypted seed remains in storage", async () => {
      // Arrange: create and encrypt seed
      const { setSeed } = await import("./core/store");
      const correctPassphrase = "correctPassphrase123";
      const wrongPassphrase = "wrongPassphrase456";
      const testSeed = "test seed phrase words here now";

      await setSeed(testSeed, correctPassphrase);

      const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
      await ZcashWalletAdapter.initialize("http://localhost:9000");

      // Check storage before
      const seedKeyBefore = localStorage.getItem("zw.wallet.seed.v1");
      assert.ok(seedKeyBefore, "Seed should exist before wrong unlock");

      // Act: attempt wrong unlock
      try {
        await ZcashWalletAdapter.unlock(wrongPassphrase);
      } catch (e) {
        // expected
      }

      // Assert
      const seedKeyAfter = localStorage.getItem("zw.wallet.seed.v1");
      assert.equal(seedKeyBefore, seedKeyAfter, "Encrypted seed should remain unchanged after wrong passphrase");
    });
  });

  describe("E. Wrong passphrase → persisted wallet DB remains present", () => {
    it("wrong unlock → wallet DB persists in storage", async () => {
      // Arrange: set up wallet with persisted DB
      const { setSeed, saveWalletDb } = await import("./core/store");
      const correctPassphrase = "correctPassphrase123";
      const wrongPassphrase = "wrongPassphrase456";
      const testSeed = "test seed phrase words here now";
      const testDbBytes = new Uint8Array([1, 2, 3, 4, 5]);

      await setSeed(testSeed, correctPassphrase);
      await saveWalletDb(testDbBytes);

      const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
      await ZcashWalletAdapter.initialize("http://localhost:9000");

      // Act: attempt wrong unlock
      try {
        await ZcashWalletAdapter.unlock(wrongPassphrase);
      } catch (e) {
        // expected
      }

      // Assert: DB should still be retrievable
      const { loadWalletDb } = await import("./core/store");
      const dbAfterWrongUnlock = await loadWalletDb();
      assert.ok(dbAfterWrongUnlock, "Wallet DB should persist after wrong passphrase");
    });
  });

  describe("F. READY + lock() → LOCKED state, storage preserved", () => {
    it("ready + lock() → status === 'locked' + account/balance cleared + storage preserved", async () => {
      // Arrange: unlock to ready state
      const { setSeed, saveWalletDb } = await import("./core/store");
      const testPassphrase = "correctPassphrase123";
      const testSeed = "test seed phrase words here now";
      const testDbBytes = new Uint8Array([1, 2, 3, 4, 5]);

      await setSeed(testSeed, testPassphrase);
      await saveWalletDb(testDbBytes);

      const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
      await ZcashWalletAdapter.initialize("http://localhost:9000");
      await ZcashWalletAdapter.unlock(testPassphrase);
      assert.equal(ZcashWalletAdapter.state.status, "ready", "Setup: should be ready");

      // Act: lock
      await ZcashWalletAdapter.lock();

      // Assert
      assert.equal(ZcashWalletAdapter.state.status, "locked", "Status should transition to 'locked'");
      assert.equal(ZcashWalletAdapter.state.account, null, "Account should be cleared");
      assert.equal(ZcashWalletAdapter.state.balance, null, "Balance should be cleared");

      // Storage should be preserved
      const { hasSeed, loadWalletDb } = await import("./core/store");
      const seedStillExists = await hasSeed();
      const dbStillExists = await loadWalletDb();
      assert.equal(seedStillExists, true, "Encrypted seed should persist after lock");
      assert.ok(dbStillExists, "Wallet DB should persist after lock");
    });
  });

  describe("G. clearAllData() → IDLE state, all storage cleared", () => {
    it("clearAllData() → status === 'idle' + encrypted seed removed + DB cleared", async () => {
      // Arrange: set up wallet with seed and DB
      const { setSeed, saveWalletDb } = await import("./core/store");
      const testPassphrase = "correctPassphrase123";
      const testSeed = "test seed phrase words here now";
      const testDbBytes = new Uint8Array([1, 2, 3, 4, 5]);

      await setSeed(testSeed, testPassphrase);
      await saveWalletDb(testDbBytes);

      const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
      await ZcashWalletAdapter.initialize("http://localhost:9000");

      // Act: clear all data
      await ZcashWalletAdapter.clearAllData();

      // Assert
      assert.equal(ZcashWalletAdapter.state.status, "idle", "Status should transition to 'idle'");
      assert.equal(ZcashWalletAdapter.state.account, null, "Account should be null");
      assert.equal(ZcashWalletAdapter.state.balance, null, "Balance should be null");

      // Storage should be completely cleared
      const { hasSeed, loadWalletDb } = await import("./core/store");
      const seedExists = await hasSeed();
      const dbExists = await loadWalletDb();
      assert.equal(seedExists, false, "Encrypted seed should be cleared");
      assert.equal(dbExists, null, "Wallet DB should be cleared");
    });
  });

  describe("H. Participation: LOCKED → participationEligible === false", () => {
    it("locked state → participation is NOT eligible", async () => {
      // Arrange: set up locked wallet
      const { setSeed } = await import("./core/store");
      await setSeed("test seed phrase words here now", "password123");

      const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
      await ZcashWalletAdapter.initialize("http://localhost:9000");
      assert.equal(ZcashWalletAdapter.state.status, "locked", "Setup: should be locked");

      // Act & Assert: check participation state
      const { getParticipationState } = await import("./participation");
      const state = getParticipationState();
      assert.equal(state.participationEligible, false, "Participation should be disabled in LOCKED state");
      assert.equal(state.walletConnected, false, "Wallet should not be marked connected in LOCKED state");
    });
  });

  describe("I. Participation: READY → participationEligible === true", () => {
    it("ready state → participation is eligible", async () => {
      // Arrange: set up and unlock wallet
      const { setSeed } = await import("./core/store");
      const testPassphrase = "password123";
      await setSeed("test seed phrase words here now", testPassphrase);

      const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
      await ZcashWalletAdapter.initialize("http://localhost:9000");
      await ZcashWalletAdapter.unlock(testPassphrase);
      assert.equal(ZcashWalletAdapter.state.status, "ready", "Setup: should be ready");

      // Act & Assert: check participation state
      const { getParticipationState } = await import("./participation");
      const state = getParticipationState();
      assert.equal(state.participationEligible, true, "Participation should be enabled in READY state");
      assert.equal(state.walletConnected, true, "Wallet should be marked connected in READY state");
    });
  });
});
