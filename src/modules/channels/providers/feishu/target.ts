import { FeishuReceiveIdType, ResolvedFeishuTarget } from './types'

const OPEN_ID_PREFIX = 'ou_'
const CHAT_ID_PREFIX = 'oc_'
const USER_ID_REGEX = /^[a-zA-Z0-9_-]+$/

const stripPrefix = (value: string, prefix: string) => value.slice(prefix.length).trim()
const stripProviderPrefix = (value: string) => value.replace(/^(feishu|lark):/i, '').trim()

const normalizeTargetValue = (rawTarget: string) => {
  const trimmed = rawTarget.trim()
  if (!trimmed) {
    throw new Error('Feishu target is required')
  }

  const withoutProvider = stripProviderPrefix(trimmed)
  const lowered = withoutProvider.toLowerCase()

  if (lowered.startsWith('chat:')) return stripPrefix(withoutProvider, 'chat:')
  if (lowered.startsWith('group:')) return stripPrefix(withoutProvider, 'group:')
  if (lowered.startsWith('channel:')) return stripPrefix(withoutProvider, 'channel:')
  if (lowered.startsWith('user:')) return stripPrefix(withoutProvider, 'user:')
  if (lowered.startsWith('dm:')) return stripPrefix(withoutProvider, 'dm:')
  if (lowered.startsWith('open_id:')) return stripPrefix(withoutProvider, 'open_id:')

  return withoutProvider
}

export const resolveFeishuReceiveIdType = (rawTarget: string): FeishuReceiveIdType => {
  const withoutProvider = stripProviderPrefix(rawTarget.trim())
  const lowered = withoutProvider.toLowerCase()

  if (lowered.startsWith('chat:') || lowered.startsWith('group:') || lowered.startsWith('channel:')) {
    return 'chat_id'
  }
  if (lowered.startsWith('open_id:')) {
    return 'open_id'
  }
  if (lowered.startsWith('user:') || lowered.startsWith('dm:')) {
    const normalized = withoutProvider.replace(/^(user|dm):/i, '').trim()
    return normalized.startsWith(OPEN_ID_PREFIX) ? 'open_id' : 'user_id'
  }
  if (withoutProvider.startsWith(CHAT_ID_PREFIX)) {
    return 'chat_id'
  }
  if (withoutProvider.startsWith(OPEN_ID_PREFIX)) {
    return 'open_id'
  }
  if (USER_ID_REGEX.test(withoutProvider)) {
    return 'user_id'
  }
  throw new Error(`Invalid Feishu target: ${rawTarget}`)
}

export const resolveFeishuTarget = (rawTarget: string, forcedReceiveIdType?: FeishuReceiveIdType): ResolvedFeishuTarget => {
  const normalizedTarget = normalizeTargetValue(rawTarget)
  if (!normalizedTarget) {
    throw new Error(`Invalid Feishu target: ${rawTarget}`)
  }
  return {
    rawTarget,
    normalizedTarget,
    receiveIdType: forcedReceiveIdType || resolveFeishuReceiveIdType(rawTarget),
  }
}
