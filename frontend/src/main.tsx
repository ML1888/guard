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
  FileOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  LoadingOutlined,
  RobotOutlined,
  SafetyCertificateFilled,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  UserOutlined,
} from "@ant-design/icons";
import "antd/dist/reset.css";
import "./styles.css";

type RunState = "IDLE" | "QUEUED" | "RUNNING" | "PASS" | "FAIL" | "NEEDS_HUMAN" | "FAILED" | "CANCEL_REQUESTED";
type Trace = { stage: string; status: string; started_at: string; duration_ms: number; payload: Record<string, unknown> };
type RunEvent = { id: string; kind: "run" | "trace" | "report" | "runtime_error"; at: number; payload: Trace | Record<string, unknown> };
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

function Console() {
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
    setRunState("IDLE");
    if (!inspected.data.is_git) messageApi.success("已打开普通文件夹，运行时将自动创建临时监督基线");
    else messageApi.success(`已打开 ${inspected.data.name}`);
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

    (["run", "trace", "report", "runtime_error"] as const).forEach((kind) => {
      stream.addEventListener(kind, (raw) => {
        if (!(raw instanceof MessageEvent)) return;
        let event: RunEvent;
        try { event = JSON.parse(raw.data) as RunEvent; } catch { return; }
        if (event.kind === "run") {
          const payload = asRecord(event.payload);
          const nextState = String(payload.status || "RUNNING") as RunState;
          setRunState(nextState);
          updateMessage(assistantId, { content: String(payload.message || "AgentGuard 正在运行"), status: nextState });
        }
        if (event.kind === "trace") {
          const trace = event.payload as Trace;
          setTraces((old) => [...old, trace]);
          updateMessage(assistantId, {
            content: `${stageNames[trace.stage] || trace.stage}\n${payloadText(trace.payload)}`,
            status: "RUNNING",
          });
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
        <span className={`connection ${apiOnline === true ? "online" : apiOnline === false ? "offline" : ""}`}>
          <i />{apiOnline === true ? "服务已连接" : apiOnline === false ? "服务未连接" : "连接中"}
        </span>
        <Tag color="green" icon={<SafetyCertificateFilled />}>监督启用</Tag>
        <Tooltip title="任务设置"><Button type="text" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} /></Tooltip>
      </div>
    </header>

    <div className="workspace">
      <aside className="project-sidebar">
        <div className="pane-title"><span>项目</span><Tooltip title="打开项目"><Button type="text" size="small" icon={<FolderOpenOutlined />} onClick={pickProject} disabled={isRunning} /></Tooltip></div>
        {project ? <>
          <div className="project-meta">
            <b>{project.name}</b>
            <Tooltip title={project.path}><span>{project.path}</span></Tooltip>
          </div>
          {!project.is_git && <Alert type="info" showIcon message="使用临时监督基线" description="不会在源文件夹创建 .git" />}
          <div className="file-tree">
            <Tree showIcon blockNode defaultExpandAll={false} treeData={treeData} />
          </div>
        </> : <div className="project-empty"><FolderOpenOutlined /><span>未打开项目</span></div>}
        <div className="sidebar-footer">
          <span>执行方式</span><b>{!project?.is_git ? "临时监督基线" : settings.execution_mode === "isolated" ? "隔离工作区" : "原地执行"}</b>
          <span>写回项目</span><b>{settings.apply_patch ? "是" : "否"}</b>
        </div>
      </aside>

      <main className="chat-pane">
        <div className="chat-toolbar">
          <div><b>{project?.name || "新任务"}</b><span>{runId ? `运行 ${runId.slice(0, 8)}` : "AgentGuard 会话"}</span></div>
          <Space size={4}>
            {isRunning && <Tooltip title="停止任务"><Button danger type="text" icon={<StopOutlined />} onClick={cancelRun} /></Tooltip>}
            <Tooltip title="清空对话"><Button type="text" icon={<DeleteOutlined />} disabled={isRunning || messages.length === 0} onClick={clearConversation} /></Tooltip>
          </Space>
        </div>

        <section className="message-list">
          {messages.length === 0 ? <div className="welcome-state">
            <span className="welcome-mark"><RobotOutlined /></span>
            <h1>准备开始</h1>
            <div className="suggestion-list">
              {suggestions.map((item) => <button key={item} disabled={!project} onClick={() => sendMessage(item)}>{item}<SendOutlined /></button>)}
            </div>
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
                <span>{settings.apply_patch ? "完成后写回" : "仅生成补丁"}</span>
              </div>
              <Tooltip title={isRunning ? "任务正在运行" : "发送任务"}>
                <Button type="primary" shape="circle" icon={isRunning ? <LoadingOutlined spin /> : <SendOutlined />} disabled={!project || !prompt.trim() || isRunning} onClick={() => sendMessage()} />
              </Tooltip>
            </div>
          </div>
        </div>
      </main>

      <aside className="supervision-pane">
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
      </aside>
    </div>

    <Drawer title="任务与模型设置" open={settingsOpen} onClose={() => setSettingsOpen(false)} width={480}>
      <Form layout="vertical">
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
        <Form.Item label="执行模式"><Segmented block value={settings.execution_mode} onChange={(execution_mode) => setSettings((old) => ({ ...old, execution_mode: execution_mode as Settings["execution_mode"] }))} options={[{ label: "隔离工作区", value: "isolated" }, { label: "原地执行", value: "in-place" }]} /></Form.Item>
        <div className="setting-switch"><div><b>完成后应用补丁</b><span>通过监督门禁后写回所选项目</span></div><Switch checked={settings.apply_patch} onChange={(apply_patch) => setSettings((old) => ({ ...old, apply_patch }))} /></div>
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
