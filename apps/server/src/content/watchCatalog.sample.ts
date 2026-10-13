import { parseWatchCatalog, type WatchCatalog, type WatchCatalogJson } from "./watchCatalogTypes.js";

/**
 * The sample Watch Hall catalogue, used when the server has no catalogue file (`WATCH_CATALOG_FILE`, see
 * `watchCatalogFile.ts`): one channel, one collection of two replays (its playlist feeds newer entries when
 * YouTube can be reached) and one weekly meetup in the Watch Hall itself. A catalogue file has the same shape.
 */
export const SAMPLE_WATCH_CATALOG_JSON: WatchCatalogJson = {
  sources: [
    { label: "Videos", text: "YouTube — ZecHub" },
    { label: "Schedule", text: "the sample catalogue" },
  ],
  channels: [{ id: "UC3-KM00kjCUheRzO5cq3PAA", title: "ZecHub" }],
  collections: [
    {
      id: "zechub-updates",
      title: "ZecHub Updates",
      channel: "UC3-KM00kjCUheRzO5cq3PAA",
      description: "ZecHub's bi-weekly round-up of the Zcash ecosystem.",
      playlistId: "PL6_epn0lASLFIbdwJYeFu9aBiOtuu8TES",
      active: true,
      videos: [
        { id: "tpdiOjxvLt4", title: "ZecHub Updates | September 15, 2026", publishedAt: "2026-09-21T13:04:28Z", durationSec: 1931 },
        { id: "kmEKYbIVsMg", title: "ZecHub Updates | 1 September, 2026", publishedAt: "2026-09-04T14:37:54Z", durationSec: 2213 },
      ],
    },
  ],
  recurringEvents: [
    {
      id: "hall-meetup",
      title: "Watch Hall meetup",
      summary: "A weekly get-together in the Watch Hall: watch a replay together and talk about it afterwards.",
      start: "2026-01-03T18:00:00Z",
      durationMin: 60,
      rrule: "FREQ=WEEKLY;BYDAY=SA",
      where: "hall",
      location: "Watch Hall",
      joinUrl: "",
    },
  ],
  calendars: [],
  curatedEvents: [],
};

export const SAMPLE_WATCH_CATALOG: WatchCatalog = parseWatchCatalog(SAMPLE_WATCH_CATALOG_JSON);
