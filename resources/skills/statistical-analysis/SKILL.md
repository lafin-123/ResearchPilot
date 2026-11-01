---
name: statistical-analysis
description: Plan and perform defensible local two-group comparisons with sampling-unit checks, seeded bootstrap intervals and explicit statistical limitations.
whenToUse: 比较方法或组别、量化效应与不确定性、分析重复实验结果时使用。
user-invocable: true
---

# 统计分析

先写分析计划再看结局；不以显著性为目标选方法。离线标准库脚本支持两个独立组或严格配对的均值差，不是通用统计推断引擎。

## 原生流水线执行（优先于下方 CLI 示例）

不要调用 shell/python 命令或自动安装包。以 artifact_read 读取实际 run 观察数据；通过 experiment_create 注册你编写的完整标准库分析代码，再通过 experiment_run 取得逐次确认执行。代码必须读取真实输入、核对单位/配对/缺失值、计算效应和区间、保存含输入哈希的实际 JSON 到 RESEARCHPILOT_RUN_DIR。用 artifact_read 读回输出，再以 project_artifact_write 原样保存 exports/statistical-analysis.json。status=passed 只用于实际执行且无 blocker 的检查；不能由语言模型手填结果或通过标记。按固定终点/预算分别比较，不混合多 N 或重复种子为独立样本。所有数字须追溯至分析 run。

## 分析前

阅读 data-audit 输出。填写 `templates/analysis-contract.json`，先记录问题、主终点、单位、组别、配对关系、抽样框、排除规则、缺失处理、实际意义阈值、重复比较族。区分随机种子、样本、主体和技术重复，禁止把同一主体的多个测量当独立 n。

## 操作

1. 保留每个实际 run ID 和原始结果文件。整理一个独立衍生 CSV：`unit_id,group,value`，记录生成代码，不覆盖源数据。
2. 已有明确统计设计时不重复问询；采样单位、配对或终点冲突时先集中澄清。以下计算执行仍必须走既有审批，不受问询偏好影响：
   `python -I <skill-dir>/scripts/compare_groups.py data/comparison.csv --control baseline --treatment proposed --unit participant --seed 42 --resamples 5000 --out exports/statistical-analysis.json`
3. 同一采样单位同时测两种条件时加 `--paired`。脚本要求两组 ID 完全匹配；不能静默丢弃缺失配对。独立设计有重叠 ID 会阻塞。
4. 报告两组 n、均值、均值差、95% 百分位 bootstrap 区间、种子、重复次数、方向及实际意义。提供原始点与分布检查。小样本/常数数据警告必须随结果保留。
5. 检查主张是否超出设计：该区间不是 p 值，不证明等效、因果或总体普适性。不要事后切换单侧检验或只报有利指标。
6. 聚类、时间序列、生存分析、复杂抽样、多终点校正或非均值估计量不受该脚本支持。报告需求和阻塞，让用户选择合适的已安装工具/专家，不自动安装大型库或伪造检验结果。

## 交付

分析计划、原始/衍生文件哈希、可重跑命令、统计 JSON、假设支持/反驳/不确定表。对多个终点明确探索性，不把未校正区间叫验证性显著证据。查看 `evals/cases.json`。
