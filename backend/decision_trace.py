"""Build safe, user-facing decision traces from AgentGuard evidence.

These events are an audit trail of declared plans, observed actions and
supervisor decisions. They intentionally do not expose hidden model reasoning.
"""
from __future__ import annotations

import re
from typing import Any


PHASES = {
    "plan_contract": ("PLAN", "建立任务契约", "supervisor_assessment"),
    "plan": ("PLAN", "形成实施计划", "worker_declared"),
    "worker": ("ACTION", "Worker 完成一轮执行", "observed_action"),
    "action_events": ("ACTION", "记录文件与命令动作", "observed_action"),
    "inspection_coverage": ("INSPECT", "检查上下文覆盖", "supervisor_assessment"),
    "behavior_coverage": ("INSPECT", "检查行为覆盖", "supervisor_assessment"),
    "plan_adherence": ("RISK", "检查计划遵循情况", "supervisor_assessment"),
    "test_weakening_detection": ("RISK", "检查测试弱化风险", "supervisor_assessment"),
    "diff_gate": ("RISK", "检查补丁范围", "supervisor_assessment"),
    "security_gate": ("RISK", "检查安全风险", "supervisor_assessment"),
    "rollback": ("BLOCK", "回滚风险修改", "supervisor_assessment"),
    "repair_gate": ("REVISED_PLAN", "决定是否进入修复轮次", "supervisor_assessment"),
    "intervention": ("CORRECTION", "AgentGuard 发出纠正要求", "supervisor_assessment"),
    "verifier": ("VERIFY", "执行验证", "verification_evidence"),
    "final_review": ("DELIVER", "最终交付判定", "verification_evidence"),
}

SECRET_RE = re.compile(r"(?i)(api[_-]?key|token|authorization|password)\s*[:=]\s*\S+")
WINDOWS_USER_RE = re.compile(r"(?i)[A-Z]:\\Users\\[^\\\s\"']+")
WINDOWS_ABSOLUTE_RE = re.compile(r"(?i)\b[A-Z]:\\[^\"\r\n]*")
POSIX_HOME_RE = re.compile(r"/(?:home|Users)/[^/\s\"']+(?:/[^\s\"']*)?")


def _text(value: Any, limit: int = 360) -> str:
    text = str(value or "").replace("\x00", " ").replace("\r", " ").replace("\n", " ")
    text = SECRET_RE.sub(r"\1=[已脱敏]", text)
    text = WINDOWS_USER_RE.sub("%USERPROFILE%", text)
    text = WINDOWS_ABSOLUTE_RE.sub("[本地路径]", text)
    text = POSIX_HOME_RE.sub("[本地路径]", text)
    return " ".join(text.split())[:limit]


def _list(value: Any, limit: int = 6) -> list[str]:
    if not isinstance(value, list):
        return []
    return [_text(item, 180) for item in value[:limit] if _text(item, 180)]


def _decision(payload: dict[str, Any]) -> str:
    return _text(
        payload.get("decision")
        or payload.get("final_decision")
        or payload.get("status")
        or "OBSERVED",
        40,
    ).upper()


def _summary(stage: str, payload: dict[str, Any], decision: str) -> str:
    reasons = _list(payload.get("reasons"), 3)
    if reasons:
        return "；".join(reasons)
    if stage == "action_events":
        actions = payload.get("actions") if isinstance(payload.get("actions"), list) else []
        files = {
            _text(item.get("target"), 120)
            for item in actions
            if isinstance(item, dict) and str(item.get("action_type", "")).startswith("file_")
        }
        command_count = sum(
            1 for item in actions
            if isinstance(item, dict) and item.get("action_type") == "command_run"
        )
        parts = []
        if files:
            parts.append(f"观察到 {len(files)} 个文件动作")
        if command_count:
            parts.append(f"{command_count} 条命令")
        return "，".join(parts) or "已记录本轮 Worker 动作"
    if stage == "worker":
        changes = payload.get("file_changes") if isinstance(payload.get("file_changes"), list) else []
        commands = payload.get("command_events") if isinstance(payload.get("command_events"), list) else []
        return f"Worker 返回 {decision}；观察到 {len(changes)} 个文件变更、{len(commands)} 条命令"
    if stage == "intervention":
        return _text(payload.get("trigger_rule") or payload.get("correction_prompt") or "监督器要求修正当前方案")
    if stage == "repair_gate":
        return _text(payload.get("required_action") or ("允许进入下一轮修复" if decision == "ALLOW" else "修复预算已用尽"))
    if stage == "verifier":
        return _text(payload.get("summary") or f"验证状态：{decision}")
    if stage == "final_review":
        return _text(payload.get("diff_risk_summary") or payload.get("required_next_action") or f"最终判定：{decision}")
    return _text(
        payload.get("summary")
        or payload.get("message")
        or payload.get("reason")
        or payload.get("required_action")
        or f"阶段结果：{decision}"
    )


