# 恢复功能接线与验证（2026-10-24）

## 背景与完成范围

继续上一轮中断的工作，不另行扩展科研功能。开始时 `npm run typecheck` 实际失败：主进程缺少 `BackupService` / `ProjectHealthService` 导入，`Services` 未声明健康服务，以及可空上下文接线错误。

本轮完成：主进程启动接线、备份服务生命周期清理、恢复副本项目初始化和桥接同步、IPC 文件写入/执行边界、准备检查页目录诊断与明确重试。缺失目录不会自动重建；数据库笔记与文献元数据不被目录状态封锁。恢复已成功但初始化失败时保留副本并返回警告，不把资料恢复误报成回滚失败。

## TDD 证据

测试直接执行真实 `registerIpc`，仅 Electron 宿主 API 与服务边界使用内存桩；另有真实 SQLite/文件系统和 Electron 桌面验证。

| 保证 | RED 证据 | GREEN 测试 |
| --- | --- | --- |
| 不可用项目不能写文稿、实验代码、图表或启动执行 | 新增 IPC 测试最初 `Missing expected rejection` | `tests/ipc-project-health.test.ts` |
| 文件选择后及延迟文稿创建前再次检查 | 同一 IPC 测试初始未拒绝 | 同上 |
| 健康列表只读，明确重试才初始化并同步桥接 | 初始 `missing IPC handler: project:health` | 同上 |
| 恢复副本在返回前初始化桥接 | 初始写入序列为空，预期 `retry,sync` | 同上 |
| 已恢复但初始化失败，明确返回警告 | 初始缺少 ENOENT 警告 | 同上 |
| 目录异常不能被准备清单报为可启动 | 新增 readiness 测试初始 `true !== false` | `tests/readiness.test.ts` |
| 继续流水线也检查目录，而非只检查新建 | 初始返回 Python 配置错误而非 ENOENT | `tests/ipc-project-health.test.ts` |
| 技能列表不隐式重建项目，项目级技能修改受保护 | 实际目录测试初始 `true !== false` | 同上 |
| 聊天异步配置之后、附件保存之前复查 | 初始越过检查进入后续消息写入 | 同上 |
| 实验结束落盘不重建已移走根目录 | 实际目录测试初始 `true !== false` | 同上 |
| 恢复成功与列表刷新失败分开反馈 | 桌面故障注入后缺少明确成功提示，等待超时 | `scripts/smoke-recovery.mjs` |

审查补充修复还包括：远程实验获取 HOME 后、下载连接和目录读取后检查项目目录；SSH 连接/目录读取边界使用无网络桩做 RED/GREEN 验证，未接入真实远程主机。刷新警告与一般操作错误独立保存，避免无关错误误显示列表刷新按钮。

命令：`node --import tsx --test tests/ipc-project-health.test.ts tests/readiness.test.ts`。

## 实际验证

- `npm run typecheck`：通过（修复后）。
- `npm run build`：通过；仍有原有动态/静态导入共存提示及 npm 镜像配置提示，不影响构建。
- `npm test` / 同一 Node 测试入口最终复跑：219/219 通过，0 失败、0 跳过；包含恢复初始化警告和审查补充回归。
- `node scripts/smoke-desktop.mjs`：最终 20 项通过，`test-results/desktop-F0BzfW/`。
- `node scripts/smoke-recovery.mjs`：最终 8 项通过，`test-results/recovery-Ayn7yU/report.json`（早期正常路径 7 项报告保留于 `recovery-1rlAEh/`）。

新增桌面场景：准备检查；UI 导出/预览/确认恢复；新 ID 与源项目不变；归档代码不执行；移走项目目录后重启仍能使用其他项目和数据库笔记；写入/执行拒绝；原目录恢复后明确重试；再重启保留恢复资料；960px 窗口控件可见且无 renderer 异常。

第一次 recovery 脚本在读取笔记时误用仅返回摘要的列表 API，断言失败；改用 `notes.get` 获取正文后，从全新隔离目录重跑通过。没有删除失败报告，也没有更改应用行为来适配断言。

## 覆盖率

命令：

```bash
node --import tsx --experimental-test-coverage --test-coverage-include=src/main/services/project-health.ts --test-coverage-include=src/main/services/backups.ts --test-coverage-include=src/renderer/src/lib/readiness.ts --test tests/project-health.test.ts tests/backups.test.ts tests/readiness.test.ts
```

33 项通过。限定模块覆盖率（不是整个应用覆盖率）：

| 模块 | 行 | 分支 | 函数 |
| --- | ---: | ---: | ---: |
| backups.ts | 94.55% | 80.50% | 100% |
| project-health.ts | 97.60% | 89.55% | 100% |
| readiness.ts | 100% | 94.51% | 100% |
| 合计 | 95.99% | 84.77% | 100% |

## 限制与未执行项

- 所有桌面验证使用全新 `test-results` 隔离数据库，不触碰真实用户项目；无付费模型请求、无自动依赖安装。
- 文件选择对话框由测试宿主提供路径，实际备份/校验/恢复/界面调用仍走生产代码。未覆盖人工操作系统文件选择器本身。
- SHA-256 是完整性检查，不是签名、来源认证或加密；只恢复可信备份。
- 同步路径检查不是操作系统沙箱，不能保证抵御外部进程在检查后并发替换链接。
- 无 Git 仓库，未创建提交、分支或 PR；项目未配置 ESLint，本次未下载并临时安装 lint 工具。
- 未重建、覆盖或安装 `release/v0.8.1` 旧安装包；当前新增功能属于源码构建。

## 交付自检

| 维度 | 评分 | 证据与改进空间 |
| --- | ---: | --- |
| 准确性 | 4/5 | 219 项测试与实际桌面证据；真实 SSH 主机未测试，不宣称全链路远程验证。 |
| 完整性 | 4/5 | 本轮三项中断功能已接线、验证和补边界；安装包没有重发，文档明确区分源码与旧包。 |
| 清晰度 | 4/5 | 准备清单、目录错误和恢复后刷新失败分别说明；部分系统错误仍偏技术化。 |
| 可操作性 | 4/5 | 侧栏入口、明确重试、独立恢复与可重复脚本齐备；暂无正式 lint 命令。 |
| 简洁性 | 4/5 | 复用健康服务与既有文件格式；IPC 测试为了隔离 Electron 使用较长宿主桩。 |

总体 4.0/5。后续优先项是配置持久化 lint 检查和在有授权的真实 SSH 主机验证下载中断；两者不计作本轮已经完成。自检以用户能复核的结果为依据，不以评分代替验证。
