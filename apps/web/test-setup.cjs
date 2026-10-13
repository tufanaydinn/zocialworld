// Portable test setup — sets environment variables and initializes test APIs before tests run
// This works across Windows, macOS, and Linux (no shell-specific syntax)

process.env.VITE_ZCASH_NETWORK = process.env.VITE_ZCASH_NETWORK || "test";

// Initialize fake-indexeddb for Node.js test environment
// Allows tests to exercise wallet DB persistence without browser APIs
require("fake-indexeddb/auto");
