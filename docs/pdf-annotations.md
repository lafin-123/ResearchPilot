# PDF 原文标注设计与边界

目标参照 Zotero 的论文阅读工作流：原文选文高亮、批注列表、点击回到原页、将摘录整理成带出处笔记。

本项目采用本地 PDF.js 渲染与独立数据库标注层，默认不修改原始 PDF。标注绑定文献 ID、项目 ID 和 PDF 字节 SHA-256，以免更换附件后把旧高亮画到错误位置。保存页码、规范化矩形、引用文本、颜色和批注。

本轮范围：文本选择高亮、页级批注、翻页/缩放、标注列表跳转、编辑/删除、复制或导出阅读笔记。扫描图片PDF若无文本层，不提供伪文本选择，也不声称完成OCR。

不包含 Zotero 云同步、外部批注格式导入、写回原PDF、全部PDF加密支持、自由手绘或自动OCR。若导出只为JSON/Markdown标注说明，不把它称为带内嵌批注的PDF。

## 验证

- 数据库/几何/安全测试6项通过，包含原件字节不变、文件指纹变化拒绝、跨项目隔离、边界坐标与批注修订冲突。
- 实际 Electron PDF 阅读器6项通过：真实文本层选择、高亮批注、翻页定位、不同缩放、保存重开、标注转独立笔记、编辑与确认删除。
- 记录：`test-results/pdf-reader-VKIt3a/report.json`；截图同目录。
- 测试用PDF为本地生成的两页文本样例，不含用户论文或网络内容。

官方参考：[Zotero PDF Reader and Note Editor](https://www.zotero.org/support/pdf_reader)、[Annotations in Database](https://www.zotero.org/support/kb/annotations_in_database)。
