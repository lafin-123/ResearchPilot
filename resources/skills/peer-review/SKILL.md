---
name: peer-review
description: Review research manuscripts against their actual evidence with severity-ranked, located findings and a balanced revision plan.
whenToUse: 审稿、投稿前检查、回应审稿人或评估研究可信度时使用。
user-invocable: true
---

# 证据驱动审稿

评价稿件实际说了什么，不假设缺失证据存在；严谨不等于挑剔语气。

1. 读取实际稿件版本与设计，按所选问询方式处理审查范围；缺少目标期刊时先作通用证据审阅并标记未核对期刊规则，不为偏好项暂停。对盲审保密内容不联网、不向第三方发送。
2. 独立阅读摘要、方法、结果和局限，提炼作者核心贡献。把“表达问题”与“会改变结论的问题”分开。
3. 用 citation-audit 和 reproducibility 检查来源及运行产物；用 statistical-analysis 检查单位、n、基线公平性、主终点、区间及多重比较。未执行的实验不得标记复现通过。
4. 每个发现写入 `templates/review-findings.json`：严重性、精确章节/行/表、原句、证据、对结论影响、可执行修复、置信度。没有依据的猜测写成提问，不当作事实。
5. 寻找信息泄漏、样本选择、过强因果语言、未报告失败、不匹配数字/图表、演示数据冒充结果。科学有效性不能由流水线绿色状态代替。
6. 给出优点、主要问题、次要问题、可行修订顺序。保留实质负面结果，不以捏造数据解决问题。
7. 用户确认后才修稿；回应审稿人时逐条标记已改/部分改/不同意，并给出对应证据和准确定位。建议不是录用承诺。

验收：每条批评可定位、证据与判断分离、严重性适当；输出未覆盖范围和剩余风险。评测见 `evals/cases.json`。
