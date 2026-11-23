#!/usr/bin/env bash
# ساخت دوبارهٔ گراف دانش پروژه (docs/graph) با Graphify.
#
# چرا دستی؟ چون می‌خواهیم:
#   1) فقط کد ایندکس شود (بدون کلید مدل زبانی) — پس docs و تصاویر وارد گراف نمی‌شوند؛
#   2) جامعه‌ها نام فارسی بگیرند (scripts/graph/labels-fa.py)؛
#   3) فایل‌های HTML خودکفا شوند (کتابخانه‌ها از vendor/ بارگذاری می‌شوند).
#
# پیش‌نیاز (یک‌بار):
#   python3 -m venv ~/.graphify-venv && ~/.graphify-venv/bin/pip install "graphifyy[sql]"
#   export PATH="$HOME/.graphify-venv/bin:$PATH"
#
# اجرا:  bash scripts/graph/build-graph.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

G="${GRAPHIFY:-graphify}"
command -v "$G" >/dev/null 2>&1 || {
  echo "graphify پیدا نشد. راهنما در بالای همین فایل." >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/graphify-out"

echo "→ استخراج AST از کد پروژه"
"$G" extract . --code-only --out "$TMP"

echo "→ نام‌گذاری فارسی جامعه‌ها"
python3 scripts/graph/labels-fa.py "$OUT"

echo "→ خوشه‌بندی و ساخت گزارش و graph.html"
"$G" cluster-only "$TMP"

echo "→ درخت فایل و دیاگرام جریان فراخوانی"
"$G" tree --graph "$OUT/graph.json" --root . \
  --output "$OUT/GRAPH_TREE.html" --label "Jetino"
"$G" export callflow-html "$TMP" --graph "$OUT/graph.json" \
  --report "$OUT/GRAPH_REPORT.md" --labels "$OUT/.graphify_labels.json" \
  --output "$OUT/CALLFLOW.html" >/dev/null

mkdir -p docs/graph/vendor
cp "$OUT/graph.json" "$OUT/graph.html" "$OUT/GRAPH_TREE.html" "$OUT/CALLFLOW.html" \
   "$OUT/GRAPH_REPORT.md" "$OUT/.graphify_labels.json" "$OUT/.graphify_analysis.json" \
   "$OUT/manifest.json" docs/graph/

echo "→ لوکال کردن کتابخانه‌های گراف (بدون CDN)"
python3 - <<'PY'
import pathlib
pairs = [
    ('docs/graph/graph.html',
     'https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js',
     'vendor/vis-network.min.js'),
    ('docs/graph/GRAPH_TREE.html', 'https://d3js.org/d3.v7.min.js', 'vendor/d3.v7.min.js'),
]
for path, cdn, local in pairs:
    p = pathlib.Path(path)
    text = p.read_text(encoding='utf-8')
    if cdn in text:
        p.write_text(text.replace(cdn, local), encoding='utf-8')
        print(f'   {path}: {local}')
PY

echo "✔ گراف در docs/graph ساخته شد:"
du -sh docs/graph
