---
name: research-planning
description: Turn a research idea into a falsifiable, budgeted plan with evidence needs, feasibility checkpoints and explicit go/no-go criteria.
whenToUse: 选题、研究设计、研究路线规划或评估项目可行性时使用。
user-invocable: true
---

# 研究规划

把开放性想法转成可证伪、可停止的研究计划，而不是提前写出成功故事。

1. 先读取已有目标、数据与权限、未知和预算，列“已知 / 假设 / 待核实”。遵循所选问询方式：截止日期、输出格式等偏好可留空或保守默认；采样单位、数据权限和关键研究目标不明确时合并询问，不为缺失科学条件编答案。
2. 读取本地文献证据，使用 literature-review。区分相关性、因果性、方法可行性与真实科学新颖性；新颖性没有完整检索时标记待核查。
3. 填写 `templates/research-plan.json`：主要问题、可证伪假设与零假设、独立采样单位、主要指标、强 baseline、成功/停止标准、数据权限、伦理需求与计算成本。标准在看结果之前冻结。
4. 设计最低成本 smoke test 和阶段预算：先可运行性，再样本充分性，再主实验。要求负责人、输入、交付物、依赖和失败时回退方案。
5. 对高风险假设做预演：若结果为负是否仍有信息价值？若数据不可用有哪些诚实替代？禁止无授权采集个人数据或自动批准伦理流程。
6. 交付计划和待决问题。低风险的后续设计草案可继续，无需为了进入另一个技能重复确认；影响设计有效性的未决项应保留阻塞。真正执行、联网或提交仍需既有审批。

验收：每个目标可衡量、每个主张有证据需求、预算有上限、无结果承诺。见 `evals/cases.json`。
