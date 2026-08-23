"""Local API bridge for a real AgentGuard-Coder run.

The browser never invokes Codex or touches a repository directly.  It sends a
run request here; this server invokes AgentReviewRunner and streams only the
real run state, trace events and persisted EvidenceReport back to the UI.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

# Some Windows Python installations map .js to text/plain. Browsers reject ES
# modules with that MIME type, so register the production asset types explicitly.
mimetypes.add_type("application/javascript", ".js", strict=True)
mimetypes.add_type("text/css", ".css", strict=True)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
AGENTGUARD_ROOT = Path(os.environ.get("AGENTGUARD_ROOT", PROJECT_ROOT / "codex-process-supervisor-main")).resolve()
if str(AGENTGUARD_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(AGENTGUARD_ROOT / "src"))

from agent_review.models import RunConfig, to_dict  # noqa: E402
import agent_review.orchestrator as agentguard_orchestrator  # noqa: E402
from agent_review.git_changes import collect_git_changes  # noqa: E402
from agent_review.orchestrator import AgentReviewRunner  # noqa: E402
from agent_review.run_state import request_cancel  # noqa: E402


class ConversationTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8_000)


class RunRequest(BaseModel):
    repo_path: str = Field(min_length=1, description="Absolute local project path")
    task: str = Field(min_length=8, max_length=20_000)
    allowed_globs: list[str] = Field(default_factory=lambda: ["**/*"])
    test_commands: list[str] = Field(default_factory=list)
    worker: Literal["codex", "mock", "agentless"] = "codex"
    max_repair_rounds: int = Field(default=3, ge=0, le=10)
    max_files: int = Field(default=8, ge=1, le=100)
    max_diff_lines: int = Field(default=600, ge=20, le=20_000)
    worker_timeout_seconds: int = Field(default=600, ge=30, le=3600)
    execution_mode: Literal["isolated", "in-place"] = "isolated"
    apply_patch: bool = False
    model: str = ""
    api_base_url: str = ""
    api_key: str = ""
    conversation_history: list[ConversationTurn] = Field(default_factory=list, max_length=12)

    @field_validator("allowed_globs", "test_commands")
    @classmethod
    def trim_list(cls, values: list[str]) -> list[str]:
        return [item.strip() for item in values if item.strip()]


class ProjectRequest(BaseModel):
    path: str = Field(min_length=1, description="Absolute local project path")


@dataclass
class LiveRun:
    run_id: str
    repo_path: Path
    working_repo_path: Path | None = None
    runtime_root: Path | None = None
    source_manifest: dict[str, str] = field(default_factory=dict)
    source_mode: str = "git"
    status: str = "QUEUED"
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    queue: Queue[dict[str, Any]] = field(default_factory=Queue)
    report: dict[str, Any] | None = None
    error: str = ""

    def emit(self, kind: str, payload: dict[str, Any]) -> None:
        self.queue.put({"id": uuid.uuid4().hex, "kind": kind, "at": time.time(), "payload": payload})


runs: dict[str, LiveRun] = {}
runs_lock = threading.Lock()
execution_lock = threading.Lock()
active_live_run: ContextVar[LiveRun | None] = ContextVar("active_live_run", default=None)

app = FastAPI(title="AgentGuard Live Console API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEMO_RESULTS_ROOT = PROJECT_ROOT / "AgentGuard_GPT52_Astropy14995_Demo_Package"


def read_demo_json(relative_path: str) -> dict[str, Any]:
    """Read one trusted artifact from the packaged Astropy demo."""
    path = DEMO_RESULTS_ROOT / relative_path
    if not path.is_file():
        raise HTTPException(404, f"Demo artifact not found: {relative_path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(500, f"Cannot read demo artifact: {relative_path}") from exc


@app.get("/api/demo/astropy-14995")
def astropy_demo_results() -> JSONResponse:
    """Build a UI-friendly snapshot from the packaged, immutable result files."""
    summary = read_demo_json("raw/summary/summary.json")
    harness = read_demo_json("raw/summary/harness-summary.json")
    delivery = read_demo_json("raw/governance/delivery_report.json")
    agentguard_bii = read_demo_json("raw/bii/agentguard_bii_audit.json")
    direct_bii = read_demo_json("raw/bii/direct_bii_audit.json")

    records = {item["condition"]: item for item in summary.get("records", [])}
    patch_files = {
        "direct": "direct.patch",
        "candidate": "candidate.patch",
        "delivered": "delivered.patch",
    }
    patch_bytes = {
        key: (DEMO_RESULTS_ROOT / "raw" / "patches" / filename).stat().st_size
        for key, filename in patch_files.items()
    }
    condition_specs = [
        ("direct", "Direct", "direct", "无在线监督的模型直接修复"),
        ("candidate", "AgentGuard Candidate", "agentguard-candidate", "监督流程产生的候选补丁"),
        ("delivered", "AgentGuard Delivered", "agentguard-delivered", "交付治理收敛后的最终补丁"),
    ]
    conditions = []
    for key, label, harness_key, description in condition_specs:
        result = harness.get(harness_key, {})
        bii = direct_bii if key == "direct" else agentguard_bii
        conditions.append({
            "id": key,
            "label": label,
            "description": description,
            "patch_bytes": patch_bytes[key],
            "harness_status": result.get("status", "UNKNOWN"),
            "harness_result": "RESOLVED" if result.get("resolved_instances", 0) == 1 else "UNRESOLVED",
            "submitted": result.get("submitted_instances", 0),
            "resolved": result.get("resolved_instances", 0),
            "errors": result.get("error_instances", 0),
            "bii_status": bii.get("information_audit_status", "UNKNOWN"),
            "patch_endpoint": f"/api/demo/astropy-14995/patches/{key}",
        })

    candidate_bytes = patch_bytes["candidate"]
    delivered_bytes = patch_bytes["delivered"]
    shrink_percent = round((candidate_bytes - delivered_bytes) / candidate_bytes * 100, 1)
    agentguard_record = records.get("agentguard", {})
    payload = {
        "schema_version": "agentguard-dashboard-1.0",
        "source": "AgentGuard_GPT52_Astropy14995_Demo_Package",
        "case": {
            "instance_id": summary.get("instances", ["astropy__astropy-14995"])[0],
            "repository": agentguard_record.get("repo", "astropy/astropy"),
            "base_commit": agentguard_record.get("base_commit", ""),
            "benchmark": "SWE-bench Lite",
        },
        "model": {
            "provider": summary.get("model", {}).get("provider", "OpenRouter"),
            "model_id": summary.get("model", {}).get("exact_model_identifier", "openai/gpt-5.2"),
            "worker": summary.get("model", {}).get("worker_adapter", "codex"),
            "isolation": agentguard_bii.get("information_isolation", "strict"),
        },
        "conditions": conditions,
        "headline": {
            "resolved_paths": sum(item["resolved"] for item in conditions),
            "total_paths": len(conditions),
            "bii_passed": direct_bii.get("information_audit_status") == "PASS" and agentguard_bii.get("information_audit_status") == "PASS",
            "supervision_verified": bool(agentguard_record.get("supervision_verified")),
            "candidate_to_delivered_regression": False,
            "patch_shrink_percent": shrink_percent,
            "infrastructure_errors": sum(item["errors"] for item in conditions),
        },
        "governance": {
            "internal_final_decision": delivery.get("final_decision", "UNKNOWN"),
            "functional_evidence": delivery.get("functional_evidence", "UNKNOWN"),
            "security_decision": delivery.get("security", {}).get("decision", "UNKNOWN"),
            "rollback_status": delivery.get("rollback", {}).get("status", "UNKNOWN"),
            "restored_files": delivery.get("rollback", {}).get("restored_files", []),
            "delivered_files": delivery.get("changed_files", []),
            "test_evidence": delivery.get("final_review", {}).get("test_evidence", []),
            "remaining_risks": delivery.get("final_review", {}).get("remaining_risks", []),
        },
        "bii": {
            "information_isolation": agentguard_bii.get("information_isolation"),
            "web_search_mode": agentguard_bii.get("web_search_mode"),
            "shell_network_access": agentguard_bii.get("shell_network_access"),
            "dataset_cache_visible": agentguard_bii.get("dataset_cache_visible"),
            "harness_artifacts_visible": agentguard_bii.get("harness_artifacts_visible"),
            "future_git_history_visible": agentguard_bii.get("future_git_history_visible"),
            "api_key_in_worker_shell": agentguard_bii.get("api_key_in_worker_shell"),
            "gateway": agentguard_bii.get("model_gateway"),
        },
        "timeline": [
            {"title": "加载公开任务", "detail": "仅向 Worker 提供 instance、仓库、基线提交与问题描述。"},
            {"title": "Direct 执行与评测", "detail": "GPT-5.2 在 strict BII 沙箱中生成补丁，并通过官方 Harness。"},
            {"title": "AgentGuard 监督执行", "detail": "监督链生成 Candidate Patch，同时保存治理与隔离证据。"},
            {"title": "交付范围治理", "detail": "回滚测试文件变更，仅保留业务修复，形成 Delivered Patch。"},
            {"title": "三路官方 Harness", "detail": "Direct、Candidate、Delivered 均提交 1 个实例，均判定 RESOLVED。"},
        ],
        "interpretation": "该单案例证明监督、审计和交付治理链路可在真实 resolved case 上完整运行；不用于推断总体成功率提升。",
    }
    return JSONResponse(payload)


@app.get("/api/demo/astropy-14995/patches/{patch_name}")
def astropy_demo_patch(patch_name: Literal["direct", "candidate", "delivered"]) -> PlainTextResponse:
    filename = f"{patch_name}.patch"
    path = DEMO_RESULTS_ROOT / "raw" / "patches" / filename
    if not path.is_file():
        raise HTTPException(404, f"Demo patch not found: {filename}")
    return PlainTextResponse(path.read_text(encoding="utf-8"), media_type="text/plain; charset=utf-8")


def safe_text(value: object, limit: int = 1600) -> str:
    return str(value or "").replace("\x00", "")[:limit]


def stage_to_event(event: dict[str, Any]) -> dict[str, Any]:
    """Keep original stage/payload intact so the UI never invents supervision."""
    payload = event.get("payload", {})
    return {
        "stage": safe_text(event.get("stage")),
        "status": safe_text(event.get("status")),
        "started_at": safe_text(event.get("started_at")),
        "duration_ms": event.get("duration_ms", 0),
        "payload": payload if isinstance(payload, dict) else {"value": safe_text(payload)},
    }


# AgentReviewRunner uses this timer for every persisted trace stage.  Hooking it
# here lets the UI receive the exact stage as it completes, rather than replaying
# an invented timeline after the run is over. ContextVar keeps it bound to the
# background thread handling the current local run.
_original_stage_finish = agentguard_orchestrator.StageTimer.finish


def _streaming_stage_finish(self: Any, payload: dict[str, object], status: str = "OK") -> Any:
    event = _original_stage_finish(self, payload, status)
    live = active_live_run.get()
    if live is not None:
        live.emit("trace", stage_to_event(to_dict(event)))
    return event


agentguard_orchestrator.StageTimer.finish = _streaming_stage_finish


NON_GIT_RUNTIME_ROOT = Path(
    os.environ.get(
        "AGENTGUARD_RUNTIME_ROOT",
        Path(tempfile.gettempdir()) / "agentguard-live-console" / "non-git-runs",
    )
).resolve()
NON_GIT_EXCLUDED_NAMES = {
    ".git", ".agent-review", ".agentguard-runtime", ".idea", "__pycache__",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", "dist",
    "build", "coverage", ".next", ".venv", "venv", "target", "logs", ".env",
    ".env.local", ".env.production", "credentials.json",
}
NON_GIT_MAX_FILES = 30_000
NON_GIT_MAX_BYTES = 2 * 1024 * 1024 * 1024


def _run_command(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
    )


def _is_link_like(path: Path) -> bool:
    try:
        is_junction = getattr(path, "is_junction", None)
        return path.is_symlink() or bool(is_junction and is_junction())
    except OSError:
        return True


def _non_git_ignore(folder: str, names: list[str]) -> set[str]:
    base = Path(folder)
    ignored = {name for name in names if name in NON_GIT_EXCLUDED_NAMES}
    for name in names:
        if _is_link_like(base / name):
            ignored.add(name)
    return ignored


def validate_non_git_source(source: Path) -> dict[str, int]:
    file_count = 0
    total_bytes = 0
    for folder, dir_names, file_names in os.walk(source, followlinks=False):
        base = Path(folder)
        dir_names[:] = [
            name for name in dir_names
            if name not in NON_GIT_EXCLUDED_NAMES and not _is_link_like(base / name)
        ]
        for name in file_names:
            path = base / name
            if name in NON_GIT_EXCLUDED_NAMES or _is_link_like(path):
                continue
            try:
                total_bytes += path.stat().st_size
            except OSError as exc:
                raise RuntimeError(f"无法读取普通文件夹中的文件：{path}") from exc
            file_count += 1
            if file_count > NON_GIT_MAX_FILES:
                raise RuntimeError(f"普通文件夹文件数超过上限 {NON_GIT_MAX_FILES}")
            if total_bytes > NON_GIT_MAX_BYTES:
                raise RuntimeError("普通文件夹总体积超过 2 GB 上限")
    return {"file_count": file_count, "total_bytes": total_bytes}


def _sha256(path: Path) -> str | None:
    if not path.is_file() or path.is_symlink():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tracked_file_manifest(repo: Path) -> dict[str, str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"], cwd=repo, capture_output=True, check=True
    )
    manifest: dict[str, str] = {}
    for raw_path in result.stdout.split(b"\0"):
        if not raw_path:
            continue
        relative = raw_path.decode("utf-8", errors="surrogateescape").replace("\\", "/")
        value = _sha256(repo / relative)
        if value is not None:
            manifest[relative] = value
    return manifest


def prepare_non_git_repository(live: LiveRun) -> Path:
    source = live.repo_path
    stats = validate_non_git_source(source)
    runtime_root = NON_GIT_RUNTIME_ROOT / live.run_id
    repo = runtime_root / "repo"
    runtime_root.mkdir(parents=True, exist_ok=False)
    try:
        shutil.copytree(source, repo, ignore=_non_git_ignore, copy_function=shutil.copy2)
    except (OSError, shutil.Error) as exc:
        shutil.rmtree(runtime_root, ignore_errors=True)
        raise RuntimeError(
            "普通文件夹复制失败。请避免选择包含大量日志或失效目录联接的上级工作区，"
            "并尽量直接选择需要修改的项目文件夹。"
        ) from exc
    _run_command(["git", "init"], repo)
    _run_command(["git", "config", "core.autocrlf", "false"], repo)
    git_exclude = repo / ".git" / "info" / "exclude"
    with git_exclude.open("a", encoding="utf-8") as handle:
        handle.write("\n# AgentGuard runtime artifacts\n.agent-review/\n")
    _run_command(["git", "add", "-A", "-f"], repo)
    _run_command(
        [
            "git", "-c", "user.name=AgentGuard Temporary Baseline",
            "-c", "user.email=agentguard@localhost", "commit", "--allow-empty",
            "-m", "AgentGuard temporary baseline",
        ],
        repo,
    )
    live.working_repo_path = repo
    live.runtime_root = runtime_root
    live.source_manifest = tracked_file_manifest(repo)
    live.source_mode = "temporary_git_baseline"
    live.emit(
        "run",
        {
            "status": "RUNNING",
            "message": f"普通文件夹已复制到临时监督基线：{stats['file_count']} 个文件。",
            "source_mode": live.source_mode,
        },
    )
    return repo


def _safe_relative_path(root: Path, relative: str) -> Path:
    if not relative or relative.startswith(".agent-review/"):
        raise RuntimeError(f"拒绝写回内部或空路径：{relative}")
    path = Path(relative)
    if path.is_absolute():
        raise RuntimeError(f"拒绝写回绝对路径：{relative}")
    target = (root / path).resolve()
    if target == root or not target.is_relative_to(root):
        raise RuntimeError(f"拒绝写回越界路径：{relative}")
    return target


def apply_non_git_changes(live: LiveRun) -> dict[str, Any]:
    source = live.repo_path.resolve()
    repo = live.working_repo_path
    runtime_root = live.runtime_root
    if repo is None or runtime_root is None:
        raise RuntimeError("临时监督基线不存在")
    changes = collect_git_changes(repo)
    if not changes:
        return {"status": "NO_CHANGES", "applied": False, "files": []}

    touched: set[str] = set()
    for change in changes:
        touched.add(change.path)
        if change.original_path:
            touched.add(change.original_path)

    conflicts: list[str] = []
    for relative in sorted(touched):
        source_path = _safe_relative_path(source, relative)
        baseline_hash = live.source_manifest.get(relative)
        current_hash = _sha256(source_path)
        if baseline_hash != current_hash:
            conflicts.append(relative)
    if conflicts:
        return {
            "status": "CONFLICT",
            "applied": False,
            "files": [],
            "conflicts": conflicts,
            "message": "运行期间源文件发生变化，已拒绝覆盖",
        }

    backup_root = runtime_root / "source-backup"
    backup_root.mkdir(parents=True, exist_ok=True)
    existing_before: set[str] = set()
    for relative in touched:
        source_path = _safe_relative_path(source, relative)
        if source_path.is_file():
            existing_before.add(relative)
            backup_path = backup_root / relative
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_path, backup_path)

    try:
        for change in changes:
            target = _safe_relative_path(source, change.path)
            if change.is_deleted:
                if target.is_file():
                    target.unlink()
                continue
            work_file = _safe_relative_path(repo.resolve(), change.path)
            if not work_file.is_file() or work_file.is_symlink():
                raise RuntimeError(f"临时结果不是可写回的普通文件：{change.path}")
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary_target = target.with_name(f".{target.name}.agentguard-{live.run_id[:8]}")
            shutil.copy2(work_file, temporary_target)
            os.replace(temporary_target, target)
            if change.is_renamed and change.original_path:
                original = _safe_relative_path(source, change.original_path)
                if original != target and original.is_file():
                    original.unlink()
    except Exception:
        for relative in touched:
            target = _safe_relative_path(source, relative)
            backup = backup_root / relative
            if relative in existing_before and backup.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(backup, target)
            elif target.is_file():
                target.unlink()
        raise

    return {
        "status": "APPLIED",
        "applied": True,
        "files": sorted(change.path for change in changes),
        "backup_path": str(backup_root),
    }


def write_ui_task_file(repo: Path, run_id: str, request: RunRequest) -> Path:
    task_file = repo / ".agent-review" / "ui-tasks" / f"{run_id}.toml"
    task_file.parent.mkdir(parents=True, exist_ok=True)
    summary = request.task
    if request.conversation_history:
        history = "\n\n".join(
            f"{turn.role.upper()}: {turn.content}" for turn in request.conversation_history
        )
        summary = f"{request.task}\n\nPrevious conversation context (use only when relevant):\n{history}"
    task_file.write_text(
        "\n".join(
            [
                f"summary = {json.dumps(summary, ensure_ascii=False)}",
                f"goals = {json.dumps([request.task], ensure_ascii=False)}",
                f"acceptance_criteria = {json.dumps([request.task], ensure_ascii=False)}",
                f"allowed_paths = {json.dumps(request.allowed_globs, ensure_ascii=False)}",
                f"required_tests = {json.dumps(request.test_commands, ensure_ascii=False)}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return task_file


def run_agentguard(live: LiveRun, request: RunRequest) -> None:
    managed_env = (
        "OPENAI_API_KEY", "OPENAI_BASE_URL", "AGENT_REVIEW_CODEX_MODEL",
        "PATH", "ELECTRON_RUN_AS_NODE",
    )
    old_env = {key: os.environ.get(key) for key in managed_env}
    context_token = active_live_run.set(live)
    try:
        source = live.repo_path
        if (source / ".git").exists():
            repo = source
            live.working_repo_path = repo
            live.source_mode = "git"
        else:
            live.status = "RUNNING"
            live.emit("run", {"status": "RUNNING", "message": "正在为普通文件夹创建临时监督基线。"})
            repo = prepare_non_git_repository(live)

        task_file = write_ui_task_file(repo, live.run_id, request)
        live.status = "RUNNING"
        live.emit(
            "run",
            {
                "status": "RUNNING",
                "message": "已提交给 AgentGuard，正在执行真实预检与计划约束。",
                "source_mode": live.source_mode,
            },
        )

        if request.api_key:
            os.environ["OPENAI_API_KEY"] = request.api_key
        if request.api_base_url:
            os.environ["OPENAI_BASE_URL"] = request.api_base_url
        if request.model:
            os.environ["AGENT_REVIEW_CODEX_MODEL"] = request.model
        if request.worker == "codex":
            native_codex = configured_codex_cli_path()
            if native_codex is not None:
                os.environ["PATH"] = str(native_codex.parent) + os.pathsep + os.environ.get("PATH", "")
            os.environ.pop("ELECTRON_RUN_AS_NODE", None)
        synthetic_source = live.source_mode == "temporary_git_baseline"
        config = RunConfig(
            workspace_root=repo.parent,
            repo_path=repo,
            task_file=task_file,
            allowed_globs=request.allowed_globs,
            test_commands=request.test_commands,
            max_repair_rounds=request.max_repair_rounds,
            max_files=request.max_files,
            max_diff_lines=request.max_diff_lines,
            worker_timeout_seconds=float(request.worker_timeout_seconds),
            worker=request.worker,
            execution_mode="in-place" if synthetic_source else request.execution_mode,
            apply_patch=False if synthetic_source else request.apply_patch,
            run_id=live.run_id,
        )
        outcome = AgentReviewRunner().run(config)
        report = to_dict(outcome.evidence_report)
        report["source_mode"] = live.source_mode
        report["source_path"] = str(source)
        if synthetic_source:
            if not request.apply_patch:
                report["writeback"] = {"status": "NOT_REQUESTED", "applied": False, "files": []}
            elif report.get("final_decision") != "PASS":
                report["writeback"] = {"status": "SKIPPED_NOT_PASS", "applied": False, "files": []}
            else:
                report["writeback"] = apply_non_git_changes(live)
        else:
            applied = bool(request.apply_patch and report.get("final_decision") == "PASS")
            report["writeback"] = {
                "status": "APPLIED" if applied else "NOT_REQUESTED",
                "applied": applied,
                "files": report.get("changed_files", []) if applied else [],
            }
        live.report = report
        live.status = report.get("final_decision", "COMPLETED")
        live.emit("report", report)
        live.emit("run", {"status": live.status, "message": "真实 EvidenceReport 已生成。"})
    except Exception as exc:  # surface the backend failure without leaking a traceback to the browser
        live.status = "FAILED"
        live.error = safe_text(exc, 3000)
        # Do not use the reserved browser SSE event name "error": EventSource
        # also emits it for transport disconnects, which carries no JSON data.
        live.emit("runtime_error", {"message": live.error})
    finally:
        active_live_run.reset(context_token)
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        live.finished_at = time.time()
        execution_lock.release()


def read_codex_config() -> dict[str, Any]:
    config_path = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "config.toml"
    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return {}
    return config if isinstance(config, dict) else {}


def configured_codex_cli_path() -> Path | None:
    configured = os.environ.get("CODEX_CLI_PATH", "").strip()
    if not configured:
        config = read_codex_config()
        mcp_servers = config.get("mcp_servers", {})
        if isinstance(mcp_servers, dict):
            node_repl = mcp_servers.get("node_repl", {})
            if isinstance(node_repl, dict):
                node_env = node_repl.get("env", {})
                if isinstance(node_env, dict):
                    configured = str(node_env.get("CODEX_CLI_PATH", "")).strip()
    if not configured:
        return None
    path = Path(configured).expanduser().resolve()
    return path if path.is_file() else None


def codex_model_settings() -> dict[str, str]:
    configured_model = os.environ.get("AGENT_REVIEW_CODEX_MODEL", "").strip()
    settings = {"model": configured_model, "reasoning_effort": "", "service_tier": ""}
    if configured_model:
        return settings
    config = read_codex_config()
    settings["model"] = str(config.get("model", ""))
    settings["reasoning_effort"] = str(config.get("model_reasoning_effort", ""))
    settings["service_tier"] = str(config.get("service_tier", ""))
    return settings


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "agentguard_root": str(AGENTGUARD_ROOT), "codex": codex_model_settings()}


PROJECT_TREE_IGNORED = {
    ".git", ".agent-review", ".idea", ".vscode", "__pycache__", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", "node_modules", "dist", "build", "coverage",
    ".next", ".venv", "venv", "target",
}


def build_project_tree(root: Path, max_depth: int = 4, max_nodes: int = 500) -> list[dict[str, Any]]:
    """Return a bounded, metadata-only tree for the local project explorer."""
    node_count = 0

    def visit(folder: Path, depth: int) -> list[dict[str, Any]]:
        nonlocal node_count
        if depth > max_depth or node_count >= max_nodes:
            return []
        try:
            entries = sorted(
                (entry for entry in folder.iterdir() if entry.name not in PROJECT_TREE_IGNORED),
                key=lambda entry: (not entry.is_dir(), entry.name.lower()),
            )
        except OSError:
            return []

        nodes: list[dict[str, Any]] = []
        for entry in entries:
            if node_count >= max_nodes:
                break
            try:
                if entry.is_symlink():
                    continue
                is_directory = entry.is_dir()
            except OSError:
                continue
            node_count += 1
            relative = entry.relative_to(root).as_posix()
            node: dict[str, Any] = {
                "title": entry.name,
                "key": relative,
                "is_leaf": not is_directory,
            }
            if is_directory:
                children = visit(entry, depth + 1)
                if children:
                    node["children"] = children
            nodes.append(node)
        return nodes

    return visit(root, 0)


@app.post("/api/projects/inspect")
def inspect_project(request: ProjectRequest) -> dict[str, Any]:
    folder = Path(request.path).expanduser().resolve()
    if not folder.is_dir():
        raise HTTPException(400, "项目路径不存在或不是文件夹")
    return {
        "path": str(folder),
        "name": folder.name,
        "is_git": (folder / ".git").exists(),
        "tree": build_project_tree(folder),
    }


@app.post("/api/system/select-directory")
def select_directory() -> dict[str, Any]:
    """Open the native Windows folder picker on the machine hosting this app."""
    try:
        from tkinter import Tk, filedialog

        root = Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        selected = filedialog.askdirectory(title="选择要执行 AgentGuard 的项目文件夹")
        root.destroy()
    except Exception as exc:
        raise HTTPException(500, f"无法打开系统文件夹选择器：{safe_text(exc, 300)}") from exc

    if not selected:
        return {"cancelled": True}
    folder = Path(selected).resolve()
    return {"cancelled": False, "path": str(folder), "is_git": (folder / ".git").exists()}


def _write_demo_file(path: Path, content: str) -> None:
    """Create the deterministic demo baseline once, without overwriting user work."""
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


@app.post("/api/demos/vip-discount")
def create_vip_discount_demo() -> dict[str, Any]:
    """Create a small, executable business-bug repository for a live presentation."""
    repo = PROJECT_ROOT / "agentguard-live-console" / "demo-workspaces" / "vip-discount-drift-correction"
    _write_demo_file(repo / ".gitignore", ".agent-review/\n__pycache__/\n.pytest_cache/\n")
    _write_demo_file(repo / "src" / "__init__.py", "")
    _write_demo_file(
        repo / "src" / "pricing.py",
        '''def calculate_order_total(amount: float, is_vip: bool) -> float:
    """Return the payable amount for an order."""
    return amount  # Bug: the VIP discount is missing.
''',
    )
    _write_demo_file(
        repo / "tests" / "test_pricing.py",
        '''from src.pricing import calculate_order_total


def test_vip_order_gets_ten_percent_discount() -> None:
    assert calculate_order_total(200, True) == 180


def test_regular_order_keeps_original_price() -> None:
    assert calculate_order_total(200, False) == 200
''',
    )
    if not (repo / ".git").exists():
        try:
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
            subprocess.run(["git", "add", "."], cwd=repo, check=True, capture_output=True, text=True)
            subprocess.run(
                ["git", "-c", "user.name=AgentGuard Demo", "-c", "user.email=demo@agentguard.local", "commit", "-m", "Create VIP discount bug demo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )
        except (OSError, subprocess.CalledProcessError) as exc:
            raise HTTPException(500, f"无法初始化演示 Git 仓库：{safe_text(exc, 500)}") from exc

    return {
        "repo_path": str(repo),
        "task": "VIP discount correction: fix the order total so VIP customers receive a 10% discount. Modify only src/pricing.py and preserve all tests.",
        "allowed_globs": ["src/**"],
        "test_commands": ["python -m pytest -q"],
        "worker": "mock",
        "execution_mode": "isolated",
        "description": "订单 VIP 折扣缺失。演示 Worker 会先尝试越界改测试，监督器将拦截并回滚，再指导它只修改业务代码。",
    }


@app.get("/api/bootstrap")
def bootstrap() -> dict[str, Any]:
    """Optionally preload a presentation preset selected by the start script."""
    if os.environ.get("AGENTGUARD_DEMO", "").strip().lower() == "vip-discount":
        return {"demo": "vip-discount", "preset": create_vip_discount_demo()}
    return {"demo": "", "preset": None}


@app.post("/api/runs", status_code=202)
def create_run(request: RunRequest) -> dict[str, str]:
    repo = Path(request.repo_path).expanduser().resolve()
    if not repo.is_dir():
        raise HTTPException(400, "repo_path 不存在或不是文件夹")
    if not execution_lock.acquire(blocking=False):
        raise HTTPException(409, "当前已有 AgentGuard 运行在执行；请等待其结束后再启动下一次运行")
    run_id = uuid.uuid4().hex
    live = LiveRun(run_id=run_id, repo_path=repo)
    try:
        with runs_lock:
            runs[run_id] = live
        threading.Thread(target=run_agentguard, args=(live, request), daemon=True, name=f"agentguard-{run_id[:8]}").start()
    except Exception:
        execution_lock.release()
        raise
    return {"run_id": run_id, "status": live.status}


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    live = runs.get(run_id)
    if live is None:
        raise HTTPException(404, "未找到运行会话")
    return {"run_id": live.run_id, "repo_path": str(live.repo_path), "status": live.status, "report": live.report, "error": live.error}


@app.post("/api/runs/{run_id}/cancel")
def cancel_run(run_id: str) -> dict[str, str]:
    live = runs.get(run_id)
    if live is None:
        raise HTTPException(404, "未找到运行会话")
    request_cancel(live.working_repo_path or live.repo_path, run_id)
    live.emit("run", {"status": "CANCEL_REQUESTED", "message": "已向真实 AgentGuard 运行写入取消请求。"})
    return {"status": "CANCEL_REQUESTED"}


@app.get("/api/runs/{run_id}/events")
async def stream_events(run_id: str) -> StreamingResponse:
    live = runs.get(run_id)
    if live is None:
        raise HTTPException(404, "未找到运行会话")

    async def event_stream():
        yield "retry: 1500\n\n"
        while True:
            try:
                event = live.queue.get(timeout=0.5)
                yield f"event: {event['kind']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            except Empty:
                yield ": ping\n\n"
            if live.finished_at is not None and live.queue.empty():
                break
            await asyncio.sleep(0)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# The release/start script builds the Vite app before Uvicorn starts.  FastAPI
# then owns both the UI and API at one localhost address.
FRONTEND_DIST = PROJECT_ROOT / "agentguard-live-console" / "frontend" / "dist"
if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
else:
    @app.get("/")
    def frontend_not_built() -> dict[str, str]:
        return {
            "status": "frontend_not_built",
            "message": "Run the project start.ps1 script to build and serve the UI at this address.",
        }
