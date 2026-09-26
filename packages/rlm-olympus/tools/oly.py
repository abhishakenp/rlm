#!/usr/bin/env python3
import json, sys, os, urllib.request
TOKEN = json.load(open(os.path.expanduser("~/.shipd/olympus/credentials.json")))["token"]
BASE = "https://academic-jellyfish-943.convex.cloud/api"
def call(kind, path, args):
    req = urllib.request.Request(f"{BASE}/{kind}",
        data=json.dumps({"path": path, "args": args, "format": "json"}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)
if __name__ == "__main__":
    kind = sys.argv[1]          # query | mutation | action
    path = sys.argv[2]
    args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    print(json.dumps(call(kind, path, args), indent=2))
