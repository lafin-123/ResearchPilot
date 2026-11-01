---
name: editable-presentation
description: Produce evidence-linked scientific figures and presentation assets from declarative JSON with native PowerPoint charts/shapes, SVG previews and verifiable editability.
whenToUse: 需要可编辑科研图表、演示素材、原生 PowerPoint 图表或图形源文件时使用。
user-invocable: true
---

# 可编辑科研演示素材

本包使用应用内结构化图表引擎，不安装外部仓库、不联网。当前导出为单图 PPTX 素材，不冒充完整会议演讲稿。PNG 放入幻灯片不等于原生可编辑图表。

## 操作

1. 明确主要信息、受众、数据来源、轴/单位、独立 n 与不确定性。读取真实 run 产物；缺少数据时只做标记为 demo 的示例或停止请求数据。
2. 复制 `templates/chart-spec.json`。v1 支持 bar/line/scatter，1–3 系列、2–200 点、共享 labels 或数值 xValues。bar/line 的 labels 是等间距分类；不等时间间隔用 scatter。不可使用双 y 轴。
3. 用真实数值替换演示数据，sourceLabel 写入真实 run ID 和项目相对源文件，只有核实后才设 isDemo=false。每个系列长度与 labels/xValues 完全相同。禁止通过手动改“demo”标签将随机数据变成证据。
4. 当前原生 schema 不支持误差条/置信带。不能为了可编辑而隐藏不确定性；附带可追溯区间表和明确说明，或报告不支持。不要把上下界当独立测量系列误导读者。
5. 用原生 `mcp__rp_artifacts__figure_create_spec({spec,experimentId,name,caption})` 提交你依据实际 run 结果构建的内联声明式对象，无需先写 spec 文件或运行 shell。caption 包括结论、单位、n、区间方法与来源。返回 sourcePath、filePath、pptxPath；用 artifact_read 读取 JSON，用 figure_inspect 核查原生对象。每次创建需明确桌面确认。
6. 检查 SVG 的轴、基线、标签、图例和精确数据；保留数据表。颜色跟随实体，不能用于唯一识别。应用负责固定且经过验证的调色板，不在 spec 中注入 SVG/HTML/脚本。
7. 用原生 `figure_inspect({id})` 检查 chart 或原生 shape/connector；包含图片不是通过条件。自动流水线不调用 Python/Shell 检查脚本。
8. 实际打开导出文件修改一个数据点/节点文字并检查保存后的可编辑性。若不能进行此人工 QA，准确报告“结构检查通过，PowerPoint 手工验证未执行”。不得声称工具链已做过未做的验证。

## 交付与限制

必须有 JSON 源、SVG、PPTX、数据来源及编辑性报告。完整科学演示还需要按听众编排叙事、每页一个论点、讲者备注与逐页视觉 QA；本功能仅提供可编辑素材。模板和 `evals/cases.json` 为本地评测用，不是实际研究数据。
