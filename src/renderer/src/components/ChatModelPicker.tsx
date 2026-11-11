import type { ReactNode } from 'react'
import { useAppStore } from '../store/app'

export function ChatModelPicker(): ReactNode {
  const providers = useAppStore(state => state.providers)
  const selection = useAppStore(state => state.modelSelection)
  const setModel = useAppStore(state => state.setChatModel)
  const modelChanging = useAppStore(state => state.modelChanging)
  const pendingSend = useAppStore(state => state.pendingSend)
  const projectLoading = useAppStore(state => state.projectLoading)
  const agentState = useAppStore(state => state.agentState)
  const running = agentState?.status === 'running' || agentState?.status === 'starting'
  const value = JSON.stringify([selection.providerId, selection.modelId])
  const exists = providers.some(provider => provider.id === selection.providerId && provider.models.some(model => model.id === selection.modelId))
  return <label className="chat-model-picker"><span>{modelChanging ? '保存中…' : '本轮模型'}</span><select
    aria-label="本轮模型" value={value} disabled={running || !!pendingSend || modelChanging || projectLoading}
    title="切换只影响后续回复，保留当前会话与历史消息"
    onChange={event => {
      const [providerId, modelId] = JSON.parse(event.target.value) as [string, string]
      void setModel(providerId, modelId)
    }}>
    {!exists ? <option value={value}>请选择模型</option> : null}
    {providers.map(provider => <optgroup key={provider.id} label={provider.name}>
      {provider.models.map(model => <option key={model.id} value={JSON.stringify([provider.id, model.id])} disabled={!provider.hasApiKey}>{provider.name} / {model.label || model.id}{!provider.hasApiKey ? '（未配置 Key）' : ''}</option>)}
    </optgroup>)}
  </select></label>
}
