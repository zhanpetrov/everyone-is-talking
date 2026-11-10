"""Build data/stations.json from the research tables (tables.json) and resolved YouTube channel ids."""
import json, sys, hashlib, collections

tables, uc_ids, out = sys.argv[1], sys.argv[2], sys.argv[3]
t = json.load(open(tables, encoding="utf-8"))
uc = json.load(open(uc_ids, encoding="utf-8"))

LEVEL = {"Местный": 0, "Региональный": 1, "Национальный": 2}
TYPE = {
    "Законодательный или выборный орган": "room",
    "Госорган / международная организация": "room",
    "Политическое медиа / подкаст / шоу": "show",
    "Новостной канал": "news",
    "Аналитический центр": "tank",
    "Партия / движение": "party",
}


def h(s):
    return hashlib.md5(s.encode()).hexdigest()


bands = {"rooms": [], "voices": [], "wire": []}
for r in t["rows"]:
    ty = TYPE[r["type"]]
    s = {
        "id": r["record_id"],
        "n": r["name"],
        "c": r["country_iso"],
        "t": ty,
        "yt": uc.get(r["youtube_url"], ""),
        "u": r["website_url"] or r["primary_url"],
    }
    if ty == "room":
        s["lv"] = 3 if r["country_iso"] == "INT" else LEVEL.get(r["level"], 2)
        bands["rooms"].append(s)
    elif r["left_right"]:
        s["lr"] = r["left_right"][0]
        bands["voices"].append(s)
    else:
        bands["wire"].append(s)

# stable shuffle inside each segment so one country never fills a long stretch of the dial
bands["rooms"].sort(key=lambda s: (s["lv"], h(s["id"])))
bands["voices"].sort(key=lambda s: (s["lr"] != "L", h(s["id"])))
bands["wire"].sort(key=lambda s: h(s["id"]))

json.dump(bands, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
for k, v in bands.items():
    print(k, len(v), "playable", sum(1 for s in v if s["yt"]), collections.Counter(s.get("lv", s.get("lr", "")) for s in v))
print("countries", sorted(collections.Counter(s["c"] for v in bands.values() for s in v).items(), key=lambda x: -x[1])[:8], "no-iso", sum(1 for v in bands.values() for s in v if len(s["c"]) != 2))
