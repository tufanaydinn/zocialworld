# Security Policy

## Reporting Security Issues

Please report security vulnerabilities responsibly and privately.

**Do not open a public issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting feature:
1. On this repository, go to **Security** → **Report a vulnerability**
2. Provide details of the vulnerability
3. We will respond and work with you on a fix

Alternatively, if your GitHub account has not yet enabled this feature, contact the maintainers privately through GitHub's security advisory system.

## Scope

Security issues covered:
- Multiplayer presence relay (unintended information disclosure)
- Voice transport (IP exposure, unauthorized access)
- Social identity (nickname injection, XSS)
- Wallet integration (when implemented) — especially shielded ZEC privacy, seed/key exposure

## Guidelines

- **Do not disclose wallet/key vulnerabilities publicly** before responsible disclosure is complete
- **Do not include private keys, seeds, credentials, or real wallet addresses** in bug reports — use generic examples
- **Experimental wallet functionality** in this early prototype must never be used with meaningful funds unless explicitly documented as production-ready
- **Timeline:** We aim to acknowledge receipt within 48 hours and provide an update within 7 days

## Security Considerations

This is an **early prototype**. See `docs/privacy/PRIVACY_MODEL.md` for complete threat models of each system and what is/isn't protected.

- **Multiplayer:** No authentication; all identities are temporary and session-scoped
- **Voice:** Self-hosted LiveKit SFU (not peer-to-peer); see ADR-003
- **Wallet:** Not yet implemented; future integration will require additional threat modeling

## No Rewards Program

This project does not currently offer a bug bounty or rewards program. We appreciate responsible disclosure and will credit security researchers in advisories.
