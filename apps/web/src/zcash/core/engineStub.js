// Stand-in for the wallet engine in test-network builds made without the engine binary (see walletEngine in
// apps/web/vite.config.ts). It has the engine module's shape — a default init, initThreadPool and WebWallet — and
// every use fails with the coded error `engine_not_installed`. A production build copies this file verbatim to
// dist/webzjs/webzjs_wallet.js, so it is plain browser JavaScript.

const MESSAGE = "engine_not_installed: this build was made without the wallet engine binary";

function notInstalled() {
  const error = new Error(MESSAGE);
  error.code = "engine_not_installed";
  return error;
}

console.warn(`[wallet] ${MESSAGE}`);

export default async function init() {
  throw notInstalled();
}

export async function initThreadPool() {
  throw notInstalled();
}

export class WebWallet {
  constructor() {
    throw notInstalled();
  }
}
