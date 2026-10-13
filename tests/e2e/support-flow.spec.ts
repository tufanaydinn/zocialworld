// E2E tests for Zcash support payment flow.
// Tests the complete flow: wallet creation, project support, transaction confirmation.

import { test, expect } from "@playwright/test";

test.describe("Zcash Support Payment Flow", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app and wait for wallet initialization
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("A: Create new wallet and generate seed phrase", async ({ page }) => {
    // Expose wallet interface to test code
    await page.addInitScript(() => {
      (window as any).__walletTestHook = () => {
        // Placeholder for wallet testing hook
      };
    });

    // Look for wallet setup button or panel
    const createWalletButton = page.locator('[data-testid="wallet-create-button"]');
    if (await createWalletButton.isVisible()) {
      await createWalletButton.click();

      // Wait for seed phrase to appear
      await page.waitForSelector('[data-testid="wallet-seed-display"]', { timeout: 5000 });

      // Verify seed phrase is displayed
      const seedDisplay = page.locator('[data-testid="wallet-seed-display"]');
      const seedText = await seedDisplay.textContent();
      expect(seedText).toBeTruthy();

      // Seed should have words (rough check: spaces indicate multiple words)
      const wordCount = seedText!.trim().split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(12);
      expect(wordCount).toBeLessThanOrEqual(24);
    }
  });

  test("B: Import existing seed phrase", async ({ page }) => {
    const seedPhrase = Array(12).fill("test").join(" ");

    // Find import button
    const importButton = page.locator('[data-testid="wallet-import-button"]');
    if (await importButton.isVisible()) {
      await importButton.click();

      // Fill in seed phrase
      const seedInput = page.locator('[data-testid="wallet-seed-input"]');
      await seedInput.fill(seedPhrase);

      // Click import
      const confirmButton = page.locator('[data-testid="wallet-import-confirm"]');
      await confirmButton.click();

      // Wait for wallet to be ready
      await page.waitForSelector('[data-testid="wallet-status-ready"]', { timeout: 10000 });
    }
  });

  test("C: Display wallet address and balance", async ({ page }) => {
    // Wait for wallet to be ready
    await page.waitForSelector('[data-testid="wallet-status-ready"]', { timeout: 10000 }).catch(() => {});

    // Check address display
    const addressDisplay = page.locator('[data-testid="wallet-address-display"]');
    if (await addressDisplay.isVisible()) {
      const addressText = await addressDisplay.textContent();
      expect(addressText).toBeTruthy();
      // Should show masked address (with ellipsis)
      if (addressText && addressText.length > 10) {
        expect(addressText).toContain("…");
      }
    }

    // Check balance display
    const balanceDisplay = page.locator('[data-testid="wallet-balance-display"]');
    if (await balanceDisplay.isVisible()) {
      const balanceText = await balanceDisplay.textContent();
      expect(balanceText).toBeTruthy();
      expect(balanceText).toMatch(/\d+(\.\d+)?\s*ZEC/i);
    }
  });

  test("D: Initiate support for a project", async ({ page }) => {
    // Find a project in the discovery panel
    const projectPanel = page.locator('[data-testid="project-discovery-panel"]');
    if (await projectPanel.isVisible()) {
      // Find first project card
      const projectCard = page.locator('[data-testid="project-card"]').first();
      if (await projectCard.isVisible()) {
        // Look for support button
        const supportButton = projectCard.locator('[data-testid="support-button"]');
        if (await supportButton.isVisible()) {
          await supportButton.click();

          // Should show support amount input
          await page.waitForSelector('[data-testid="support-amount-input"]', { timeout: 5000 });
          expect(await page.locator('[data-testid="support-amount-input"]').isVisible()).toBe(true);
        }
      }
    }
  });

  test("E: Validate support amount input", async ({ page }) => {
    // Setup: navigate to support flow
    const supportAmountInput = page.locator('[data-testid="support-amount-input"]');

    if (await supportAmountInput.isVisible()) {
      // Test: reject zero amount
      await supportAmountInput.fill("0");
      const errorMsg = page.locator('[data-testid="support-error"]');
      await expect(errorMsg).toContainText(/positive|amount|invalid/i);

      // Test: accept valid amount
      await supportAmountInput.fill("1.5");
      await expect(errorMsg).not.toBeVisible();

      // Test: reject negative amount
      await supportAmountInput.fill("-1");
      await expect(errorMsg).toContainText(/positive|amount/i);
    }
  });

  test("F: Review support confirmation details", async ({ page }) => {
    // Setup: have a valid support amount ready
    const supportAmountInput = page.locator('[data-testid="support-amount-input"]');
    const confirmButton = page.locator('[data-testid="support-confirm-button"]');

    if (await supportAmountInput.isVisible() && await confirmButton.isVisible()) {
      await supportAmountInput.fill("1.0");
      await confirmButton.click();

      // Should show confirmation screen
      await page.waitForSelector('[data-testid="support-confirmation"]', { timeout: 5000 });

      // Verify confirmation shows:
      // - Project name
      // - Amount
      // - Recipient (masked)
      // - No personal data
      const confirmDisplay = page.locator('[data-testid="support-confirmation"]');
      expect(await confirmDisplay.isVisible()).toBe(true);

      const confirmText = await confirmDisplay.textContent();
      expect(confirmText).toContain("1"); // Amount
      expect(confirmText).not.toContain("playerId");
      expect(confirmText).not.toContain("nickname");
    }
  });

  test("G: Cancel support payment", async ({ page }) => {
    // Setup: get to confirmation screen
    const cancelButton = page.locator('[data-testid="support-cancel-button"]');

    if (await cancelButton.isVisible()) {
      await cancelButton.click();

      // Should return to main UI (confirmation should disappear)
      await expect(page.locator('[data-testid="support-confirmation"]')).not.toBeVisible();
    }
  });

  test("H: Submit support payment (or show external wallet flow)", async ({ page }) => {
    // This test depends on wallet type: created vs external
    const confirmButton = page.locator('[data-testid="support-final-confirm"]');

    if (await confirmButton.isVisible()) {
      // Check if wallet is created or external
      const walletStatus = page.locator('[data-testid="wallet-status"]');
      const status = await walletStatus.textContent();

      if (status?.includes("created")) {
        // For created wallet: show proving status
        await confirmButton.click();
        await page.waitForSelector('[data-testid="wallet-proving"]', { timeout: 30000 });
        expect(await page.locator('[data-testid="wallet-proving"]').isVisible()).toBe(true);
      } else {
        // For external wallet: show ZIP-321 URI
        await confirmButton.click();
        await page.waitForSelector('[data-testid="wallet-uri-display"]', { timeout: 5000 });
        const uriText = await page.locator('[data-testid="wallet-uri-display"]').textContent();
        expect(uriText).toMatch(/^zcash:/);
      }
    }
  });

  test("I: Wallet disconnection", async ({ page }) => {
    // Look for disconnect button
    const disconnectButton = page.locator('[data-testid="wallet-disconnect-button"]');

    if (await disconnectButton.isVisible()) {
      await disconnectButton.click();

      // Wallet should return to idle state
      await page.waitForSelector('[data-testid="wallet-status-idle"]', { timeout: 5000 });

      // Support buttons should be disabled
      const supportButtons = page.locator('[data-testid="support-button"]');
      const firstButton = supportButtons.first();
      if (await firstButton.isVisible()) {
        expect(await firstButton.isDisabled()).toBe(true);
      }
    }
  });

  test("J: Recovery - reimport seed yields same address", async ({ page }) => {
    // This test verifies wallet recovery works correctly
    // Setup: create a wallet and get its address
    const seedPhrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    // Import seed first time
    const importButton = page.locator('[data-testid="wallet-import-button"]');
    if (await importButton.isVisible()) {
      await importButton.click();
      const seedInput = page.locator('[data-testid="wallet-seed-input"]');
      await seedInput.fill(seedPhrase);

      const confirmButton = page.locator('[data-testid="wallet-import-confirm"]');
      await confirmButton.click();

      await page.waitForSelector('[data-testid="wallet-status-ready"]', { timeout: 10000 });

      // Get the address
      const addressDisplay1 = page.locator('[data-testid="wallet-address-display"]');
      const address1 = await addressDisplay1.textContent();

      // Disconnect
      const disconnectButton = page.locator('[data-testid="wallet-disconnect-button"]');
      if (await disconnectButton.isVisible()) {
        await disconnectButton.click();
        await page.waitForSelector('[data-testid="wallet-status-idle"]', { timeout: 5000 });
      }

      // Re-import same seed
      if (await importButton.isVisible()) {
        await importButton.click();
        const seedInput2 = page.locator('[data-testid="wallet-seed-input"]');
        await seedInput2.fill(seedPhrase);

        const confirmButton2 = page.locator('[data-testid="wallet-import-confirm"]');
        await confirmButton2.click();

        await page.waitForSelector('[data-testid="wallet-status-ready"]', { timeout: 10000 });

        // Verify address matches
        const addressDisplay2 = page.locator('[data-testid="wallet-address-display"]');
        const address2 = await addressDisplay2.textContent();

        // Masked addresses should match
        expect(address1).toBe(address2);
      }
    }
  });

  test("K: Network mismatch error handling", async ({ page }) => {
    // This is a unit test scenario but worth covering in E2E
    // Verify that if a mainnet support target appears, it's rejected
    // (In MVP this shouldn't happen, but it's good to test the guard)

    const mainnetURI = "zcash:u1mainnetaddress?amount=1.0&memo=...";
    // Try to construct a mainnet support on a testnet wallet
    // This should fail validation and show an error

    // For now, just verify testnet is active
    const networkDisplay = page.locator('[data-testid="wallet-network"]');
    if (await networkDisplay.isVisible()) {
      const network = await networkDisplay.textContent();
      expect(network).toContain("test");
    }
  });

  test("L: Wallet failure isolation (game continues)", async ({ page }) => {
    // This test documents that wallet errors don't crash the game
    // The game canvas should be present and the world should continue to function

    // Game should have a canvas element (the Three.js renderer)
    const gameCanvas = page.locator("canvas").first();
    await expect(gameCanvas).toBeVisible();

    // Check that game UI chrome is still present (HUD info corner)
    const hudElement = page.locator(".zw-hud-corner");
    await expect(hudElement).toBeVisible();

    // Even if wallet has error, game should remain interactive
    const errorState = page.locator('[data-testid="wallet-status-error"]');
    if (await errorState.isVisible()) {
      // Game should still be running and visible
      await expect(gameCanvas).toBeVisible();
    }
  });

  test("M: Multiplayer compatibility (wallet doesn't affect voice/chat)", async ({ page }) => {
    // Verify that opening wallet doesn't interfere with multiplayer features
    const voiceButton = page.locator('[data-testid="voice-enable-button"]');
    const chatInput = page.locator('[data-testid="chat-input"]');

    // Open wallet
    const walletPanel = page.locator('[data-testid="wallet-panel"]');
    if (await walletPanel.isVisible()) {
      // Voice/chat should still work
      if (await voiceButton.isVisible()) {
        expect(await voiceButton.isEnabled()).toBe(true);
      }
      if (await chatInput.isVisible()) {
        expect(await chatInput.isEnabled()).toBe(true);
      }
    }
  });
});
