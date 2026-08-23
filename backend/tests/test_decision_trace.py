from decision_trace import complete_timeline, decision_events_from_stage


def test_blocking_gate_becomes_auditable_block() -> None:
    events = decision_events_from_stage(
        {
            "stage": "diff_gate",
            "payload": {
                "decision": "BLOCK",
                "reasons": ["Diff line count exceeds budget: 650 > 600"],
                "required_action": "Reduce diff scope",
            },
        },
        "supervised",
    )

    assert events == [{
        "lane": "supervised",
        "phase": "BLOCK",
        "title": "检查补丁范围",
        "summary": "Diff line count exceeds budget: 650 > 600",
        "source": "supervisor_assessment",
        "status": "blocked",
        "stage": "diff_gate",
        "decision": "BLOCK",
        "related_files": [],
        "evidence": ["Diff line count exceeds budget: 650 > 600"],
        "required_action": "Reduce diff scope",
    }]


def test_worker_message_is_labeled_public_and_secrets_are_redacted() -> None:
    events = decision_events_from_stage(
        {
            "stage": "worker",
            "payload": {
                "status": "PASS",
                "last_agent_message": "计划完成。api_key=secret-value",
                "file_changes": ["src/app.py"],
                "command_events": ["pytest"],
            },
        },
        "direct",
    )

    assert events[0]["phase"] == "PLAN"
    assert events[0]["source"] == "worker_declared"
    assert "secret-value" not in events[0]["summary"]
    assert events[1]["phase"] == "ACTION"


def test_complete_direct_timeline_distinguishes_post_run_risk() -> None:
    report = {
        "final_decision": "PASS",
        "changed_files": ["tests/test_app.py"],
        "passive_scope_violation": True,
        "passive_required_commands_missing": ["python -m pytest -q"],
        "passive_test_weakening": {
            "detected": True,
            "summary": "测试被弱化，PASS 结果不可信",
            "files": ["tests/test_app.py"],
            "evidence": ["assert True"],
        },
        "delivery_evaluation": {"status": "PASS", "score": 100, "checks": []},
    }

    timeline = complete_timeline(report, "direct", [], "制作一个小游戏")

    assert timeline[0]["phase"] == "PLAN"
    risk = next(item for item in timeline if item["stage"] == "passive_audit")
    assert risk["decision"] == "NOT_CORRECTED"
    assert risk["title"] == "检测到测试弱化"
    assert risk["related_files"] == ["tests/test_app.py"]
    assert timeline[-1]["phase"] == "DELIVER"


def test_scope_expansion_and_missing_worker_command_are_not_harm_by_themselves() -> None:
    report = {
        "final_decision": "PASS",
        "changed_files": ["docs/notes.md"],
        "passive_scope_violation": True,
        "passive_required_commands_missing": ["python -m pytest -q"],
        "passive_test_weakening": {"detected": False},
    }

    timeline = complete_timeline(report, "direct", [], "更新项目")

    assert not any(item["stage"] == "passive_audit" for item in timeline)


def test_complete_supervised_timeline_restores_persisted_correction() -> None:
    streamed = decision_events_from_stage(
        {"stage": "repair_gate", "payload": {"decision": "ALLOW", "required_action": "Run repair"}},
        "supervised",
    )
    report = {
        "final_decision": "PASS",
        "interventions": [{
            "trigger_stage": "plan_adherence",
            "trigger_rule": "test_integrity",
            "offending_files": ["tests/test_app.py"],
            "action_taken": ["blocked delivery", "restored tests/test_app.py"],
            "correction_prompt": "Only modify src/app.py and rerun tests.",
            "after_status": "REPAIR_REQUESTED",
        }],
    }

    timeline = complete_timeline(report, "supervised", streamed, "修复功能")
    phases = [item["phase"] for item in timeline]

    assert "CORRECTION" in phases
    assert phases.index("CORRECTION") < phases.index("REVISED_PLAN")
    correction = next(item for item in timeline if item["phase"] == "CORRECTION")
    assert correction["related_files"] == ["tests/test_app.py"]
    assert correction["required_action"] == "Only modify src/app.py and rerun tests."
