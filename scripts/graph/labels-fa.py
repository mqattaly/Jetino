#!/usr/bin/env python3
"""نام‌گذاری فارسی جامعه‌های گراف دانش جتینو.

Graphify برای نام‌گذاری جامعه‌ها به یک مدل زبانی نیاز دارد. این اسکریپت همان کار را
به‌صورت قطعی (deterministic) و بدون LLM انجام می‌دهد: هر جامعه بر اساس مسیر و نام
فایل‌های عضوهایش به یک دامنهٔ فارسی نسبت داده می‌شود.

استفاده:
    python3 scripts/graph/labels-fa.py <پوشهٔ graphify-out>
"""

from __future__ import annotations

import collections
import json
import pathlib
import sys

# ماژول‌های بک‌اند (api/src/<module>) → نام فارسی
API = {
    "addresses": "نشانی‌ها",
    "admin": "مدیریت",
    "analytics": "گزارش‌ها",
    "auth": "احراز هویت",
    "businesses": "کسب‌وکارها",
    "cancellations": "لغو و بازپرداخت",
    "commerce": "تنظیمات تجارت",
    "database": "پایگاه داده",
    "delivery": "تحویل و پیک",
    "drivers": "پیک‌ها",
    "feedback": "بازخورد",
    "grocery": "سوپرمارکت",
    "health": "سلامت سرویس",
    "identity": "هویت و زحل",
    "media": "رسانه و عکس",
    "notifications": "اعلان‌ها",
    "orders": "سفارش‌ها",
    "partners": "شرکا",
    "payments": "پرداخت",
    "pricing": "قیمت‌گذاری",
    "reports": "گزارش‌ها",
    "safety": "ایمنی",
    "security": "امنیت",
    "settlements": "تسویه",
    "support": "پشتیبانی",
    "tracking": "ردیابی",
    "wallet": "کیف پول",
    "config": "پیکربندی",
    "common": "مشترک",
    "shared": "مشترک",
}

# الگوی نام فایل فرانت → نام فارسی (اولین تطبیق برنده است، پس خاص‌ترها بالاترند)
APP = [
    ("admingrocery", "مدیریت سوپرمارکت"),
    ("admincashsettlement", "تسویهٔ وجه"),
    ("adminauditlog", "حسابرسی عملیات"),
    ("adminpartners", "تأیید شرکا"),
    ("admindispatch", "تخصیص پیک"),
    ("adminapp", "پنل مدیر"),
    ("admin", "پنل مدیر"),
    ("grocerystore", "پنل فروشگاه سوپرمارکت"),
    ("drivergrocery", "ماموریت سوپرمارکت پیک"),
    ("driveridentity", "احراز هویت پیک"),
    ("driver", "اپ پیک"),
    ("grocery", "خرید سوپرمارکت"),
    ("operations", "پنل عملیات"),
    ("notification", "اعلان‌ها"),
    ("partnerjoin", "همکاری با ما"),
    ("businessmenu", "منوی کسب‌وکار"),
    ("checkout", "تسویه‌حساب مشتری"),
    ("cancellation", "لغو سفارش"),
    ("feedbacksupport", "بازخورد و پشتیبانی"),
    ("tracking", "ردیابی سفارش"),
    ("wallet", "کیف پول"),
    ("safety", "ایمنی"),
    ("app", "اپ مشتری"),
]

# فایل‌های مشترک و کم‌اهمیت برای رأی‌گیری، با وزن کمتر شمرده می‌شوند
GENERIC = {
    "safety.tsx",
    "plate.tsx",
    "motion.tsx",
    "controls.tsx",
    "media.ts",
    "types.ts",
    "format.ts",
    "api.ts",
    "usecases.ts",
    "hooks.ts",
    "index.ts",
    "main.tsx",
    "testotpnotice.ts",
    "catalogimages.ts",
    "presence.ts",
}


def label_for_file(path: str) -> tuple[str, str] | None:
    """(نام دامنه، kind) برای یک فایل؛ kind یکی از api/front است."""
    if not path:
        return None
    parts = path.split("/")
    if parts[0] == "api" and len(parts) > 2 and parts[1] == "src":
        if len(parts) == 3 and parts[2].endswith(".ts"):
            return ("زیرساخت API", "api")
        return (API.get(parts[2], parts[2]), "api")
    if parts[0] == "api":
        return ("زیرساخت API", "api")
    if parts[0] == "src":
        base = parts[-1].lower()
        for pattern, name in APP:
            if pattern in base:
                return (name, "front")
        return ("اپ مشتری", "front")
    return None


def name_for(nodes: list[dict]) -> str | None:
    vote: collections.Counter[str] = collections.Counter()
    kinds: dict[str, str] = {}
    for node in nodes:
        result = label_for_file(node.get("source_file") or "")
        if not result:
            continue
        name, kind = result
        weight = 0.25 if (node.get("source_file") or "").split("/")[-1].lower() in GENERIC else 1.0
        vote[name] += weight
        kinds[name] = kind
    if not vote:
        return None
    ranked = vote.most_common(3)
    main, _ = ranked[0]
    total = sum(vote.values())
    suffix = ""
    if len(ranked) > 1 and ranked[1][1] / total >= 0.22 and ranked[1][0] != main:
        suffix = " + " + ranked[1][0]
    kind = "بک‌اند" if kinds[main] == "api" else "فرانت"
    if main == "زیرساخت API":
        suffix = ""
    return f"{main}{suffix} · {kind}"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    out = pathlib.Path(sys.argv[1])
    graph_path = out / "graph.json"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))

    by_community: dict[int, list[dict]] = collections.defaultdict(list)
    for node in graph["nodes"]:
        by_community[node.get("community")].append(node)

    labels: dict[str, str] = {}
    for cid, nodes in by_community.items():
        labels[str(cid)] = name_for(nodes) or f"Community {cid}"

    seen: collections.Counter[str] = collections.Counter()
    for cid in sorted(labels, key=int):
        base = labels[cid]
        if base.startswith("Community"):
            continue
        seen[base] += 1
        if seen[base] > 1:
            labels[cid] = f"{base} ({seen[base]})"

    (out / ".graphify_labels.json").write_text(
        json.dumps(labels, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    named = sum(1 for value in labels.values() if not value.startswith("Community"))
    print(f"labels-fa: {named}/{len(labels)} جامعه نام‌گذاری شد")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
