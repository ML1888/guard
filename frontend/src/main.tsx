import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import axios from "axios";
import {
  Alert,
  Button,
  ConfigProvider,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Tooltip,
  Tree,
  Typography,
  message,
} from "antd";
import {
  BranchesOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DeleteOutlined,
  ExperimentOutlined,
  FileOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  LoadingOutlined,
  RobotOutlined,
  SafetyCertificateFilled,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  ThunderboltOutlined,
  UserOutlined,
  WarningFilled,
} from "@ant-design/icons";
import "antd/dist/reset.css";
import "./styles.css";

type RunState = "IDLE" | "QUEUED" | "RUNNING" | "PASS" | "FAIL" | "NEEDS_HUMAN" | "FAILED" | "CANCEL_REQUESTED";
type Trace = { stage: string; status: string; started_at: string; duration_ms: number; payload: Record<string, unknown>; lane?: "direct" | "supervised" };
type RunEvent = { id: string; kind: "run" | "trace" | "report" | "runtime_error" | "comparison" | "lane_report" | "comparison_report"; at: number; payload: Trace | Record<string, unknown> };
type ProjectNode = { title: string; key: string; is_leaf: boolean; children?: ProjectNode[] };
type ProjectInfo = { path: string; name: string; is_git: boolean; tree: ProjectNode[] };
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status?: RunState;
  report?: Record<string, unknown>;
};

type Settings = {
  worker: "codex" | "mock" | "agentless";
  model: string;
  api_base_url: string;
  api_key: string;
  execution_mode: "isolated" | "in-place";
  apply_patch: boolean;
  allowed_globs: string;
  test_commands: string;
  max_repair_rounds: number;
  max_files: number;
  max_diff_lines: number;
  worker_timeout_seconds: number;
};

type WorkspaceMode = "supervised" | "comparison";
type ComparisonLane = { status: string; message: string; report: Record<string, unknown> | null };
type ComparisonLanes = { direct: ComparisonLane; supervised: ComparisonLane };

const emptyComparisonLanes = (): ComparisonLanes => ({
  direct: { status: "WAITING", message: "等待直接运行", report: null },
  supervised: { status: "WAITING", message: "等待 AgentGuard", report: null },
});

const api = axios.create({ baseURL: "/api" });

const defaultSettings: Settings = {
  worker: "codex",
  model: "",
  api_base_url: "",
  api_key: "",
  execution_mode: "isolated",
  apply_patch: false,
  allowed_globs: "**/*",
  test_commands: "",
  max_repair_rounds: 3,
  max_files: 8,
  max_diff_lines: 600,
  worker_timeout_seconds: 600,
};

const stageNames: Record<string, string> = {
  preflight: "环境预检",
  workspace_snapshot: "工作区快照",
  repo_index: "仓库索引",
  spec: "需求解析",
  context_selection: "上下文选择",
  knowledge_retrieval: "项目知识检索",
  plan_contract: "计划契约",
  code_localization: "代码定位",
  plan: "执行计划",
  plan_gate: "计划门禁",
  worker: "AI 编程执行",
  test_weakening_detection: "测试弱化检查",
  plan_adherence: "计划遵循检查",
  action_events: "动作审计",
  inspection_coverage: "检查覆盖率",
  behavior_coverage: "行为覆盖率",
  rollback: "安全回滚",
  repair_gate: "修复门禁",
  diff_gate: "差异门禁",
  security_gate: "安全门禁",
  verifier: "测试验证",
  final_review: "最终复核",
  intervention: "监督介入",
  write_report: "证据报告",
};

const stateLabels: Record<RunState, string> = {
  IDLE: "就绪",
  QUEUED: "排队中",
  RUNNING: "运行中",
  PASS: "已通过",
  FAIL: "未通过",
  NEEDS_HUMAN: "需要确认",
  FAILED: "运行失败",
  CANCEL_REQUESTED: "正在停止",
};

