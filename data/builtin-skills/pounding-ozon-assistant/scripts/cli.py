#!/usr/bin/env python3
"""pounding-ozon-hybrid CLI — 1688 选品 + 云端发布入口。

Usage:
  python3 cli.py configure status          # 检查配置
  python3 cli.py configure set KEY VALUE   # 设置配置
  python3 cli.py search "保温杯"            # 搜索 1688
  python3 cli.py publish --url <1688链接>   # 发布到 Ozon
  python3 cli.py status --task-id <id>     # 查询任务状态
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# Ensure scripts/ is on path for capability import
_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.dirname(_HERE)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from scripts._const import SKILL_ROOT
from scripts.lib.config_store import check_config, load_config, get_required_keys


def _cmd_configure(args: argparse.Namespace) -> int:
    """Config management — delegate to capability module."""
    from scripts.capabilities.configure.cmd import main as configure_main

    argv = []
    if args.config_action == "status":
        pass
    elif args.config_action == "set":
        argv = ["set", args.key or "", args.value or ""]
    elif args.config_action == "guide":
        argv = ["guide"]
    return configure_main(argv)


def _cmd_search(args: argparse.Namespace) -> int:
    """Search 1688 products."""
    from scripts.lib.ak_1688_client import search_products

    if not args.query:
        print(json.dumps({"error": "请提供搜索关键词 --query"}, ensure_ascii=False))
        return 1

    products = search_products(args.query, page=args.page, page_size=args.page_size)
    print(json.dumps(
        {"count": len(products), "products": products},
        ensure_ascii=False, indent=2
    ))
    return 0


def _cmd_detail(args: argparse.Namespace) -> int:
    """Get 1688 product details."""
    from scripts.lib.ak_1688_client import get_product_details, parse_product_url

    item_id = args.item_id
    if args.url:
        parsed = parse_product_url(args.url)
        if parsed:
            item_id = parsed["product_id"]
        else:
            print(json.dumps({"error": f"无法解析链接: {args.url}"}, ensure_ascii=False))
            return 1

    if not item_id:
        print(json.dumps({"error": "请提供 --item-id 或 --url"}, ensure_ascii=False))
        return 1

    details = get_product_details([item_id])
    print(json.dumps(details, ensure_ascii=False, indent=2, default=str))
    return 0


def _cmd_publish(args: argparse.Namespace) -> int:
    """Publish flow — delegate to capability module."""
    from scripts.capabilities.publish_flow.cmd import main as publish_main

    argv = []
    if args.query:
        argv.extend(["--query", args.query])
    if args.url:
        argv.extend(["--url", args.url])
    if args.image:
        for img in (args.image if isinstance(args.image, list) else [args.image]):
            argv.extend(["--image", img])
    if args.draft_file:
        argv.extend(["--draft-file", args.draft_file])
    if args.project_id:
        argv.extend(["--project-id", args.project_id])
    if args.poll_status:
        argv.append("--poll-status")
    if args.dry_run:
        argv.append("--dry-run")

    return publish_main(argv)


def _cmd_status(args: argparse.Namespace) -> int:
    """Query task status."""
    if not args.task_id:
        print(json.dumps({"error": "请提供 --task-id"}, ensure_ascii=False))
        return 1
    print(json.dumps({
        "task_id": args.task_id,
        "note": "任务结果在提交时直接返回。使用 publish 时返回的 ozon_task_id 追踪商品。"
    }, ensure_ascii=False, indent=2))
    return 0


def _cmd_update(args: argparse.Namespace) -> int:
    """Check for skill updates and optionally apply them."""
    from scripts.lib.update import check_skill_version, download_skill_update

    result = check_skill_version()
    if result.get("error"):
        print(json.dumps(
            {"ok": False, "error": result["error"]},
            ensure_ascii=False, indent=2,
        ))
        return 1

    if not result["update_available"]:
        print(json.dumps({
            "ok": True,
            "update_available": False,
            "current_version": result["current_version"],
            "message": f"已是最新版本 ({result['current_version']})",
        }, ensure_ascii=False, indent=2))
        return 0

    if args.check_only:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    # Apply update
    print(f"发现新版本: {result['latest_version']} (当前: {result['current_version']})")
    notes = result.get("release_notes", "")
    if notes:
        print(f"更新内容: {notes}")

    download_result = download_skill_update(result["changed_files"])
    print(json.dumps(download_result, ensure_ascii=False, indent=2))
    return 0 if not download_result.get("failed") else 1


def _cmd_probe(args: argparse.Namespace) -> int:
    """Probe 1688 product page via browser."""
    try:
        from scripts.capabilities.browser_probe.service import probe_1688_page
    except ImportError:
        print(json.dumps({
            "error": "browser_probe 需要 playwright。安装: pip install pounding-ozon-hybrid[browser] && playwright install chromium"
        }, ensure_ascii=False))
        return 1

    if not args.url:
        print(json.dumps({"error": "请提供 --url <1688商品链接>"}, ensure_ascii=False))
        return 1

    result = probe_1688_page(
        url=args.url,
        headed=args.headed,
        timeout_seconds=args.timeout,
        profile=args.profile or None,
        task_id=args.task_id or None,
    )
    # Return key fields
    summary = result.get("summary", {})
    probe = result.get("probe", {})
    print(json.dumps({
        "success": result.get("ready", False),
        "title": probe.get("title"),
        "price": probe.get("price"),
        "brand": probe.get("brand"),
        "seller": probe.get("seller"),
        "images": len(probe.get("images") or []),
        "attributes": len(probe.get("attributes") or []),
        "sku_count": len(probe.get("skuDetails") or []),
        "packaging_rows": len(probe.get("packagingRows") or []),
        "packaging_headers": probe.get("packagingHeaders"),
        "first_packaging": (probe.get("packagingRows") or [{}])[0] if probe.get("packagingRows") else None,
        "login_required": probe.get("loginRequired", False),
        "raw_path": result.get("artifact_path"),
    }, ensure_ascii=False, indent=2))
    return 0



def main() -> int:
    parser = argparse.ArgumentParser(description="pounding-ozon-hybrid — 1688 选品 + 云端发布")
    sub = parser.add_subparsers(dest="command", help="命令")

    # configure
    p_cfg = sub.add_parser("configure", help="配置管理")
    p_cfg.add_argument("config_action", nargs="?", default="status",
                       choices=["status", "set", "guide"])
    p_cfg.add_argument("key", nargs="?", default="")
    p_cfg.add_argument("value", nargs="?", default="")

    # search
    p_search = sub.add_parser("search", help="搜索 1688 商品")
    p_search.add_argument("query", nargs="?", default="", help="搜索关键词")
    p_search.add_argument("--page", type=int, default=1)
    p_search.add_argument("--page-size", type=int, default=20)

    # detail
    p_detail = sub.add_parser("detail", help="获取 1688 商品详情")
    p_detail.add_argument("--item-id", default="")
    p_detail.add_argument("--url", default="")

    # publish
    p_pub = sub.add_parser("publish", help="发布商品到 Ozon")
    p_pub.add_argument("--query", "-q", default="")
    p_pub.add_argument("--url", "-u", default="")
    p_pub.add_argument("--image", "-i", action="append", help="图片 URL")
    p_pub.add_argument("--draft-file", "-d", default="")
    p_pub.add_argument("--project-id", default="")
    p_pub.add_argument("--dry-run", action="store_true")
    p_pub.add_argument("--poll-status", action="store_true")

    # status

    p_probe = sub.add_parser("probe", help="浏览器抓取 1688 商品详情")
    p_probe.add_argument("--url", "-u", required=True, help="1688 商品链接")
    p_probe.add_argument("--headed", action="store_true", help="显示浏览器窗口")
    p_probe.add_argument("--timeout", type=int, default=120, help="超时秒数")
    p_probe.add_argument("--profile", default="default", help="浏览器 profile")
    p_probe.add_argument("--task-id", default="", help="任务ID")

    p_st = sub.add_parser("status", help="查询任务状态")
    p_st.add_argument("--task-id", required=True)

    # update
    p_upd = sub.add_parser("update", help="检查并更新 skill")
    p_upd.add_argument("--check-only", action="store_true", help="仅检查不下载")

    args = parser.parse_args()

    if not args.command:
        # Default: show config status
        status = check_config()
        required = get_required_keys()
        if status["missing"]:
            print(f"配置缺失: {', '.join(status['missing'])}")
            print(f"运行 'configure guide' 查看配置指南")
            return 1
        parser.print_help()
        return 0

    commands = {
        "configure": _cmd_configure,
        "search": _cmd_search,
        "detail": _cmd_detail,
        "publish": _cmd_publish,
        "probe": _cmd_probe,
        "status": _cmd_status,
        "update": _cmd_update,
    }
    return commands[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
