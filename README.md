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

## A/B 监督对比

顶部切换到“A/B 对比”后，同一个项目基线和同一个任务会在两个隔离副本中依次运行：左侧是关闭所有监督门禁的直接 Worker，右侧是启用计划约束、范围检查、安全检查、回滚和纠正的 AgentGuard。两侧都会展示实际修改文件、测试证据和风险，且都不会写回源项目。

“载入监督价值案例”会创建一个临时的 VIP 折扣项目，并使用 `mock` Worker 稳定复现“直接运行通过修改测试获得表面 PASS，监督运行回滚越界修改并改正业务代码”。它用于快速说明监督机制，不代表真实 Codex 的随机输出。需要评估真实任务（例如开发五子棋）时，请打开自己的项目、选择 `codex` Worker，再在 A/B 模式提交任务；真实双运行不保证无监督侧一定违规，但可比较两侧产物和监督证据。

对于包含“五子棋”或 `gomoku` 的真实任务，后台会为 Direct 和 AgentGuard 生成完全相同的功能验收契约，并统一检查可运行入口、JavaScript 语法、棋盘尺寸、交替落子、重复落子保护、四方向胜负判断、获胜锁定、重新开始和移动端适配。Direct 只接受事后评分；AgentGuard 可以根据同一验证命令进入受监督修复流程。完成后页面会展示两侧自动验收得分、缺失能力、耗时和独立可操作预览。当前评价器属于结构与规则信号检查，不应替代完整的浏览器端到端测试，页面会明确显示这一限制。

## 主要接口

- `POST /api/system/select-directory`：打开本机文件夹选择器。
- `POST /api/projects/inspect`：只读返回有限深度的项目文件树和 Git 状态。
- `POST /api/runs`：创建真实 AgentGuard 运行。
- `POST /api/demos/supervision-comparison`：创建可复现的监督价值演示项目。
- `GET /api/runs/{run_id}/events`：通过 SSE 推送运行、监督阶段和报告。
- `POST /api/runs/{run_id}/cancel`：在安全检查点请求停止运行。

Git 项目直接使用现有基线。普通文件夹会被只读复制到工作区 D 盘下的 `.agentguard-runtime/non-git-runs`，后台在临时副本中建立 Git 基线，因此不会在用户目录创建 `.git`。演示项目、系统临时文件以及 npm、pip、Python、Hugging Face 等缓存也统一写入 `.agentguard-runtime`。依赖目录、构建产物、缓存、`logs` 和目录联接不会复制。写回前会比较源文件哈希；检测到运行期间的并发修改时拒绝覆盖。
