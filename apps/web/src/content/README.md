# Content providers

The client separates **systems** (rendering, movement, collision, networking, voice, the Watch Hall and
learning logic) from **content** (the locations a player walks through, the travel destinations, the
Watch Hall layout, the lessons and the scene's atmosphere). Systems never import content. The composition root (`core/App.ts`) resolves one
content provider and hands its parts to the systems that need them.

## Resolution

`core/App.ts` imports the bare specifier `@zw/content`:

| Tool | How `@zw/content` resolves |
|---|---|
| TypeScript (`tsc --noEmit`) | `tsconfig.json` `paths` lists `content/production/index.ts`, then `content/sample/index.ts`; the first file that exists wins. |
| Vite (dev server and build) | `contentEntry` in `vite.config.ts`: the production index when it exists, else the sample index. `ZW_CONTENT=sample` forces the sample; `ZW_CONTENT=production` fails the build when the production content is missing. |
| Unit tests | Tests never import `@zw/content`. They import the module under test and build small fixtures (see `world/World.test.ts`). |

The official hosted experience adds its own content under `content/production/`, which is maintained
separately. Without that directory everything resolves to the sample content, so a plain checkout
typechecks, builds and runs. `?world=prototype` shows the sample content in any build.

`content/seam.test.ts` keeps the seam honest: nothing outside `content/production/` imports it, and only
`core/App.ts` imports `@zw/content`.

## What a provider supplies

`types.ts` defines `ContentProvider`:

- `locations()` — `LocationModule`s (`world/LocationModule.ts`), at most one per slot of the shared
  coordinate space (`world/locations.ts`: the central slot around the origin, the east slot at
  x = +1000, the west slot at x = −1000). A module builds its location into a scene group, registers its
  colliders and interactables, and reports its ground height, spawn point, minimap and optional
  capabilities (a project board anchor, live community boards, a Watch Hall).
- `defaultLocation` — the slot a new player spawns in.
- `destinations` — portal and door destinations (`world/destinations.ts`). A content with a Watch Hall
  lists `watch-hall` and `watch-hall-exit` (`world/hall/contract.ts`), the ids the app travels to.
- `hallLayout` — the `HallLayout` (`world/hall/hallGeometry.ts`) of the hall that the module in the west
  slot builds: seats, stage, screen, podium, boards, floor heights, colliders and minimap. Leave it out
  when the content has no hall. `docs/architecture/WATCH_HALL.md` describes the contract.
- `lessonCatalog` — the lessons (`learning/catalog.ts`: `LessonCatalog`) the Learning panel offers and
  the progress store tracks, with their tier and zone labels, planned modules, gates and the directory's
  intro line. `validateCatalog` checks the rules every catalogue keeps (unique ids, known and acyclic
  prerequisites, answerable quizzes, a TRY step behind every simulation proof, labelled zones, quiz gates).
- `visualizers` — the interactive SEE and TRY views the lessons name, by id. `learning/visualizers/basics.ts`
  exports `BASIC_VISUALIZERS` (ZEC facts, transparent vs shielded, the block-chain and hash labs, the
  transaction lab); a content can add its own.
- `createAtmosphere(scene, quality)` — the sky, fog and global lights, and the rig World drives as the
  active location changes.
- `riggedAvatars` — whether players appear as the rigged character models on the high render tier.

A built location may also publish named **anchors** (`BuiltLocation.anchors`; the names are in
`debug/anchors.ts`), such as `projects.board`, `projects.booth` and `hall.door`. The hall's anchors
(`hall.arrival`, `hall.floor`, `hall.podium`, `hall.discussion`, ...) come from its `HallLayout`. DEV and
`VITE_TEST_HOOKS` builds expose the merged map as `window.__anchors`, and the end-to-end tests stand players
there, so the same spec runs on any content that publishes the anchors it needs.

## The sample content

`sample/` needs no external assets:

- the prototype plaza (`world/PrototypePlaza.ts`, `sample/plaza.ts`) in the central slot: primitive
  geometry with a fountain, placeholder buildings, trees, lanterns, the project board and a few project
  booths, under a warm golden-hour light; the door of the left-hand building leads into the hall;
- a small Watch Hall in the west slot (`sample/hall.ts`, `sample/hallLayout.ts`): a box room with a low
  stage, the big screen, the speaker-card strip, a podium, the Live Now and Discussion Corner boards and
  one row of four seats, so the stage, seats, boards, hall voice and `?perf=hall60` can be tried. The
  Watch panel's "Go to hall" travels there;
- three lessons (`sample/sampleCurriculum.ts`): a quiz lesson, a simulation lesson on the block-chain lab
  and a small gate quiz. Their text follows the ZecHub wiki and is under CC BY-SA 4.0, separate from the
  code licence; each lesson names its source. The sample world has no lesson stations, so the lessons
  open from a station a location adds, or from the Learning panel directly;
- a small house spec for `world/district/ModularBuilding.ts` (`sample/building.ts`), the shape a location
  uses to place modular buildings from the Fantasy Town kit.

To try a location of your own, add a `LocationModule` for a free slot and list it in
`sample/index.ts`.