const suggestions = ["修复当前失败的测试", "检查并修复类型错误", "实现项目中的 TODO"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function payloadText(payload: Record<string, unknown>) {
  const values = [payload.message, payload.summary, payload.required_action, payload.reason, payload.decision];
  return String(values.find((item) => typeof item === "string" && item.trim()) || "监督阶段已完成");
}

function finalMessage(report: Record<string, unknown>) {
  const decision = String(report.final_decision || "COMPLETED");
  const files = stringList(report.changed_files);
  const evidence = stringList(asRecord(report.final_review).test_evidence);
  const parts = [`任务运行结束，监督结论为 ${decision}。`];
  if (files.length) parts.push(`变更文件：${files.join("、")}。`);
  if (evidence.length) parts.push(`验证证据：${evidence.join("；")}。`);
  return parts.join("\n");
}

function normalizeTree(nodes: ProjectNode[]): Array<Record<string, unknown>> {
  return nodes.map((node) => ({
    title: node.title,
    key: node.key,
    isLeaf: node.is_leaf,
    icon: node.is_leaf ? <FileOutlined /> : <FolderOutlined />,
    children: node.children ? normalizeTree(node.children) : undefined,
  }));
}

function ReportDetails({ report }: { report: Record<string, unknown> }) {
  const review = asRecord(report.final_review);
  const rollback = asRecord(report.rollback);
  const writeback = asRecord(report.writeback);
  const files = stringList(report.changed_files);
  const evidence = stringList(review.test_evidence);
  const interventions = Array.isArray(report.interventions) ? report.interventions.length : 0;
  const decision = String(report.final_decision || "UNKNOWN");
  const writebackStatus = String(writeback.status || "NOT_REQUESTED");
  const writebackLabels: Record<string, string> = {
    APPLIED: "已安全写回源项目",
    NOT_REQUESTED: "未请求写回源项目",
    NO_CHANGES: "没有需要写回的变更",
    SKIPPED_NOT_PASS: "监督未通过，未写回源项目",
    CONFLICT: "源文件发生变化，已拒绝覆盖",
  };
  return <div className="report-summary">
    <div className="report-header">
      <Tag color={decision === "PASS" ? "success" : decision === "NEEDS_HUMAN" ? "warning" : "error"}>{decision}</Tag>
      <span>{writebackLabels[writebackStatus] || writebackStatus}</span>
    </div>
    <Descriptions size="small" column={2} colon={false}>
      <Descriptions.Item label="变更文件">{files.length || 0}</Descriptions.Item>
      <Descriptions.Item label="监督介入">{interventions}</Descriptions.Item>
      <Descriptions.Item label="验证状态">{String(report.verification_status || "UNKNOWN")}</Descriptions.Item>
      <Descriptions.Item label="回滚状态">{String(rollback.status || "无")}</Descriptions.Item>
    </Descriptions>
    {files.length > 0 && <div className="report-list"><b>文件</b>{files.map((file) => <code key={file}>{file}</code>)}</div>}
    {evidence.length > 0 && <div className="report-list"><b>验证</b>{evidence.map((item) => <span key={item}>{item}</span>)}</div>}
  </div>;
}

function ComparisonBoard({ lanes, traces, running }: { lanes: ComparisonLanes; traces: Trace[]; running: boolean }) {
  const direct = lanes.direct.report;
  const supervised = lanes.supervised.report;
  const directFiles = direct ? stringList(direct.changed_files) : [];
  const supervisedFiles = supervised ? stringList(supervised.changed_files) : [];
  const directReview = asRecord(direct?.final_review);
  const supervisedReview = asRecord(supervised?.final_review);
  const directEvidence = stringList(directReview.test_evidence);
  const supervisedEvidence = stringList(supervisedReview.test_evidence);
  const directScopeViolation = Boolean(direct?.passive_scope_violation || direct?.passive_forbidden_path_touch);
  const directSecurity = direct ? stringList(direct.passive_security_findings) : [];
  const directMissing = direct ? stringList(direct.passive_required_commands_missing) : [];
  const interventions = supervised && Array.isArray(supervised.interventions) ? supervised.interventions.length : 0;
  const rollback = asRecord(supervised?.rollback);
  const rollbackApplied = Boolean(rollback.rollback_applied);
  const directDecision = String(direct?.final_decision || (running ? "RUNNING" : "WAITING"));
  const supervisedDecision = String(supervised?.final_decision || (running ? "RUNNING" : "WAITING"));
  const directRisk = directScopeViolation || directSecurity.length > 0 || directMissing.length > 0;
  const supervisedTraceCount = traces.filter((item) => item.lane === "supervised").length;
  const directEvaluation = asRecord(direct?.delivery_evaluation);
  const supervisedEvaluation = asRecord(supervised?.delivery_evaluation);
  const directScore = typeof directEvaluation.score === "number" ? directEvaluation.score : null;
  const supervisedScore = typeof supervisedEvaluation.score === "number" ? supervisedEvaluation.score : null;

  let conclusion = "两侧将从同一份项目基线开始，结果不会写回源项目。";
  if (direct && supervised && directScore !== null && supervisedScore !== null && supervisedScore > directScore) {
    conclusion = `同一验收契约下，AgentGuard 自动验收得分比 Direct 高 ${supervisedScore - directScore} 分；失败证据触发了受监督的检查与纠正。`;
  } else if (direct && supervised && directRisk && (interventions > 0 || rollbackApplied)) {
    conclusion = "直接运行虽然可能显示 PASS，但存在越界或证据缺失；AgentGuard 已介入并回滚风险修改，交付结果更可信。";
  } else if (direct && supervised && directScore !== null && directScore === supervisedScore) {
    conclusion = `本次两侧自动验收得分同为 ${directScore}；AgentGuard 的额外价值体现在约束执行、证据链和可回滚性，而非人为制造 Direct 缺陷。`;
  } else if (direct && supervised) {
    conclusion = "本次任务没有匹配专用功能评价器；请结合项目测试、越界风险和监督证据判断结果。";
  }

  const lane = (
    kind: "direct" | "supervised",
    title: string,
    subtitle: string,
    laneState: ComparisonLane,
    report: Record<string, unknown> | null,
    decision: string,
    files: string[],
    evidence: string[],
  ) => {
    const isDirect = kind === "direct";
    const evaluation = asRecord(report?.delivery_evaluation);
    const metrics = asRecord(report?.execution_metrics);
    const score = typeof evaluation.score === "number" ? evaluation.score : null;
    const checks = Array.isArray(evaluation.checks) ? evaluation.checks.map(asRecord) : [];
    const failedChecks = checks.filter((item) => !item.passed);
    const previewUrl = String(evaluation.preview_url || "");
    const elapsed = typeof metrics.elapsed_seconds === "number" ? `${metrics.elapsed_seconds.toFixed(1)}s` : "—";
    const attempts = typeof metrics.worker_attempts === "number" ? metrics.worker_attempts : 1;
    const decisionColor = decision === "PASS" && (!isDirect || !directRisk) ? "success" : decision === "RUNNING" ? "processing" : decision === "WAITING" ? "default" : "warning";
    return <section className={`comparison-lane ${kind}`}>
      <div className="lane-header">
        <span className="lane-icon">{isDirect ? <ThunderboltOutlined /> : <SafetyCertificateFilled />}</span>
        <div><b>{title}</b><span>{subtitle}</span></div>
        <Tag color={decisionColor}>{isDirect && decision === "PASS" && directRisk ? "表面 PASS" : decision}</Tag>
      </div>
      <div className="lane-status"><i className={laneState.status.toLowerCase()} />{laneState.message}</div>
      <div className="lane-metrics">
        <div><span>自动验收</span><b>{score === null ? "未评测" : `${score}/100`}</b></div>
        <div><span>缺失能力</span><b>{score === null ? "—" : failedChecks.length}</b></div>
        <div><span>运行耗时</span><b>{elapsed}</b></div>
        <div><span>{isDirect ? "事后风险" : "监督介入"}</span><b>{isDirect ? Number(directRisk) : interventions}</b></div>
      </div>
      <div className="lane-evidence">
        {!report && <Skeleton active paragraph={{ rows: 4 }} title={false} />}
        {report && <>
          {isDirect && <div className={`finding ${directRisk ? "danger" : "ok"}`}>
            {directRisk ? <WarningFilled /> : <CheckCircleFilled />}
            <span>{directScopeViolation ? "检测到允许范围外的修改，但直接运行不会阻止它" : directRisk ? "存在未处理的交付风险" : "未发现明显越界修改"}</span>
          </div>}
          {!isDirect && <div className={`finding ${interventions || rollbackApplied ? "protected" : "ok"}`}>
            <SafetyCertificateFilled />
            <span>{interventions || rollbackApplied ? `已执行 ${interventions} 次介入${rollbackApplied ? "并完成回滚" : ""}` : "监督门禁未发现需要阻止的行为"}</span>
          </div>}
          <div className="evidence-block"><b>实际修改</b>{files.length ? files.map((file) => <code key={file}>{file}</code>) : <span>无文件变更</span>}</div>
          <div className="evidence-block"><b>测试结果</b>{evidence.length ? evidence.map((item) => <span key={item}>{item}</span>) : <span>{String(report.verification_status || "UNKNOWN")}</span>}</div>
          {checks.length > 0 && <div className="contract-results">
            <div className="contract-title"><b>统一功能验收</b><span>{String(evaluation.passed || 0)}/{String(evaluation.total || checks.length)} 通过</span></div>
            {checks.map((item) => <div className={`contract-check ${item.passed ? "pass" : "fail"}`} key={String(item.id)}>
              {item.passed ? <CheckCircleFilled /> : <CloseCircleFilled />}
              <span><b>{String(item.label)}</b><small>{String(item.detail || "")}</small></span>
            </div>)}
            <small className="evaluation-limit">{String(evaluation.limitations || "")}</small>
          </div>}
          {isDirect && directSecurity.map((item) => <span className="risk-line" key={item}>{item}</span>)}
          {isDirect && directMissing.map((item) => <span className="risk-line" key={item}>Worker 未主动执行：{item}</span>)}
          {previewUrl && <div className="artifact-preview">
            <div><b>可操作成品</b><span>在隔离 iframe 中运行</span></div>
            <iframe src={previewUrl} title={`${title}成品预览`} sandbox="allow-scripts" />
          </div>}
        </>}
      </div>
      <div className="lane-footer">{isDirect ? `1 次 Worker · 监督门禁关闭 · 仅事后测量` : `${attempts} 次 Worker · ${supervisedTraceCount} 个监督阶段 · ${rollbackApplied ? "已执行安全回滚" : "具备回滚能力"}`}</div>
    </section>;
  };

  return <div className="comparison-board">
    <div className="comparison-conclusion"><ExperimentOutlined /><span><b>对比结论</b>{conclusion}</span></div>
    <div className="comparison-grid">
      {lane("direct", "无监督直接运行", "Raw Codex / Worker", lanes.direct, direct, directDecision, directFiles, directEvidence)}
      {lane("supervised", "AgentGuard 监督运行", "门禁、回滚与纠正", lanes.supervised, supervised, supervisedDecision, supervisedFiles, supervisedEvidence)}
    </div>
  </div>;
}

function Console() {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("supervised");
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [runState, setRunState] = useState<RunState>("IDLE");
  const [runId, setRunId] = useState("");
  const [traces, setTraces] = useState<Trace[]>([]);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [folderPicking, setFolderPicking] = useState(false);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [effectiveModel, setEffectiveModel] = useState("");
  const [comparisonLanes, setComparisonLanes] = useState<ComparisonLanes>(emptyComparisonLanes);
  const [demoLoading, setDemoLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const streamRef = useRef<EventSource | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const isRunning = ["QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(runState);

  useEffect(() => {
    api.get("/health").then(({ data }) => {
      setApiOnline(true);
      setEffectiveModel(String(data.codex?.model || "Codex 默认模型"));
    }).catch(() => setApiOnline(false));
    api.get("/bootstrap").then(async ({ data }) => {
      if (!data.preset?.repo_path) return;
      setSettings((old) => ({
        ...old,
        worker: data.preset.worker || old.worker,
        execution_mode: data.preset.execution_mode || old.execution_mode,
        allowed_globs: (data.preset.allowed_globs || ["**/*"]).join("\n"),
        test_commands: (data.preset.test_commands || []).join("\n"),
      }));
      setPrompt(data.preset.task || "");
      const inspected = await api.post("/projects/inspect", { path: data.preset.repo_path });
      setProject(inspected.data);
    }).catch(() => undefined);
    return () => streamRef.current?.close();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, traces.length]);

  const treeData = useMemo(() => project ? normalizeTree(project.tree) : [], [project]);

  const updateMessage = (id: string, patch: Partial<ChatMessage>) => {
    setMessages((old) => old.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  const inspectProject = async (path: string) => {
    const inspected = await api.post("/projects/inspect", { path });
    setProject(inspected.data);
    setMessages([]);
    setTraces([]);
    setReport(null);
    setComparisonLanes(emptyComparisonLanes());
    setRunState("IDLE");
    if (!inspected.data.is_git) messageApi.success("已打开普通文件夹，运行时将自动创建临时监督基线");
    else messageApi.success(`已打开 ${inspected.data.name}`);
  };

  const switchWorkspaceMode = (mode: WorkspaceMode) => {
    if (isRunning || mode === workspaceMode) return;
    setWorkspaceMode(mode);
    setMessages([]);
    setTraces([]);
    setReport(null);
    setComparisonLanes(emptyComparisonLanes());
    setRunId("");
    setRunState("IDLE");
  };

  const loadComparisonDemo = async () => {
    if (isRunning) return;
    setDemoLoading(true);
    try {
      const { data } = await api.post("/demos/supervision-comparison");
      setWorkspaceMode("comparison");
      setSettings((old) => ({
        ...old,
        worker: data.worker || "mock",
        apply_patch: false,
        allowed_globs: (data.allowed_globs || ["src/**"]).join("\n"),
        test_commands: (data.test_commands || []).join("\n"),
      }));
      setPrompt(String(data.task || ""));
      await inspectProject(String(data.repo_path));
      messageApi.success("已载入监督价值对比案例");
    } catch (error) {
      messageApi.error(axios.isAxiosError(error) ? String(error.response?.data?.detail || error.message) : "无法载入对比案例");
    } finally {
      setDemoLoading(false);
    }
  };

  const pickProject = async () => {
    if (isRunning) return;
    setFolderPicking(true);
    try {
      const selected = await api.post("/system/select-directory");
      if (!selected.data.cancelled) await inspectProject(selected.data.path);
    } catch (error) {
      const detail = axios.isAxiosError(error) ? String(error.response?.data?.detail || error.message) : "无法打开项目";
      messageApi.error(detail);
    } finally {
      setFolderPicking(false);
    }
  };

  const startStream = (id: string, assistantId: string) => {
    streamRef.current?.close();
    const stream = new EventSource(`/api/runs/${id}/events`);
    streamRef.current = stream;

    (["run", "trace", "report", "runtime_error", "comparison", "lane_report", "comparison_report"] as const).forEach((kind) => {
      stream.addEventListener(kind, (raw) => {
        if (!(raw instanceof MessageEvent)) return;
        let event: RunEvent;
        try { event = JSON.parse(raw.data) as RunEvent; } catch { return; }
        if (event.kind === "run") {
          const payload = asRecord(event.payload);
          const nextState = String(payload.status || "RUNNING") as RunState;
          setRunState(nextState);
          if (workspaceMode !== "comparison") updateMessage(assistantId, { content: String(payload.message || "AgentGuard 正在运行"), status: nextState });
          else updateMessage(assistantId, { status: nextState });
        }
        if (event.kind === "trace") {
          const trace = event.payload as Trace;
          setTraces((old) => [...old, trace]);
          if (workspaceMode !== "comparison") {
            updateMessage(assistantId, {
              content: `${stageNames[trace.stage] || trace.stage}\n${payloadText(trace.payload)}`,
              status: "RUNNING",
            });
          }
        }
        if (event.kind === "report") {
          const nextReport = asRecord(event.payload);
          const decision = String(nextReport.final_decision || "PASS") as RunState;
          setReport(nextReport);
          setRunState(decision);
          updateMessage(assistantId, { content: finalMessage(nextReport), status: decision, report: nextReport });
        }
        if (event.kind === "runtime_error") {
          const errorText = String(asRecord(event.payload).message || "运行失败");
          setRunState("FAILED");
          updateMessage(assistantId, { content: errorText, status: "FAILED" });
        }
        if (event.kind === "comparison") {
          const payload = asRecord(event.payload);
          const laneName = String(payload.lane);
          if (laneName === "direct" || laneName === "supervised") {
            setComparisonLanes((old) => ({
              ...old,
              [laneName]: { ...old[laneName], status: String(payload.status || "RUNNING"), message: String(payload.message || "运行中") },
            }));
          }
        }
        if (event.kind === "lane_report") {
          const payload = asRecord(event.payload);
          const laneName = String(payload.lane);
          const laneReport = asRecord(payload.report);
          if (laneName === "direct" || laneName === "supervised") {
            setComparisonLanes((old) => ({
              ...old,
              [laneName]: { status: String(laneReport.final_decision || "COMPLETED"), message: laneName === "direct" ? "直接运行已完成" : "监督运行已完成", report: laneReport },
            }));
          }
        }
        if (event.kind === "comparison_report") {
          const payload = asRecord(event.payload);
          const supervised = asRecord(payload.supervised);
          const decision = String(supervised.final_decision || "PASS") as RunState;
          setRunState(decision);
          updateMessage(assistantId, { content: "A/B 对比已完成。下方结果展示两种运行方式的实际差异。", status: decision });
        }
      });
    });
    stream.onerror = () => stream.close();
  };

  const sendMessage = async (override?: string) => {
    const task = (override ?? prompt).trim();
    if (!project) return void messageApi.warning("请先打开一个本地项目");
    if (task.length < 8) return void messageApi.warning("请更具体地描述编程任务");
    if (isRunning) return;

    const now = Date.now();
    const userId = `user-${now}`;
    const assistantId = `assistant-${now}`;
    setMessages((old) => [...old,
      { id: userId, role: "user", content: task, createdAt: now },
      { id: assistantId, role: "assistant", content: "正在建立任务契约并准备监督运行...", createdAt: now + 1, status: "QUEUED" },
    ]);
    setPrompt("");
    setTraces([]);
    setReport(null);
    setComparisonLanes(emptyComparisonLanes());
    setRunState("QUEUED");

    try {
      const result = await api.post("/runs", {
        repo_path: project.path,
        task,
        allowed_globs: settings.allowed_globs.split("\n").map((item) => item.trim()).filter(Boolean),
        test_commands: settings.test_commands.split("\n").map((item) => item.trim()).filter(Boolean),
        worker: settings.worker,
        max_repair_rounds: settings.max_repair_rounds,
        max_files: settings.max_files,
        max_diff_lines: settings.max_diff_lines,
        worker_timeout_seconds: settings.worker_timeout_seconds,
        execution_mode: settings.execution_mode,
        apply_patch: settings.apply_patch,
        model: settings.model,
        api_base_url: settings.api_base_url,
        api_key: settings.api_key,
        comparison_mode: workspaceMode === "comparison",
        conversation_history: messages.slice(-8).map((item) => ({
          role: item.role,
          content: item.content,
        })),
      });
      setRunId(result.data.run_id);
      startStream(result.data.run_id, assistantId);
    } catch (error) {
      const detail = axios.isAxiosError(error) ? String(error.response?.data?.detail || error.message) : "无法创建运行";
      setRunState("FAILED");
      updateMessage(assistantId, { content: detail, status: "FAILED" });
    }
  };

  const cancelRun = async () => {
    if (!runId || !isRunning) return;
    try {
      await api.post(`/runs/${runId}/cancel`);
      setRunState("CANCEL_REQUESTED");
    } catch (error) {
      messageApi.error(axios.isAxiosError(error) ? String(error.response?.data?.detail || error.message) : "无法停止任务");
    }
  };

  const clearConversation = () => {
    if (isRunning) return;
    setMessages([]);
    setTraces([]);
    setReport(null);
    setComparisonLanes(emptyComparisonLanes());
    setRunId("");
    setRunState("IDLE");
  };

  return <div className="console-shell">
    {contextHolder}
    <header className="app-header">
      <div className="app-brand">
        <span className="brand-mark"><SafetyCertificateFilled /></span>
        <div><b>AgentGuard</b><small>编程监督工作台</small></div>
      </div>
      <div className="header-project">
        <Button icon={<FolderOpenOutlined />} loading={folderPicking} disabled={isRunning} onClick={pickProject}>
          {project ? project.name : "打开项目"}
        </Button>
        {project && <Tag icon={<BranchesOutlined />} color={project.is_git ? "success" : "cyan"}>{project.is_git ? "Git 项目" : "普通文件夹"}</Tag>}
      </div>
      <div className="header-actions">
        <Segmented
          className="workspace-mode-switch"
          value={workspaceMode}
          disabled={isRunning}
          onChange={(value) => switchWorkspaceMode(value as WorkspaceMode)}
          options={[
            { label: "单次监督", value: "supervised", icon: <SafetyCertificateFilled /> },
            { label: "A/B 对比", value: "comparison", icon: <ExperimentOutlined /> },
          ]}
        />
        <span className={`connection ${apiOnline === true ? "online" : apiOnline === false ? "offline" : ""}`}>
          <i />{apiOnline === true ? "服务已连接" : apiOnline === false ? "服务未连接" : "连接中"}
        </span>
        <Tag color={workspaceMode === "comparison" ? "blue" : "green"} icon={workspaceMode === "comparison" ? <ExperimentOutlined /> : <SafetyCertificateFilled />}>{workspaceMode === "comparison" ? "同基线对比" : "监督启用"}</Tag>
        <Tooltip title="任务设置"><Button type="text" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} /></Tooltip>
      </div>
    </header>

    <div className={`workspace ${workspaceMode === "comparison" ? "compare-mode" : ""}`}>
      <aside className="project-sidebar">
        <div className="pane-title"><span>项目</span><Tooltip title="打开项目"><Button type="text" size="small" icon={<FolderOpenOutlined />} onClick={pickProject} disabled={isRunning} /></Tooltip></div>
        {project ? <>
          <div className="project-meta">
            <b>{project.name}</b>
            <Tooltip title={project.path}><span>{project.path}</span></Tooltip>
          </div>
          {workspaceMode === "comparison"
            ? <Alert type="info" showIcon message="同基线双运行" description="两个结果均不写回源项目" />
            : !project.is_git && <Alert type="info" showIcon message="使用临时监督基线" description="不会在源文件夹创建 .git" />}
          <div className="file-tree">
            <Tree showIcon blockNode defaultExpandAll={false} treeData={treeData} />
          </div>
        </> : <div className="project-empty"><FolderOpenOutlined /><span>未打开项目</span></div>}
        <div className="sidebar-footer">
          <span>执行方式</span><b>{workspaceMode === "comparison" ? "同基线双副本" : !project?.is_git ? "临时监督基线" : settings.execution_mode === "isolated" ? "隔离工作区" : "原地执行"}</b>
          <span>写回项目</span><b>{workspaceMode === "comparison" ? "否" : settings.apply_patch ? "是" : "否"}</b>
        </div>
      </aside>

      <main className="chat-pane">
        <div className="chat-toolbar">
          <div><b>{project?.name || "新任务"}</b><span>{runId ? `运行 ${runId.slice(0, 8)}` : "AgentGuard 会话"}</span></div>
          <Space size={4}>
            <Segmented
              className="mobile-mode-switch"
              size="small"
              value={workspaceMode}
              disabled={isRunning}
              onChange={(value) => switchWorkspaceMode(value as WorkspaceMode)}
              options={[
                { label: "监督", value: "supervised", icon: <SafetyCertificateFilled /> },
                { label: "对比", value: "comparison", icon: <ExperimentOutlined /> },
              ]}
            />
            {workspaceMode === "comparison" && <Button size="small" icon={<ExperimentOutlined />} loading={demoLoading} disabled={isRunning} onClick={loadComparisonDemo}>载入对比案例</Button>}
            {isRunning && <Tooltip title="停止任务"><Button danger type="text" icon={<StopOutlined />} onClick={cancelRun} /></Tooltip>}
            <Tooltip title="清空对话"><Button type="text" icon={<DeleteOutlined />} disabled={isRunning || messages.length === 0} onClick={clearConversation} /></Tooltip>
          </Space>
        </div>

        <section className="message-list">
          {messages.length === 0 ? <div className="welcome-state">
            <span className="welcome-mark">{workspaceMode === "comparison" ? <ExperimentOutlined /> : <RobotOutlined />}</span>
            <h1>{workspaceMode === "comparison" ? "比较监督前后的真实差异" : "准备开始"}</h1>
            {workspaceMode === "comparison"
              ? <Button type="primary" icon={<ExperimentOutlined />} loading={demoLoading} onClick={loadComparisonDemo}>载入监督价值案例</Button>
              : <div className="suggestion-list">{suggestions.map((item) => <button key={item} disabled={!project} onClick={() => sendMessage(item)}>{item}<SendOutlined /></button>)}</div>}
          </div> : messages.map((item) => <article key={item.id} className={`message-row ${item.role}`}>
            <div className="avatar">{item.role === "user" ? <UserOutlined /> : <SafetyCertificateFilled />}</div>
            <div className="message-content">
              <div className="message-author">
                <b>{item.role === "user" ? "你" : "AgentGuard"}</b>
                {item.status && <span className={`message-status ${item.status.toLowerCase()}`}>
                  {item.status === "RUNNING" || item.status === "QUEUED" ? <LoadingOutlined spin /> : item.status === "PASS" ? <CheckCircleFilled /> : ["FAIL", "FAILED"].includes(item.status) ? <CloseCircleFilled /> : null}
                  {stateLabels[item.status]}
                </span>}
              </div>
              <div className="message-text">{item.content}</div>
              {item.report && <ReportDetails report={item.report} />}
            </div>
          </article>)}
          {workspaceMode === "comparison" && messages.length > 0 && <ComparisonBoard lanes={comparisonLanes} traces={traces} running={isRunning} />}
          <div ref={chatEndRef} />
        </section>

        <div className="composer-wrap">
          <div className={`composer ${isRunning ? "disabled" : ""}`}>
            <Input.TextArea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onPressEnter={(event) => {
                if (!event.shiftKey) { event.preventDefault(); sendMessage(); }
              }}
              disabled={isRunning}
              autoSize={{ minRows: 2, maxRows: 7 }}
              placeholder={project ? "描述你希望完成的编程任务" : "请先打开项目"}
            />
            <div className="composer-footer">
              <div className="composer-mode">
                <Tag>{settings.worker === "codex" ? (settings.model || effectiveModel || "Codex Worker") : settings.worker}</Tag>
                <span>{workspaceMode === "comparison" ? "双副本 · 不写回" : settings.apply_patch ? "完成后写回" : "仅生成补丁"}</span>
              </div>
              <Tooltip title={isRunning ? "任务正在运行" : "发送任务"}>
                <Button type="primary" shape="circle" icon={isRunning ? <LoadingOutlined spin /> : <SendOutlined />} disabled={!project || !prompt.trim() || isRunning} onClick={() => sendMessage()} />
              </Tooltip>
            </div>
          </div>
        </div>
      </main>

      {workspaceMode === "supervised" && <aside className="supervision-pane">
        <div className="pane-title"><span>实时监督</span><Tag color={runState === "PASS" ? "success" : isRunning ? "processing" : runState === "FAILED" || runState === "FAIL" ? "error" : "default"}>{stateLabels[runState]}</Tag></div>
        <div className="run-overview">
          <span className={`run-indicator ${runState.toLowerCase()}`}>{isRunning ? <LoadingOutlined spin /> : runState === "PASS" ? <CheckCircleFilled /> : runState === "FAILED" || runState === "FAIL" ? <CloseCircleFilled /> : <SafetyCertificateFilled />}</span>
          <div><b>{stateLabels[runState]}</b><span>{traces.length} 个监督阶段</span></div>
        </div>
        <Divider />
        <div className="trace-list">
          {traces.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待任务" /> : traces.map((trace, index) => <div className="trace-item" key={`${trace.stage}-${index}`}>
            <span className={`trace-dot ${trace.status === "OK" ? "ok" : "warn"}`}>{trace.status === "OK" ? <CheckCircleFilled /> : <CloseCircleFilled />}</span>
            <div><b>{stageNames[trace.stage] || trace.stage}</b><p>{payloadText(trace.payload)}</p><small>{trace.duration_ms} ms</small></div>
          </div>)}
        </div>
        {report && <div className="final-evidence">
          <span>最终证据</span>
          <b>{String(report.functional_evidence || "UNKNOWN")}</b>
          <small>{stringList(report.changed_files).length} 个变更文件</small>
        </div>}
      </aside>}
    </div>

    <Drawer title="任务与模型设置" open={settingsOpen} onClose={() => setSettingsOpen(false)} width={480}>
      <Form layout="vertical">
        {workspaceMode === "comparison" && <Alert className="non-git-setting-note" type="info" showIcon message="A/B 对比模式" description="直接运行和监督运行使用同一基线的两个隔离副本，均不会写回源项目。" />}
        {project && !project.is_git && <Alert className="non-git-setting-note" type="info" showIcon message="当前为普通文件夹" description="AgentGuard 将在临时副本中建立 Git 基线；只有监督通过且开启写回时才修改源文件。" />}
        <Form.Item label="执行 Worker"><Select value={settings.worker} onChange={(worker) => setSettings((old) => ({ ...old, worker }))} options={[
          { value: "codex", label: "Codex Worker" },
          { value: "agentless", label: "Agentless Worker" },
          { value: "mock", label: "演示 Worker" },
        ]} /></Form.Item>
        <Form.Item label="模型"><Input value={settings.model} onChange={(event) => setSettings((old) => ({ ...old, model: event.target.value }))} placeholder={`留空使用 ${effectiveModel || "Codex 默认模型"}`} /></Form.Item>
        <Form.Item label="API 地址"><Input value={settings.api_base_url} onChange={(event) => setSettings((old) => ({ ...old, api_base_url: event.target.value }))} placeholder="可选：OpenAI 兼容端点" /></Form.Item>
        <Form.Item label="API Key"><Input.Password value={settings.api_key} onChange={(event) => setSettings((old) => ({ ...old, api_key: event.target.value }))} placeholder="仅在本次页面会话中使用" /></Form.Item>
        <Divider />
        <Form.Item label="执行模式"><Segmented block disabled={workspaceMode === "comparison"} value={workspaceMode === "comparison" ? "isolated" : settings.execution_mode} onChange={(execution_mode) => setSettings((old) => ({ ...old, execution_mode: execution_mode as Settings["execution_mode"] }))} options={[{ label: "隔离工作区", value: "isolated" }, { label: "原地执行", value: "in-place" }]} /></Form.Item>
        <div className="setting-switch"><div><b>完成后应用补丁</b><span>{workspaceMode === "comparison" ? "对比模式固定不写回" : "通过监督门禁后写回所选项目"}</span></div><Switch disabled={workspaceMode === "comparison"} checked={workspaceMode === "comparison" ? false : settings.apply_patch} onChange={(apply_patch) => setSettings((old) => ({ ...old, apply_patch }))} /></div>
        <Form.Item label="允许写入路径"><Input.TextArea rows={3} value={settings.allowed_globs} onChange={(event) => setSettings((old) => ({ ...old, allowed_globs: event.target.value }))} placeholder="每行一个 glob" /></Form.Item>
        <Form.Item label="验证命令"><Input.TextArea rows={3} value={settings.test_commands} onChange={(event) => setSettings((old) => ({ ...old, test_commands: event.target.value }))} placeholder="每行一条命令" /></Form.Item>
        <div className="numeric-settings">
          <Form.Item label="修复轮数"><InputNumber min={0} max={10} value={settings.max_repair_rounds} onChange={(value) => setSettings((old) => ({ ...old, max_repair_rounds: value || 0 }))} /></Form.Item>
          <Form.Item label="文件上限"><InputNumber min={1} max={100} value={settings.max_files} onChange={(value) => setSettings((old) => ({ ...old, max_files: value || 1 }))} /></Form.Item>
          <Form.Item label="差异行上限"><InputNumber min={20} max={20000} value={settings.max_diff_lines} onChange={(value) => setSettings((old) => ({ ...old, max_diff_lines: value || 20 }))} /></Form.Item>
          <Form.Item label="超时（秒）"><InputNumber min={30} max={3600} value={settings.worker_timeout_seconds} onChange={(value) => setSettings((old) => ({ ...old, worker_timeout_seconds: value || 30 }))} /></Form.Item>
        </div>
      </Form>
    </Drawer>
  </div>;
}

createRoot(document.getElementById("root")!).render(
  <ConfigProvider theme={{ token: { colorPrimary: "#16845b", borderRadius: 6, fontFamily: "Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif" } }}>
    <Console />
  </ConfigProvider>,
);