def decision_events_from_stage(event: dict[str, Any], lane: str) -> list[dict[str, Any]]:
    """Convert one persisted trace stage into one or more safe audit events."""
    stage = str(event.get("stage") or "")
    if stage not in PHASES:
        return []
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    phase, title, source = PHASES[stage]
    decision = _decision(payload)

    if stage in {"diff_gate", "security_gate", "plan_adherence", "test_weakening_detection"}:
        if decision in {"ALLOW", "PASS", "OK", "OBSERVED"}:
            phase = "INSPECT"
        elif decision in {"BLOCK", "FAIL", "INTERRUPT", "ROLLBACK_REQUIRED"}:
            phase = "BLOCK"
    if stage == "test_weakening_detection" and phase == "BLOCK":
        title = "检测到测试弱化风险"
    status = (
        "blocked" if decision in {"BLOCK", "FAIL", "INTERRUPT", "ROLLBACK_REQUIRED"}
        else "passed" if decision in {"ALLOW", "PASS", "OK"}
        else "observed"
    )
    related_files = _list(payload.get("offending_files") or payload.get("restored_files"))
    evidence = _list(payload.get("reasons") or payload.get("test_evidence"))
    required_action = _text(payload.get("required_action") or payload.get("correction_prompt"))

    summary = _summary(stage, payload, decision)
    if stage == "test_weakening_detection" and phase == "BLOCK":
        summary = "测试断言被删除、跳过或替换为无效验证，当前 PASS 结果不可信"
    result = [{
        "lane": lane,
        "phase": phase,
        "title": title,
        "summary": summary,
        "source": source,
        "status": status,
        "stage": stage,
        "decision": decision,
        "related_files": related_files,
        "evidence": evidence,
        "required_action": required_action,
    }]

    # Codex explicitly emitted this message; it is a public rationale, not
    # hidden chain-of-thought. Keep it short and label its source clearly.
    if stage == "worker" and payload.get("last_agent_message"):
        result.insert(0, {
            "lane": lane,
            "phase": "PLAN",
            "title": "Worker 公开说明",
            "summary": _text(payload.get("last_agent_message"), 420),
            "source": "worker_declared",
            "status": "observed",
            "stage": "worker_message",
            "decision": "DECLARED",
            "related_files": [],
            "evidence": [],
            "required_action": "",
        })
    return result


