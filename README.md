# AgentGuard 编程监督工作台

这是一个可实际使用的本地编程页面，不是静态案例看板。用户可以打开任意本地 Git 项目或普通文件夹，通过对话提交编程任务，并实时查看 AgentGuard 的计划约束、AI 执行、监督介入、回滚、测试和最终证据报告。

## 启动

激活同时包含 Python 3.11+ 和 Node.js 22 的 Conda 环境，然后执行：

```powershell
cd agentguard-live-console
.\start.ps1
```

浏览器访问：

```text
http://127.0.0.1:8000/
```

首次运行前安装依赖：

```powershell
pip install -r .\backend\requirements.txt
cd .\frontend
npm install
```

## 使用流程

1. 点击“打开项目”并选择一个本地 Git 项目或普通文件夹。
2. 在设置中选择 Worker、模型、隔离模式、允许写入路径和验证命令。
3. 在对话框中描述编程任务并发送。
4. 在右侧查看真实监督阶段；运行结束后，EvidenceReport 会回到对话中。
5. 可以继续发送下一条任务；最近几轮对话会作为上下文送入新的监督运行。

默认使用隔离工作区并且不写回原项目。需要实际修改项目时，在设置中开启“完成后应用补丁”。API Key 只保存在当前页面状态中，不写入浏览器存储或 EvidenceReport。

## 主要接口

- `POST /api/system/select-directory`：打开本机文件夹选择器。
- `POST /api/projects/inspect`：只读返回有限深度的项目文件树和 Git 状态。
- `POST /api/runs`：创建真实 AgentGuard 运行。
- `GET /api/runs/{run_id}/events`：通过 SSE 推送运行、监督阶段和报告。
- `POST /api/runs/{run_id}/cancel`：在安全检查点请求停止运行。

Git 项目直接使用现有基线。普通文件夹会被只读复制到系统临时目录下的 `agentguard-live-console/non-git-runs`，后台在临时副本中建立 Git 基线，因此不会在用户目录创建 `.git`。依赖目录、构建产物、缓存、`logs` 和目录联接不会复制。写回前会比较源文件哈希；检测到运行期间的并发修改时拒绝覆盖。
