---
name: scientific-diagram
description: Design honest scientific method, process and mechanism diagrams as bounded editable nodes and connectors with source provenance.
whenToUse: 绘制科研流程图、方法架构图、实验协议示意图或编辑已有结构图时使用。
user-invocable: true
---

# 科研示意图

目标是解释结构，不是装饰结论。所有节点、连线和文字保留为原生可编辑对象；概念图不能冒充实测结果。

## 操作

1. 问清图要解释的主张、受众、输入/输出、节点含义、箭头语义、是否存在分支/反馈、来源是否经过验证。不得自行添加因果箭头。
2. 读取 `templates/method-diagram.json`，复制到项目 figures/method-spec.json。模板明确为演示，不是研究证据。
3. 只改声明式 JSON。v1：`kind=diagram`，1000×440 内容画布；最多 40 个节点/80 条边，节点类型 rect/roundRect/ellipse/diamond；边引用真实节点 ID。标题与来源留给渲染器，不侵占内容画布。
4. 在 JSON 中填写 `provenance.sourceLabel`，清楚区分“拟议方法”与“测量流程”。只有真实来源才可 `isDemo=false`。流水线经验性图表还必须关联真实 experimentId、run ID 和产物路径。
5. 使用 `research figs create --name "方法示意图" --spec-file figures/method-spec.json --caption "逐项解释符号、输入输出和限制"`。这是数据创建，不执行未知脚本。更新用 `research figs update --id <id> --spec-file ...`；读取用 `research figs get --id <id>`。
6. 查看图表页的 SVG；检查中文换行、边端点、重叠、遮挡、阅读顺序和黑白可读性。超长标签应简写或拆图，不缩到不可读。
7. `research figs export --id <id> --format pptx` 后保留 JSON、SVG 和 PPTX 路径。用 editable-presentation 的核验脚本检查原生形状；若未实际打开 PowerPoint，明确说明编辑体验未做人工验证。

## 验收

来源、图注、可修改 JSON、预览及原生导出齐全。概念图与数据图不得混淆。颜色不承担唯一语义，箭头要有明确方向。见 `evals/cases.json`。
