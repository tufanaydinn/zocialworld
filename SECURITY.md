# Security Policy

## Reporting security issues

Please report security vulnerabilities responsibly and privately.

**Do not open a public issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting feature:
1. On this repository, go to **Security** → **Report a vulnerability**
2. Provide details of the vulnerability
3. We will respond and work with you on a fix

Alternatively, if your GitHub account has not yet enabled this feature, contact the maintainers privately
through GitHub's security advisory system.

## Scope

Security issues covered:
- Multiplayer presence relay and chat (unintended information disclosure, injection)
- Voice and screen sharing (IP exposure, unauthorized access, unauthorized publishing)
- Social identity and owned names (impersonation, nickname injection, XSS)
- The in-game Zcash wallet and player payments: shielded privacy, seed and key exposure, address
  disclosure, fee and payment verification
- The community content gateway (unsafe content, SSRF)
- Moderation tools (privilege escalation, bypass)

## Guidelines

- **Do not disclose wallet or key vulnerabilities publicly** before responsible disclosure is complete.
- **Do not include private keys, seeds, credentials or real wallet addresses** in bug reports. Use generic
  examples.
- **The wallet is an experimental, unaudited beta.** Do not use it with meaningful funds. The hosted beta
  caps each transaction at 0.01 ZEC.
- **Timeline:** we aim to acknowledge receipt within 48 hours and provide an update within 7 days.

## Security considerations

See [docs/privacy/PRIVACY_MODEL.md](docs/privacy/PRIVACY_MODEL.md) for the privacy model and the threat
model of each system, including what is and is not protected.

- **Multiplayer:** guests have temporary, session-scoped identities. Wallet holders can confirm an owned
  name with a small shielded fee; the server never learns the payer's address.
- **Voice:** a self-hosted LiveKit SFU, not peer-to-peer
  ([ADR-007](docs/decisions/ADR-007-proximity-voice-transport.md)).
- **Wallet:** keys stay in the player's browser; the game server relays chain access so the
  lightwalletd operator does not see player IP addresses
  ([ZCASH_WALLET_THREAT_MODEL.md](docs/privacy/ZCASH_WALLET_THREAT_MODEL.md)).

## No rewards program

This project does not currently offer a bug bounty or rewards program. We appreciate responsible
disclosure and will credit security researchers in advisories.
