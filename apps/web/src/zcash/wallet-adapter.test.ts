import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

describe("Wallet adapter security properties", () => {
  describe("User-provided passphrase", () => {
    it("no hard-coded TESTNET_SYSTEM_PASSPHRASE exported", async () => {
      const store = await import("./core/store");
      // Verify hard-coded passphrase is not exported
      const exports = Object.keys(store);
      assert.ok(
        !exports.includes("TESTNET_SYSTEM_PASSPHRASE"),
        "Hard-coded passphrase should not be exported"
      );
      assert.ok(typeof store.getSeed === "function", "getSeed should be a function");
      assert.ok(typeof store.setSeed === "function", "setSeed should be a function");
      assert.ok(typeof store.clearSeed === "function", "clearSeed should be a function");
    });

    it("security scan: no hardcoded passphrase literals in source", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      // Scan entire apps/web/src/zcash subtree for security issues
      async function scanDirectory(dir: string): Promise<string[]> {
        const files: string[] = [];
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            // Skip node_modules and generated files
            if (entry.name === 'node_modules' || entry.name.endsWith('.test.ts')) {
              continue;
            }
            if (entry.isDirectory()) {
              files.push(...await scanDirectory(fullPath));
            } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
              files.push(fullPath);
            }
          }
        } catch (e) {
          // directory may not exist, skip
        }
        return files;
      }

      const filesToScan = await scanDirectory("src/zcash");

      const prohibitedPatterns = [
        { pattern: /TESTNET_SYSTEM_PASSPHRASE\s*=\s*["']/, name: "TESTNET_SYSTEM_PASSPHRASE hardcoded value" },
        { pattern: /[a-z]+\.wallet\.testnet\.v1\s*=\s*["']/, name: "wallet.testnet.v1 hardcoded value" },
        { pattern: /default.*passphrase\s*=\s*["'][a-z0-9]/i, name: "default/fallback passphrase literal" },
        { pattern: /plaintext.*seed/i, name: "plaintext seed persistence" },
        { pattern: /console\.(log|error|warn).*passphrase/i, name: "passphrase logging" },
        { pattern: /localStorage\.setItem.*passphrase/i, name: "plaintext passphrase in localStorage" },
        { pattern: /sessionStorage\.setItem.*passphrase/i, name: "plaintext passphrase in sessionStorage" }
      ];

      for (const file of filesToScan) {
        const content = await fs.readFile(file, "utf-8");
        for (const { pattern, name } of prohibitedPatterns) {
          assert.ok(
            !pattern.test(content),
            `File ${file} contains prohibited pattern: ${name}`
          );
        }
      }

      assert.ok(filesToScan.length > 0, "Security scan should find files to scan in src/zcash/**");
    });
  });


  describe("Address validation", () => {
    it("wallet-types validates address formats", async () => {
      const walletTypes = await import("./core/wallet-types");

      // The module should exist and export validation functions
      assert.ok(typeof walletTypes.validateAddress === "function");
      assert.ok(typeof walletTypes.detectAddressKind === "function");

      // Test format-based validation
      const result = walletTypes.validateAddress("utest1invalid");
      assert.ok(result.ok === false, "Invalid address format should be rejected");

      // Test valid Unified Address pattern
      const validAddr = walletTypes.validateAddress("utest1qyc8r68amxslqclppwv2g3e5xz3dq0ey6xgwvpw5ht0f4gf3z67mxn7a0n");
      assert.ok(validAddr.ok !== false, "Valid Unified Address should be accepted");
    });
  });

  describe("Participation gating", () => {
    it("participation.ts gates eligibility on 'ready' status only", async () => {
      const participation = await import("./participation");

      // Test participation state logic
      participation.updateParticipationState("locked");
      let state = participation.getParticipationState();
      assert.equal(state.participationEligible, false, "LOCKED state should not enable participation");
      assert.equal(state.walletConnected, false, "LOCKED state should not mark wallet as connected");

      participation.updateParticipationState("ready");
      state = participation.getParticipationState();
      assert.equal(
        state.participationEligible,
        true,
        "READY state should enable participation"
      );
      assert.equal(state.walletConnected, true, "READY state should mark wallet as connected");

      participation.resetParticipationState();
      state = participation.getParticipationState();
      assert.equal(
        state.participationEligible,
        false,
        "After reset, participation should be disabled"
      );
    });
  });

  describe("Lock/unlock API", () => {
    it("ZcashWalletAdapter has unlock() and lock() methods", async () => {
      const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
      // Verify methods exist and are callable
      assert.ok(typeof ZcashWalletAdapter.unlock === "function", "unlock() should be a function");
      assert.ok(typeof ZcashWalletAdapter.lock === "function", "lock() should be a function");
    });
  });

  describe("Shielded Send Validation", () => {
    it("validateAddress rejects transparent addresses correctly", async () => {
      const { validateAddress, isShieldedKind } = await import("./core/wallet-types");

      // Test transparent address (format fixture: t1 prefix indicates transparent, but not cryptographically validated)
      const transAddr = "t1EZhqt4YvwUx2zksggq91MQWGu3DHreom";
      const result = validateAddress(transAddr);
      assert.equal(result.ok, true, "Valid t1 format should be accepted");
      assert.equal(result.kind, "transparent", "t1 addresses should be detected as transparent");
      assert.equal(isShieldedKind(result.kind), false, "Transparent addresses are not shielded");

      // Test shielded address (format fixture: unified prefix indicates shielded, but not cryptographically validated)
      const shieldedAddr = "utest1qyc8r68amxslqclppwv2g3e5xz3dq0ey6xgwvpw5ht0f4gf3z67mxn7a0n";
      const shieldedResult = validateAddress(shieldedAddr);
      assert.equal(shieldedResult.ok, true, "Valid unified format should be accepted");
      assert.ok(isShieldedKind(shieldedResult.kind), "Unified addresses should be recognized as shielded");

      // Test invalid address
      const invalidAddr = "invalid_address_xyz";
      const invalidResult = validateAddress(invalidAddr);
      assert.equal(invalidResult.ok, false, "Invalid address format should be rejected");
    });
  });

  describe("Seed storage and address detection behaviour", () => {
    it("store.ts refuses to read or write the seed without a passphrase", async () => {
      const store = await import("./core/store");
      await assert.rejects(store.getSeed(""), /PASSPHRASE_REQUIRED/, "getSeed must require the unlock passphrase");
      await assert.rejects(
        store.setSeed("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", ""),
        /PASSPHRASE_REQUIRED/,
        "setSeed must require a wallet encryption passphrase"
      );

      const fs = await import("node:fs/promises");
      const content = await fs.readFile("src/zcash/core/store.ts", "utf-8");
      assert.ok(
        !content.includes("TESTNET_SYSTEM_PASSPHRASE ="),
        "Hard-coded passphrase should be removed"
      );
    });

    it("wallet-types.ts detects every network's address prefixes and checks TEX addresses for real", async () => {
      const { detectAddressKind } = await import("./core/wallet-types");
      const body = "qyc8r68amxslqclppwv2g3e5xz3dq0ey6xgwvpw5ht0f4gf3z67mxn7a0n";
      assert.equal(detectAddressKind(`utest1${body}`), "unified", "testnet unified address");
      assert.equal(detectAddressKind(`uregtest1${body}`), "unified", "regtest unified address (the test-network engine)");
      assert.equal(detectAddressKind(`zregtestsapling1${body}`), "sapling", "regtest Sapling address");
      // A tex1 string with a matching prefix but no valid bech32m checksum is not a TEX address.
      assert.notEqual(detectAddressKind(`tex1${body}`), "tex", "a TEX address needs a valid checksum");
    });

    it("ZcashWalletAdapter implements unlock() and lock() methods", async () => {
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(
        "src/zcash/ZcashWalletAdapter.ts",
        "utf-8"
      );

      assert.ok(content.includes("async unlock("), "unlock method should be implemented");
      assert.ok(content.includes("async lock("), "lock method should be implemented");
      assert.ok(content.includes('status: "locked"'), "LOCKED status should be set");
    });
  });
});
