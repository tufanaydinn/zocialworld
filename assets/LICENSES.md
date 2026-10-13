# Asset License Registry

Every third-party asset is recorded here, and in `asset-registry.json`, with its exact licence before it enters
the repository. No external model or texture is used if its licence is unclear. The licence terms for the
repository as a whole (code, original artwork, third-party assets) are summarised in
[ART_AND_ASSETS_LICENSE.md](ART_AND_ASSETS_LICENSE.md).

## This tree vs. `apps/web/public/assets/`

This `assets/` directory (repository root) is the **licence-record** tree: the asset registry
(`asset-registry.json`) and the verbatim licence texts (`licenses/`). It holds no models or textures.

`apps/web/public/assets/` is the **runtime-served** tree that Vite bundles into the web client. Only files that
have cleared licence review and optimization land there.

## Third-party model packs

The client loads a curated library of **613 files from 8 packs, all CC0-1.0**, from
`apps/web/public/assets/<category>/<pack>/`. `asset-registry.json` records, per pack: creator, source URL, exact
version or commit, licence, the pinned download (a Kenney archive with its SHA-256, or a KayKit repository at a fixed
commit), modification notes, and every file with its upstream path, size and SHA-256. A verbatim copy of each pack's
licence text is kept in `assets/licenses/<pack id>.txt`. A content provider can use further packs: it lists them in
an `asset-registry.json` of its own in the same format, with the same licence rules and a verbatim licence copy
next to its content module, and `npm run assets:fetch` and the dev server read that file together with this registry
when it is present.

The packs do not have to be committed. `npm run assets:fetch` (`scripts/assets/fetch.mjs`) downloads them from the
pinned sources and writes a file only when its SHA-256 matches the registry; `npm run assets:fetch -- --check`
verifies what is on disk. `apps/web/.gitignore` ignores the pack folders, so fetched files are never added by
accident (ignore rules do not affect files that are already tracked; a new pack is added with `git add -f`). Without
the packs the client runs on its procedural placeholders: the dev server and the build list the complete packs, and
the asset manager never requests a file of a missing one.

| Pack | Creator | Version | License | Local folder | Modified |
| --- | --- | --- | --- | --- | --- |
| Fantasy Town Kit | Kenney | 2.0 | CC0-1.0 | `environment/kenney-fantasy-town/` | no |
| Nature Kit | Kenney | 2.1 | CC0-1.0 | `environment/kenney-nature/` | no |
| Castle Kit | Kenney | 2.0 | CC0-1.0 | `environment/kenney-castle/` | no |
| Dungeon Remastered | Kay Lousberg (KayKit) | git `b0ca9bd` | CC0-1.0 | `props/kaykit-dungeon/` | renamed `.gltf.glb` → `.glb` only |
| Restaurant Bits | Kay Lousberg (KayKit) | git `153c8a7` | CC0-1.0 | `props/kaykit-restaurant/` | no |
| Halloween Bits (non-spooky subset) | Kay Lousberg (KayKit) | git `6dc69bf` | CC0-1.0 | `props/kaykit-halloween/` | no |
| Medieval Hexagon Pack (props, blue buildings, walls, mountains, hills, trees) | Kay Lousberg (KayKit) | git `84fa4e9` | CC0-1.0 | `props/kaykit-medieval/` | no (the grass colour is changed by a shader at runtime) |
| Character Pack: Adventures | Kay Lousberg (KayKit) | git `672074b` | CC0-1.0 | `characters/kaykit-adventures/` | yes — held props removed, clips pruned (`scripts/assets/process-characters.mjs`) |

The five characters are rebuilt from the pack's original GLB files by `scripts/assets/process-characters.mjs`, which
removes the weapons, shields and mugs the characters hold and keeps the eleven clips the game plays. The fetch step
runs it and checks the result against `fetchedSha256`. The hosted build's character files were made with the same
pruning followed by glTF-Transform 4.5.1 `resample` and `quantize`; the registry's `sha256` records those files.

Everything else in the world (terrain, paving, stairs, signs, banners, awnings, bunting, sky, glow sprites) is
procedural geometry or canvas textures generated in code — no files, no licence surface.

## Adding an asset

Every entry follows the schema in `asset-registry.json` and includes, at minimum: id, file, creator, source URL,
exact licence string, whether it was modified, where it is used, and any notes (for example "reduced texture to
512px"). A verbatim copy of the licence goes into `licenses/`. Candidate sources:

- **Quaternius** (quaternius.com) — verify the licence of each downloaded pack; many are CC0, not all.
- **Poly Pizza** (poly.pizza) — a catalogue of many creators under different licences; verify per asset, never
  assume CC0 site-wide.
- **Kenney**, **OpenGameArt**, or a repository with an explicit, compatible licence.

Reject any candidate whose licence is not certain.

## Original Zocial World artwork

The original Zocial World artwork and logos used by the hosted deployment are **all rights reserved** and are not
in this repository. They are not covered by the code licence. See
[ART_AND_ASSETS_LICENSE.md](ART_AND_ASSETS_LICENSE.md).
