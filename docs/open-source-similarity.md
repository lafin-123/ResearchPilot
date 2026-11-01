# 开源相似度工具与知网、维普的边界

调研日期：2026-10-22。

## 结论

本次没有找到知网或维普官方开源核心查重引擎及商业比对库的可信证据。开源文本相似度工具可以用于稿内去重、用户授权材料比对和写作自检，但不能据此宣称“本地知网查重”“维普等效检测”，也不能预测官方重复率或保证通过。

本次核验主要依赖搜索索引中的官方页面、仓库说明和许可元数据。部分网页直读受限，未审计完整源码、下载或执行第三方仓库；正式采用前还需复核具体版本与许可证全文。

## 官方公开说明

- [知网学术不端检测系统 5.3 使用协议](https://check.oversea.cnki.net/vip/Role/VIPuseProtocolV1.0.html) 介绍了期刊、学位论文、会议、报纸、专利、图书等比对资源，并说明机器结果是参考线索，不应独立作为学术判断标准。结果同时受算法、数据库、检测时间和设置影响。
- [维普 VPCS 官方产品介绍](https://ccd1.cqvip.com/productor/pro_vpcs.shtml) 描述“动态语义跨域识别加指纹比对”，并支持自建比对库。这是高层产品说明，不是完整算法、阈值或开源代码；不能据此认定它采用某个具体开源库。
- 相似内容可能是合理引用、术语或必要的方法描述。低相似度也不证明引用充分、事实正确或没有不当借用。

## 可参考的开源技术

| 项目 | 技术与用途 | 边界 |
| --- | --- | --- |
| [1e0ng/simhash](https://github.com/1e0ng/simhash) | SimHash 指纹，近重复候选检索；仓库标识 MIT | 适合初筛，不能给出官方复制比 |
| [datasketch](https://ekzhu.com/datasketch/minhash.html) | MinHash 近似 Jaccard 与 LSH 候选召回；仓库声明 MIT | 需要自有语料和精确复核，近似召回有误差 |
| [Sentence Transformers](https://github.com/huggingface/sentence-transformers) | 句段向量与语义相似度；代码 Apache-2.0，模型许可需另查 | 同主题不等于抄袭，余弦分数不是重复率 |
| [CodeWolffy/papercheck](https://github.com/CodeWolffy/papercheck) | 自托管私库相似度检查，项目自述支持多种匹配方式；标识 MIT | 不附带知网、维普数据库；本次未运行验证其能力 |

一些带“知网源码”标题的项目仅提供订单、文件上传、付费接口或代理合作说明。例如 [Oraclediy/cnki](https://github.com/Oraclediy/cnki) 的可见信息不足以证明它包含官方核心引擎或明确开源许可，不作为推荐。文献采集项目也不等于查重引擎，采集能力不代表数据库授权。

## 本项目采用的诚实方案

1. 只比较当前稿件和用户明确提供、有权使用的来源文本，不抓取商业全文库。
2. 分词／字符切分后进行局部连续窗口匹配，显示原文位置、来源位置和检查范围；不输出知网／维普预测分数。
3. 套语、长句、重复论证和无依据强调用确定性规则提示，不推测作者是否为 AI。
4. 用户可以粘贴已合法取得的知网／维普报告标记段落，报告平台仅作为来源标签。
5. AI 修订要求保留数值、引用和必要术语，补充来源归属，重新组织论证；不是换同义词或绕过检测。
6. 修改后检查数值、引用标记及术语是否遗失，再由用户在原平台复检。此核对不验证引用真实性或科学结论。

当前尚未实现官方报告 PDF 自动解析、官方数据库查询、语义向量检索或第三方商业检测 API；界面不伪装为这些能力。

## 稿件与凭据安全

未发表稿件上传第三方前，应确认服务主体、保存期限、删除机制以及是否转交下游。[知网隐私政策](https://check.oversea.cnki.net/vip/Role/VIPprivacyPolicyV2.0.html) 对联合比对库有专门安排，不应笼统说“上传必入库”或“绝不保留”。不同产品需分别查看条款。

本地部署也应检查遥测和外部模型调用。API Key 不应放在前端源码、仓库、报告或截图中。开源代码许可不会授予商业数据库或论文全文的使用权。

## Sources

- https://check.oversea.cnki.net/vip/Role/VIPuseProtocolV1.0.html
- https://check.oversea.cnki.net/vip/Role/VIPprivacyPolicyV2.0.html
- https://ccd1.cqvip.com/productor/pro_vpcs.shtml
- https://github.com/1e0ng/simhash
- https://ekzhu.com/datasketch/minhash.html
- https://github.com/ekzhu/datasketch/blob/master/pyproject.toml
- https://github.com/huggingface/sentence-transformers
- https://sbert.net/docs/sentence_transformer/usage/semantic_textual_similarity.html
- https://github.com/CodeWolffy/papercheck
- https://github.com/Oraclediy/cnki
