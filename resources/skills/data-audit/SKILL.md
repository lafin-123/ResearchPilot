---
name: data-audit
description: Audit local research data before analysis for missingness, duplicate units, numeric validity and train/test leakage without modifying inputs.
whenToUse: 在分析新数据、检查数据质量或排查数据泄漏之前使用。
user-invocable: true
---

# 数据审计

先确认数据是否适合回答问题，再开始统计。这个包离线运行，只依赖 Python 标准库，不安装软件、不调用外部服务。

## 原生流水线执行（优先于下方 CLI 示例）

不调用 shell 或 Python 命令。使用 artifact_read 读取真实 run 数据，experiment_create 注册你编写的只读审计/分析代码，再用 experiment_run 明确确认执行。报告必须来自实际运行输出并含输入路径/哈希；artifact_read 读回，再以 project_artifact_write 原样保存 exports/data-audit.json。区分唯一观察 ID 与合法配对 seed/subject ID；重复配对 ID 不应被误当独立观察，也不能静默丢弃。status=passed 仅代表实际实现且执行的机械检查通过，不代表无偏或人工科学审查。

## 输入与边界

先从已提供的数据契约读取路径、编码、行含义、采样单位、主键、划分、结局和单位；可检测的文件格式先检查。只对无法推断且影响有效性的字段合并询问；无采样单位时可交结构审计，但不能继续统计推断。先检查是否包含个人信息；不要把数据发往外部服务。不得自行删除缺失行、合并重复人、修复标签或改写原文件。

## 操作

1. 阅读 `templates/data-contract.json`，按真实数据填写契约。保存输入的 SHA-256、授权范围和获取日期。
2. 向用户说明将运行的本地只读检查。脚本路径相对本技能目录；从项目根执行，使用已安装的 Python，不自动下载解释器。
3. 运行 `python -I <skill-dir>/scripts/audit_data.py data/input.csv --id-column subject_id --split-column split --numeric outcome age --out exports/data-audit.json`。脚本返回 1 表示阻塞，不是分析成功。
4. 阅读每条 blocker，检查重复是否为合法重复测量、缺失是否有机制、不同 split 是否共享主体。脚本只识别完全相同的 ID，不能证明完全没有泄漏。
5. 经用户确认后生成独立的清洗脚本和新文件，记录每条排除规则和数量；对新文件重新审计，保留原始报告。
6. 使用 `templates/audit-review.md` 记录人工判断、未覆盖检查和下一步。不得把结构检查通过写成“数据正确”或“数据无偏”。

## 输出与验收

必须交付数据契约、原始审计 JSON、处理决策以及输入文件哈希。`status=passed` 只表示本脚本已实现的检查无阻塞。采样独立性、标签正确性、隐私、分布偏移仍需人工判断。含 blocker 时停止统计并请求明确决策。

## 评测

见 `evals/cases.json`：同主体跨 split、非有限数字、缺失值、重复表头、干净输入。验收要求原文件逐字节未变、异常非零退出、报告不包含凭空修复后的数字。
