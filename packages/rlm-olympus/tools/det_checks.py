import re, sys
desc=open('description.txt').read().strip()
title="Add chi-square and contingency table association measures"
patch=open('test.patch').read()
ok=True
def chk(name, passed, detail=""):
    global ok
    print(("PASS  " if passed else "FAIL  ")+name+(("  -- "+detail) if detail else ""))
    if not passed: ok=False

# 1. word count: pass <=500, warn >500, fail >1000  (counts title + description)
w=len((title+" "+desc).split())
chk(f"description_length ({w} words; target 100-200, pass<=500)", w<=500, f"{w} words")

# 2. AI-generated tells: hard wrap 70-85 chars, em-dashes, wall-of-text, 4+ blank lines
lines=desc.split("\n")
body=[l for l in lines if l.strip()]
wrapped=sum(1 for l in body if 70<=len(l)<=85)
emd=desc.count("—")
blankruns=max([len(m.group(0).split("\n"))-1 for m in re.finditer(r"\n{2,}", desc)] or [0])
chk("ai_tells_line_wrapping", wrapped==0, f"{wrapped} lines wrapped 70-85 chars")
chk("ai_tells_em_dashes", emd==0, f"{emd} em-dashes")
chk("ai_tells_blank_runs", blankruns<4, f"max blank run {blankruns}")

# 3. valid UTF-8 / printable ASCII
bad=[(i,repr(c)) for i,c in enumerate(desc) if ord(c)>126 or (ord(c)<32 and c!="\n")]
chk("valid_utf8_printable", not bad, str(bad[:3]))

# 4. no URLs
urls=re.findall(r'https?://\S+', desc)
chk("no_urls_in_description", not urls, str(urls))

# 5. unified diff structural validation (their described regex rules)
has_diff_hdr = bool(re.search(r'^diff --git ', patch, re.M))
has_file_hdr = bool(re.search(r'^--- ', patch, re.M)) and bool(re.search(r'^\+\+\+ ', patch, re.M))
has_hunk     = bool(re.search(r'^@@ .* @@', patch, re.M))
badlines=[]
inhunk=False
for ln in patch.split("\n"):
    if ln.startswith("@@"): inhunk=True; continue
    if ln.startswith("diff --git") or ln.startswith("--- ") or ln.startswith("+++ ") or ln.startswith("index ") or ln.startswith("new file mode") or ln.startswith("old mode") or ln.startswith("new mode"):
        inhunk=False; continue
    if inhunk and ln and ln[0] not in " +-\\":
        badlines.append(ln[:60])
chk("valid_test_patch_diff_headers", has_diff_hdr and has_file_hdr and has_hunk)
chk("valid_test_patch_hunk_lines", not badlines, str(badlines[:3]))

# 6. banned markers anywhere in patch or description
banned=[m for m in ["shipd","datacurve","olympus","quest","challenge","mars"] if re.search(r"\b"+m+r"\b", patch+desc, re.I)]
chk("no_banned_markers", not banned, str(banned))

print()
print("DETERMINISTIC RESULT:", "ALL PASS" if ok else "FAILURES PRESENT")
