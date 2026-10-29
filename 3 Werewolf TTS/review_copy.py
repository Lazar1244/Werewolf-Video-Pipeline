"""Copy a character's current situation takes to output/_review/<name>/ under fresh, numbered names and print a table."""
import json, os, shutil, sys
name = sys.argv[1]
c = json.load(open(f"characters/{name}.json", encoding="utf-8"))
log = {json.loads(l)["no"]: json.loads(l) for l in open(f"takes/{name}/log.jsonl", encoding="utf-8")}
desc = next(x["description"] for x in c["candidates"] if x["voice"] == c["voice"])
out = f"output/_review/{name}"
shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
print(f"{name}: {desc}")
for sid, a in sorted(c["approved"].items(), key=lambda kv: kv[1]["folder"]):
    d = a["folder"]; wav = [f for f in os.listdir(d) if f.endswith(".wav")][0]
    num = os.path.basename(d)[:2]
    dst = os.path.join(out, f"{num} take{a['take']} - {wav}")
    shutil.copy(os.path.join(d, wav), dst)
    print(f"{num}|{os.path.basename(d)[3:]}|{log[a['take']]['style'] or '(none)'}|{os.path.abspath(dst)}")
