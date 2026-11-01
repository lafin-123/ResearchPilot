export type ResearchClarification = 'minimal' | 'balanced' | 'guided'
export const CLARIFICATION_OPTIONS = [
  { value: 'minimal', label: '少打断', description: '偏好项用保守默认，列出假设，先交付可审阅草稿。' },
  { value: 'balanced', label: '关键处询问', description: '只问会改变研究设计、结论或交付范围的问题。' },
  { value: 'guided', label: '先问清楚', description: '开始前集中确认关键输入，不重复询问已知事项。' }
] as const
export function normalizeClarification(value: unknown): ResearchClarification {
  return CLARIFICATION_OPTIONS.some(option => option.value === value) ? value as ResearchClarification : 'balanced'
}
export function clarificationInstruction(value: unknown): string {
  const mode = normalizeClarification(value)
  const instruction = mode === 'minimal'
    ? '少打断：语言、长度、格式等可选偏好采用保守默认并列明假设，不要求用户填完整问卷；先完成不依赖缺失信息的部分。'
    : mode === 'guided'
      ? '先问清楚：开始实质工作前集中提出会影响任务的输入问题，给出可跳过的偏好默认值；不重复询问已有上下文。'
      : '关键处询问：仅对会改变研究设计、结论或交付范围的缺口提问；语言、格式、篇幅等可选偏好不阻塞。'
  return `${instruction}\n共同边界：采样单位、配对关系、数据权限、伦理批准、矛盾数值或证据不足不得猜测。不编造结果、引用、页码、全文内容或期刊要求；缺失全文只能列未核对项。无法继续计算时先交方案/缺口清单。代码执行、联网、外发数据、覆盖/删除文件及昂贵操作仍需既有审批，问询方式不能绕过审批。用户明确选择的本次问询方式可替代默认偏好，但不能改变这些共同边界。`
}
