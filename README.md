# Everyone Is Talking

A radio dial for the world's political speech. A prototype built on a film research registry of
1,456 political broadcasts: town councils, regional assemblies, national parliaments, political
shows, news channels and think tanks.

Turn the dial and you land in the middle of a real room.

## Bands

- **Rooms**: chambers, ordered from town to region to nation to world bodies.
- **Voices**: shows and outlets, ordered left to right. The labels come from the research
  registry and have not been independently reviewed.
- **Wire**: news channels, think tanks and shows without a left or right label.

A lit tick has a verified YouTube channel. A dim tick is a dark station: the room exists, but no
channel could be verified.

## How it works

Plain static site, no build step: `index.html`, `styles.css`, `app.js`, `data/stations.json`.

Each station plays from that body's own YouTube channel through the YouTube IFrame player.
Chambers try the channel's live-stream list first, then long-form uploads. Nothing is re-hosted.

`scripts/build_stations.py` rebuilds `data/stations.json` from the research tables:

    python3 scripts/build_stations.py tables.json uc_ids.json data/stations.json

## Run locally

    python3 -m http.server 8092

The page is marked `noindex` and is meant to be shared by link.
