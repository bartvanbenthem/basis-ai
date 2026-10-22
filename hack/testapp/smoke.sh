#!/usr/bin/env bash
# End-to-end check of a GenAIStack through BASIS Lens: every part of the
# stack, the way an app uses it.
#
#   1. status: the database, the cache (with valkey-search) and the gateway answer
#   2. a library: sample photos loaded (vision model + multimodal embeddings, pgvector)
#   3. a photo of its own: added, captioned and tagged; the same bytes again are a duplicate
#   4. search by image: that photo finds itself first
#   5. search by text: results; the same words again are an exact cache hit,
#      a paraphrase a semantic one (valkey-search KNN)
#   6. more like this, and a question about a photo (then cached)
#   7. metrics; the photo of its own is deleted again
#
#   ./smoke.sh <base URL>      e.g. http://<LoadBalancer IP> (make url)
# Exits non-zero on a failure; without a cache (make run) the cache checks are skipped.
set -euo pipefail

BASE=${1:?base URL, e.g. http://203.0.113.10}
if [ -t 1 ]; then G=$'\033[32m' R=$'\033[31m' Y=$'\033[33m' N=$'\033[0m'; else G= R= Y= N=; fi
FAILS=0
pass() { printf "  ${G}PASS${N}  %s\n" "$*"; }
fail() { printf "  ${R}FAIL${N}  %s\n" "$*"; FAILS=$((FAILS + 1)); }
skip() { printf "  ${Y}SKIP${N}  %s\n" "$*"; }
# j <file> <python expression on d>
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT
get() { curl -sS -m 300 -o "$1" -w '%{http_code}' "${BASE}$2"; }
post() { local out=$1 path=$2; shift 2; curl -sS -m 300 -o "${out}" -w '%{http_code}' -X POST "${BASE}${path}" "$@"; }
search() { get "$1" "/api/search?q=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$2")${3:-}"; }

echo "== ${BASE}"
get "${tmp}/status" /api/status >/dev/null || { fail "app unreachable"; exit 1; }
echo "   site $(j "${tmp}/status" 'd["site"]'), $(j "${tmp}/status" '"active" if d["active"] else "standby"'), $(j "${tmp}/status" 'd["visionModel"]') + $(j "${tmp}/status" 'd["embedModel"]')"
for c in database cache gateway; do
  if [[ "$(j "${tmp}/status" "d['$c']['ok']")" == True ]]; then pass "$c: $(j "${tmp}/status" "d['$c']['detail']")"
  elif [[ "$c" == cache && "$(j "${tmp}/status" "d['$c']['detail']")" == "VALKEY_HOST not set" ]]; then skip "cache: none (running outside the location)"
  else fail "$c: $(j "${tmp}/status" "d['$c']['detail']")"; fi
done
cache=$(j "${tmp}/status" 'd["cache"]["ok"]')
semantic=$(j "${tmp}/status" '"semantic" in d["cache"]["detail"]')
readonly_=$(j "${tmp}/status" 'd.get("readOnly", False)')

photos=$(j "${tmp}/status" 'd.get("library", {}).get("photos", 0)')
if [[ "${photos}" -lt 8 && "${readonly_}" != True ]]; then
  echo "   loading sample photos (a few seconds each)..."
  post "${tmp}/seed" /api/seed >/dev/null
  for _ in $(seq 180); do
    get "${tmp}/status" /api/status >/dev/null
    [[ "$(j "${tmp}/status" 'd["seed"]["running"]')" == False ]] && break
    sleep 5
  done
  photos=$(j "${tmp}/status" 'd.get("library", {}).get("photos", 0)')
  errs=$(j "${tmp}/status" 'len(d["seed"].get("errors") or [])')
  [[ "${errs}" == 0 ]] || echo "   ${errs} sample photos failed: $(j "${tmp}/status" 'd["seed"]["errors"][0]')"
fi
[[ "${photos}" -ge 8 ]] && pass "library: ${photos} photos" || fail "library: ${photos} photos"

own=""
if [[ "${readonly_}" == True ]]; then
  skip "adding a photo: the standby site is read-only"
else
  # A photo no library has: random stripes, made here.
  python3 - "${tmp}/own.png" <<'PY'
import random, struct, sys, zlib
w = h = 320
cols = [tuple(random.randrange(256) for _ in range(3)) for _ in range(6)]
rows = b"".join(b"\x00" + b"".join(bytes(cols[(x // 40 + y // 80) % 6]) for x in range(w)) for y in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
PY
  code=$(post "${tmp}/add" /api/photos -F "photo=@${tmp}/own.png;type=image/png")
  if [[ "${code}" == 200 ]]; then
    own=$(j "${tmp}/add" 'd["photo"]["id"]')
    pass "added a photo in $(j "${tmp}/add" 'd["timings"]["total"]') ms: “$(j "${tmp}/add" 'd["photo"]["title"]')”, $(j "${tmp}/add" 'len(d["photo"]["tags"])') tags"
    post "${tmp}/add2" /api/photos -F "photo=@${tmp}/own.png;type=image/png" >/dev/null
    [[ "$(j "${tmp}/add2" 'd.get("duplicate")')" == True ]] && pass "the same bytes again: a duplicate" || fail "the same bytes were added twice"
    code=$(post "${tmp}/byimg" /api/search/image -F "photo=@${tmp}/own.png;type=image/png")
    [[ "${code}" == 200 && "$(j "${tmp}/byimg" 'd["photos"][0]["id"]')" == "${own}" ]] \
      && pass "search by image: finds itself first ($(j "${tmp}/byimg" 'round(d["photos"][0]["similarity"] * 100)')%)" \
      || fail "search by image: HTTP ${code}, first $(j "${tmp}/byimg" 'd.get("photos", [{}])[0].get("id")') not ${own}"
  else
    fail "adding a photo: HTTP ${code} $(cat "${tmp}/add")"
  fi
fi

Q="mountains at sunset"
P="sunset over the mountains"
code=$(search "${tmp}/s1" "${Q}" "&nocache=1")
if [[ "${code}" == 200 && "$(j "${tmp}/s1" 'len(d["photos"])')" -gt 0 ]]; then
  pass "search “${Q}”: $(j "${tmp}/s1" 'len(d["photos"])') photos, first “$(j "${tmp}/s1" 'd["photos"][0]["title"]')” in $(j "${tmp}/s1" 'd["timings"]["total"]') ms"
else
  fail "search: HTTP ${code} $(head -c 300 "${tmp}/s1")"
fi
if [[ "${cache}" != True ]]; then
  skip "exact and semantic search cache: no cache"
else
  search "${tmp}/s2" "${Q}" >/dev/null # fills the cache (the first search skipped it)
  search "${tmp}/s3" "  ${Q^^} " >/dev/null
  [[ "$(j "${tmp}/s3" 'd["cache"]')" == exact ]] && pass "same words (other case, spaces): exact hit in $(j "${tmp}/s3" 'd["timings"]["total"]') ms" \
    || fail "same words: cache $(j "${tmp}/s3" 'd["cache"]')"
  if [[ "${semantic}" == True ]]; then
    search "${tmp}/s4" "${P}" >/dev/null
    [[ "$(j "${tmp}/s4" 'd["cache"]')" == semantic ]] && pass "paraphrase “${P}”: semantic hit, distance $(j "${tmp}/s4" 'round(d["distance"], 3)')" \
      || fail "paraphrase: cache $(j "${tmp}/s4" 'd["cache"]') (SEMANTIC_MAX_DISTANCE?)"
  else
    skip "semantic cache: the server has no valkey-search"
  fi
fi

first=$(j "${tmp}/s1" 'd["photos"][0]["id"]' 2>/dev/null || true)
if [[ -n "${first}" ]]; then
  code=$(get "${tmp}/sim" "/api/photos/${first}/similar")
  [[ "${code}" == 200 && "$(j "${tmp}/sim" 'all(p["id"] != '"${first}"' for p in d["photos"]) and len(d["photos"]) > 0')" == True ]] \
    && pass "more like this: $(j "${tmp}/sim" 'len(d["photos"])') photos, without itself" || fail "more like this: HTTP ${code}"
  ask='{"question": "What is the main subject of this photo?"}'
  code=$(post "${tmp}/ask" "/api/photos/${first}/ask" -H 'Content-Type: application/json' -d "${ask}")
  if [[ "${code}" == 200 ]]; then
    pass "a question about it: “$(j "${tmp}/ask" 'd["answer"][:90].replace("\n", " ")')…”"
    if [[ "${cache}" == True ]]; then
      post "${tmp}/ask2" "/api/photos/${first}/ask" -H 'Content-Type: application/json' -d "${ask}" >/dev/null
      [[ "$(j "${tmp}/ask2" 'd["cache"]')" == exact ]] && pass "the same question again: cached" || fail "the same question again: $(j "${tmp}/ask2" 'd["cache"]')"
    fi
  else
    fail "a question about it: HTTP ${code} $(head -c 300 "${tmp}/ask")"
  fi
fi

curl -sS -m 10 "${BASE}/metrics" | grep -q '^lens_requests_total' && pass "metrics: lens_requests_total" || fail "no metrics"
if [[ -n "${own}" ]]; then
  [[ "$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -X DELETE "${BASE}/api/photos/${own}")" == 200 ]] && pass "deleted the photo of its own" || fail "delete"
fi

echo
[[ "${FAILS}" == 0 ]] && echo "${G}all checks passed${N}" || { echo "${R}${FAILS} failed${N}"; exit 1; }