def complete_timeline(
    report: dict[str, Any],
    lane: str,
    events: list[dict[str, Any]],
    task: str,
) -> list[dict[str, Any]]:
    """Add report-only evidence while preserving the actual streamed order."""
    timeline = [dict(item) for item in events if item.get("lane") == lane]
    phases = {str(item.get("phase")) for item in timeline}
    if "PLAN" not in phases:
        timeline.insert(0, {
            "lane": lane, "phase": "PLAN", "title": "接收相同任务",
            "summary": _text(task), "source": "worker_declared", "status": "observed",
            "stage": "task", "decision": "DECLARED", "related_files": [], "evidence": [],
            "required_action": "",
        })

    if lane == "supervised" and not any(item.get("phase") == "CORRECTION" for item in timeline):
        interventions = report.get("interventions") if isinstance(report.get("interventions"), list) else []
        for intervention in interventions:
            if not isinstance(intervention, dict):
                continue
            trigger_stage = _text(intervention.get("trigger_stage"), 80)
            drift_types = _list(intervention.get("drift_types"))
            is_test_weakening = "TEST_WEAKENING" in drift_types
            correction_event = {
                "lane": lane,
                "phase": "CORRECTION",
                "title": "回滚弱化测试并纠正实现" if is_test_weakening else "AgentGuard 发出纠正要求",
                "summary": (
                    "Worker 通过修改测试获得表面 PASS；AgentGuard 已阻止结果并要求修复业务代码"
                    if is_test_weakening
                    else _text(intervention.get("trigger_rule") or "监督器要求修正当前方案")
                ),
                "source": "supervisor_assessment",
                "status": "blocked",
                "stage": "intervention",
                "decision": _text(intervention.get("after_status") or "REPAIR_REQUESTED", 40).upper(),
                "related_files": _list(intervention.get("offending_files")),
                "evidence": _list(intervention.get("action_taken")),
                "required_action": _text(intervention.get("correction_prompt"), 420),
            }
            insert_at = len(timeline)
            for index, item in enumerate(timeline):
                if item.get("phase") == "REVISED_PLAN":
                    insert_at = index
                    break
                if trigger_stage and item.get("stage") == trigger_stage:
                    insert_at = index + 1
            timeline.insert(insert_at, correction_event)
    files = _list(report.get("changed_files"), 12)
    if files and not any(item.get("stage") == "delivery_changes" for item in timeline):
        timeline.append({
            "lane": lane, "phase": "ACTION", "title": "形成候选修改",
            "summary": f"实际修改 {len(files)} 个文件", "source": "observed_action",
            "status": "observed", "stage": "delivery_changes", "decision": "OBSERVED",
            "related_files": files, "evidence": [], "required_action": "",
        })

    evaluation = report.get("delivery_evaluation") if isinstance(report.get("delivery_evaluation"), dict) else {}
    if evaluation:
        score = evaluation.get("score")
        result = str(evaluation.get("status") or "UNKNOWN")
        timeline.append({
            "lane": lane, "phase": "VERIFY", "title": "统一事后功能验收",
            "summary": f"验收状态 {result}" + (f"，得分 {score}/100" if isinstance(score, (int, float)) else ""),
            "source": "verification_evidence", "status": "passed" if result == "PASS" else "blocked",
            "stage": "delivery_evaluation", "decision": result, "related_files": [],
            "evidence": _list([item.get("label") for item in evaluation.get("checks", []) if isinstance(item, dict) and item.get("passed")], 5),
            "required_action": "",
        })

    if lane == "direct":
        weakening = report.get("passive_test_weakening") if isinstance(report.get("passive_test_weakening"), dict) else {}
        risks = [*_list(report.get("passive_security_findings"))]
        risk_title = "事后发现未处理风险"
        if weakening.get("detected"):
            risk_title = "检测到测试弱化"
            risks.insert(0, _text(weakening.get("summary") or "测试被弱化，PASS 结果不可信"))
        if report.get("passive_forbidden_path_touch"):
            risks.append("修改了明确禁止变更的路径")
        if risks:
            timeline.append({
                "lane": lane, "phase": "RISK", "title": risk_title,
                "summary": "；".join(risks[:3]), "source": "supervisor_assessment",
                "status": "blocked", "stage": "passive_audit", "decision": "NOT_CORRECTED",
                "related_files": _list(weakening.get("files")),
                "evidence": _list(weakening.get("evidence")) or risks[:5],
                "required_action": "Direct 模式不会阻止或纠正该风险",
            })

    decision = _text(report.get("final_decision") or "COMPLETED", 40).upper()
    timeline.append({
        "lane": lane, "phase": "DELIVER", "title": "运行结果",
        "summary": (
            f"Direct 直接交付：{decision}" if lane == "direct"
            else f"AgentGuard 监督判定：{decision}"
        ),
        "source": "verification_evidence", "status": "passed" if decision == "PASS" else "blocked",
        "stage": "run_result", "decision": decision, "related_files": files,
        "evidence": [], "required_action": _text(report.get("required_next_action")),
    })
    return timeline
