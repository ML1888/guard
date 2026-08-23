"""Task-driven, worker-independent evaluation for generated deliverables."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


GOMOKU_CRITERIA = [
    "提供可直接打开的 index.html，且 CSS、JavaScript 使用相对路径，不依赖构建步骤",
    "显示清晰、可点击的 15×15 五子棋棋盘",
    "黑白双方交替落子，并阻止在已有棋子的位置重复落子",
    "正确识别横向、纵向、正斜线和反斜线的五子连珠",
    "获胜后显示获胜方并禁止继续落子",
    "提供重新开始控件，并能清空棋盘、胜负状态和当前玩家",
    "JavaScript 语法有效，页面不依赖外部第三方包",
    "布局在桌面端和移动端均可使用",
]


def build_evaluation_profile(task: str) -> dict[str, Any]:
    lowered = task.lower()
    if "五子棋" in task or "gomoku" in lowered or "five in a row" in lowered:
        return {
            "id": "gomoku-web-v1",
            "kind": "static-web-app",
            "title": "五子棋 Web 应用",
            "acceptance_criteria": GOMOKU_CRITERIA,
            "threshold": 80,
            "method": "独立结构与规则契约检查",
            "limitations": "用于发现结构、语法和核心规则信号缺失，不替代完整浏览器端到端测试。",
        }
    return {
        "id": "generic-v1",
        "kind": "generic",
        "title": "通用编程任务",
        "acceptance_criteria": [],
        "threshold": 0,
        "method": "项目原有测试与 AgentGuard 证据",
        "limitations": "未匹配专用任务评价器，请配置项目验证命令。",
    }


def _read_sources(repo: Path) -> tuple[str, str, str, list[Path]]:
    html_files = sorted(repo.glob("*.html"))
    css_files = sorted(repo.glob("*.css"))
    js_files = sorted(path for path in repo.glob("*.js") if path.is_file())

    def joined(paths: list[Path]) -> str:
        chunks: list[str] = []
        for path in paths[:20]:
            try:
                if path.stat().st_size <= 500_000:
                    chunks.append(path.read_text(encoding="utf-8", errors="ignore"))
            except OSError:
                continue
        return "\n".join(chunks)

    return joined(html_files), joined(css_files), joined(js_files), js_files


def _check(check_id: str, label: str, passed: bool, detail: str, weight: int) -> dict[str, Any]:
    return {"id": check_id, "label": label, "passed": passed, "detail": detail, "weight": weight}


def _javascript_syntax(js_files: list[Path], repo: Path) -> tuple[bool, str]:
    if not js_files:
        return False, "未找到根目录 JavaScript 文件"
    node = shutil.which("node")
    if not node:
        return True, "未找到 Node.js，已跳过语法执行检查"
    failures: list[str] = []
    for path in js_files:
        try:
            result = subprocess.run(
                [node, "--check", str(path)], cwd=repo, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=20, check=False,
            )
        except subprocess.TimeoutExpired:
            failures.append(f"{path.name}: 语法检查超时")
            continue
        if result.returncode != 0:
            failures.append(f"{path.name}: {(result.stderr or result.stdout).strip()[:180]}")
    return not failures, "；".join(failures) if failures else f"{len(js_files)} 个脚本通过 node --check"


def evaluate_gomoku(repo_path: Path) -> dict[str, Any]:
    repo = repo_path.resolve()
    html, css, js, js_files = _read_sources(repo)
    combined = f"{html}\n{css}\n{js}"
    lowered = combined.lower()
    compact = re.sub(r"\s+", "", lowered)
    syntax_ok, syntax_detail = _javascript_syntax(js_files, repo)

    direction_signals = sum(token in compact for token in ("[1,0]", "[0,1]", "[1,1]", "[1,-1]"))
    if direction_signals < 4:
        direction_signals = sum(token in lowered for token in ("horizontal", "vertical", "diagonal", "斜线"))

    checks = [
        _check("entry", "可直接运行的入口", (repo / "index.html").is_file(), "根目录存在 index.html" if (repo / "index.html").is_file() else "缺少根目录 index.html", 12),
        _check("syntax", "JavaScript 语法", syntax_ok, syntax_detail, 12),
        _check("board", "15×15 可交互棋盘", bool(re.search(r"\b15\b", combined)) and any(token in lowered for token in ("canvas", "board", "grid", "棋盘")), "检测棋盘尺寸与渲染结构", 14),
        _check("input", "点击落子", any(token in lowered for token in ("addeventlistener", "onclick", "pointerdown", "touchstart")), "检测用户输入事件", 8),
        _check("turn", "黑白交替", any(token in lowered for token in ("currentplayer", "current player", "black", "white", "黑棋", "白棋")) and any(token in lowered for token in ("toggle", "% 2", "=== 1", "===1", "player =", "player=")), "检测当前玩家与切换逻辑", 10),
        _check("occupied", "重复落子保护", any(token in lowered for token in ("occupied", "cell !==", "cell!==", "board[row][col]", "board[x][y]", "已有棋子", "不能落子")) and any(token in lowered for token in ("return", "continue")), "检测棋盘占用判断", 10),
        _check("directions", "四方向胜负判断", direction_signals >= 4, f"检测到 {min(direction_signals, 4)}/4 个方向信号", 14),
        _check("win_lock", "获胜后锁定", any(token in lowered for token in ("gameover", "game over", "winner", "isgameover", "获胜")) and "return" in lowered, "检测结束状态与落子阻断", 8),
        _check("restart", "重新开始", any(token in lowered for token in ("restart", "reset", "重新开始", "再来一局")) and ("button" in lowered or "btn" in lowered), "检测重置控件与逻辑", 7),
        _check("responsive", "移动端适配", "@media" in lowered or "max-width" in lowered or "min(" in lowered or "clamp(" in lowered, "检测响应式样式", 5),
    ]
    earned = sum(item["weight"] for item in checks if item["passed"])
    total = sum(item["weight"] for item in checks)
    score = round(earned / total * 100) if total else 0
    failed = [item for item in checks if not item["passed"]]
    entry = "index.html" if (repo / "index.html").is_file() else ""
    return {
        "profile_id": "gomoku-web-v1",
        "score": score,
        "passed": len(checks) - len(failed),
        "total": len(checks),
        "threshold": 80,
        "status": "PASS" if score >= 80 else "INCOMPLETE",
        "checks": checks,
        "failed_capabilities": [item["label"] for item in failed],
        "preview_entry": entry,
        "method": "独立结构与规则契约检查",
        "limitations": "用于发现结构、语法和核心规则信号缺失，不替代完整浏览器端到端测试。",
    }


def evaluate_project(repo_path: Path, profile: dict[str, Any]) -> dict[str, Any]:
    if profile.get("id") == "gomoku-web-v1":
        return evaluate_gomoku(repo_path)
    return {
        "profile_id": str(profile.get("id", "generic-v1")),
        "score": None,
        "passed": 0,
        "total": 0,
        "threshold": 0,
        "status": "NOT_APPLICABLE",
        "checks": [],
        "failed_capabilities": [],
        "preview_entry": "index.html" if (repo_path / "index.html").is_file() else "",
        "method": str(profile.get("method", "项目原有测试与 AgentGuard 证据")),
        "limitations": str(profile.get("limitations", "")),
    }


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="gomoku-web-v1")
    parser.add_argument("repo", nargs="?", default=".")
    args = parser.parse_args()
    profile = {"id": args.profile}
    result = evaluate_project(Path(args.repo), profile)
    print(json.dumps(result, ensure_ascii=False))
    if result["status"] == "INCOMPLETE":
        print("未通过能力：" + "、".join(result["failed_capabilities"]))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
