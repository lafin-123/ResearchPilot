---
name: citation-audit
description: Audit manuscript citation keys against the local library and inspect claim-source support with explicit locators; never invent or silently verify citations.
whenToUse: 文稿提交前、发现引用缺失/不匹配、检查 AI 生成的文献或主张时使用。
user-invocable: true
---

# 引用与主张审计

键存在、文献真实、来源支持当前句子是三个不同问题。离线脚本只核验本地映射；不得把“本地匹配”说成 DOI/撤稿/全文核验。

## 原生流水线执行（优先于下方 CLI 示例）

用 reference_search/reference_read 和 manuscript_read 读取实际记录/稿件，不调用 research CLI 或 shell。自动流水线可以用 experiment_create 注册并 experiment_run 执行你编写的机械核验代码：对真实稿件引用键、DOI、来源记录和数字进行比对，报告实际发现及输入哈希。读回该 run 的报告，以 project_artifact_write 原样保存。机械报告明确 scope=mechanical、humanReviewRequired=true、未核查的全文/句子支持列表。仅机械检查均通过才能 status=passed；绝不伪造 supportReviewed=true 或把 DOI 元数据等同于读过全文。下方离线脚本含人工审阅标记的更强标准，不能通过伪填标记绕过；自动报告需区分而非冒充该人工流程。仅可引用实际可见摘要，超出支持的陈述须删除/限定。

## 操作

1. 用 `research refs list` 读取本地库，保存结构化 JSON 数组到 exports/references-local.json。只用真实本地记录；未知 DOI 不猜测。
2. 用 `research docs read --id <id>` 或已有文本导出读取稿件。支持 `[@key]` 和 LaTeX `\cite{key}`；数字/作者-年份格式需人工检查，不得静默宣称全覆盖。
3. 复制 `templates/claim-sources.json`。逐条记录稿件中精确原句、sourceId、准确引文片段、页码/章节/表格定位。实际读过来源并核对上下文后才填 `supportReviewed:true`。摘要不足以支持方法或因果结论。
4. 明确请求本地只读审计后运行：`python -I <skill-dir>/scripts/audit_citations.py manuscripts/draft.md --references exports/references-local.json --claims exports/claim-sources.json --out exports/citation-audit.json`。
5. 检查未解析的 key、歧义 key、未读来源、断章取义、错配人群/年份、二手转引和过强主张。对库外引用给出补充元数据/全文的请求；不自动联网。若用户允许外部查证，记录实际查证源和日期，不能编造检索日志。
6. 按严重性报告每个发现（原句、来源定位、为什么不支持、修订建议）。修改应降低断言或补充真实来源，不是伪造支持。

## 验收

交付结构报告、逐条 claim-source 映射和未核验清单。`status=passed` 仅指键与显式人工审阅标记无阻塞，不能证明所有事实已被覆盖。数据/实验数字仍需 run ID，不可以参考文献替代实测结果。见 `evals/cases.json`。
