# Roadmap

What is built, what is being worked on and what is planned, by theme. The order within a list is not a
commitment, and no dates are announced except where noted.

## Done

**World and movement**
- Three.js client with a third-person camera, movement, collision and a generic interaction system
- Several locations in one shared coordinate space, reached through portals and doors
- Render tiers with adaptive quality, a point-light pool and an instanced low-tier crowd
- A content seam that keeps systems apart from world content, with a sample world for development

**Social**
- Multiplayer presence with interpolation and automatic reconnect
- Chat: general, nearby and whispers, with rate limits and speech bubbles
- Wallet holders and guests, onboarding with character and name, owned names confirmed by a small
  shielded fee
- Emote wheel, player menu, local mute and block
- Reporting and moderation tools

**Voice and Watch Hall**
- Proximity voice through a self-hosted LiveKit SFU, with push-to-talk, open mic and voice ranges
- The Watch Hall: stage screen sharing with tab audio, a listen-only watch mode without a wallet, seats,
  reactions, raise hand, the floor and a speaker card
- Schedule, live streams and replays

**Learning and community**
- Learning Valley framework: LEARN → SEE → TRY → PROVE, quizzes with question pools, prerequisites, gates,
  interactive visualizers, local-only progress
- Community hub: the Zcash Community Forum, the ZecHub wiki and project pages, read in game through a
  read-only gateway
- Project discovery with booths, and support for a project with shielded ZEC from its page once the
  operator configures the project's recipient address

**Zcash wallet**
- In-game shielded wallet: create with a backup check, import, receive, send, withdraw
- Private player-to-player payments with sealed addresses
- Mainnet beta: Sapling and Ironwood pools, a 0.01 ZEC cap per transaction, explicit
  consent, and an update prompt for network upgrades

## In progress

- Wider testing of the hosted mainnet wallet beta
- More Learning Valley modules
- Performance measurements on a wider range of real GPUs
- Publishing the wallet engine build scripts

## Planned

- NU7 support after the network upgrade
- Mobile and touch controls
- Contact and collaboration features for project builders
- An independent privacy review and security audit of the wallet before any public, non-invited release
- Interest management for larger player counts
- More districts and a visual production pass
- Cross-browser hardening
