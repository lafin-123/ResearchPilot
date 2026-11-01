# ResearchPilot 0.8.1 交付与验证

## 实现

- 成果优先的文献/实验/图表管理页面，保留中性色与免登录。
- AI先生成摘要级阅读草稿，人工笔记独立、来源变更提示、保存审批。
- Zotero式核心PDF阅读操作：选文高亮、批注、页码跳转、缩放、编辑/删除、选中标注转新研究笔记；不修改原PDF。
- 22个原生MCP工具，支持从真实检索到模型创建实验、真实运行/分析、图表PPT及DOCX成稿。
- 修复结构化模型错误被吞、阶段恢复交接、Windows长路径、空运行日志误判、实际稿件插图等问题。

## 验证

- 类型检查通过；176项单元/集成测试通过。
- 20项实际桌面回归通过：`test-results/desktop-5VbL4h/`。
- 6项PDF阅读器实际回归通过：`test-results/pdf-reader-qclI5l/`，原PDF哈希不变。
- 完整8阶段科研项目在多次限流恢复和应用修复后完成：`test-results/full-research-dZMiVw/`。不是一次无故障无人值守成功。
- 模型自行生成实验代码：7200条正式观测、实际计算约4.23秒、独立分析约3.69秒；另有烟雾、审稿和修订后的审计运行，失败保留。
- 测试方独立重算全部观测误差，独立核验文件哈希与审稿修订链。
- 最终DOCX计数4609，真实Word打开并导出9页PDF、2张嵌入图；Office XML验证通过。
- 两张原生可编辑PPT由Agent根据真实分析结果创建，PowerPoint打开渲染验证。

## 交付位置

- 安装包：`release/v0.8.1/ResearchPilot-0.8.1-setup.exe`。
- 最终论文：`deliverables/v0.8.0/manuscript/research-final.docx`、`research-final.pdf`。
- 可编辑PPT：`deliverables/v0.8.0/full-study-figures/`。
- AI阅读摘记：`deliverables/v0.8.0/ai-reading-draft.md`。
- 完整科研验证：`docs/full-research-validation.md`。

## 边界

- 科研是受控数学仿真和方法比较，不是现实数据验证、新算法突破或投稿质量保证；文献没有全文支持时明确保留待人工审查。
- PDF支持文本层选择和页面批注，没有OCR、写回PDF、Zotero同步、外部批注导入；批注单独保存。
- AI摘记仅标题和摘要，不冒充全文精读；原文批注不会自动成为全文RAG。
- PPT是与科研图对应的可编辑单页素材，不是整套答辩演示。
- 安装包不包含用户密钥、测试账户或原始工作区；未签名、未自动安装，旧版保留。
