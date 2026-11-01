import { safeStorage } from 'electron'

const PREFIX = 'enc:v1:'

export function isSecretStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function encryptSecret(value: string): string {
  if (!value) return ''
  if (!isSecretStorageAvailable()) {
    throw new Error('系统安全存储不可用，无法保存密钥。请在系统设置中检查凭据保护后重试。')
  }
  return `${PREFIX}${safeStorage.encryptString(value).toString('base64')}`
}

export function decryptSecret(value: string): string {
  if (!value) return ''
  if (!value.startsWith(PREFIX)) return value
  if (!isSecretStorageAvailable()) {
    throw new Error('系统安全存储不可用，无法读取已保存的密钥。')
  }
  return safeStorage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'))
}

export function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '••••••••'
  return `${value.slice(0, 3)}••••••${value.slice(-4)}`
}
