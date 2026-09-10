import { readZdcodeEnv, ZDCODE_ENV_PATH } from '../../utils/zdcode-env'
import {
  DEFAULT_API_URL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
} from './constants'
import type { AgensImageOptions, AgensVideoOptions } from './types'

export const normalizeApiUrl = (value: string) => value.trim().replace(/\/+$/, '')

export const imagesEndpoint = (apiUrl: string) => {
  const url = normalizeApiUrl(apiUrl)
  if (url.endsWith('/images/generations')) return url
  if (url.endsWith('/v1')) return `${url}/images/generations`
  return `${url}/v1/images/generations`
}

export const videosEndpoint = (apiUrl: string) => {
  const url = normalizeApiUrl(apiUrl)
  if (url.endsWith('/videos')) return url
  if (url.endsWith('/v1')) return `${url}/videos`
  return `${url}/v1/videos`
}

export const agnesApiOrigin = (apiUrl: string) => {
  try {
    return new URL(normalizeApiUrl(apiUrl)).origin
  } catch {
    return normalizeApiUrl(apiUrl)
  }
}

export const agensImageConfig = (options: AgensImageOptions) => {
  const env = readZdcodeEnv()
  return {
    apiKey: env.AGNES_IMAGE_API_KEY,
    apiUrl: options.apiUrl || env.AGNES_API_URL || DEFAULT_API_URL,
    model: options.model || env.AGNES_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
  }
}

export const agensVideoConfig = (options: AgensVideoOptions) => {
  const env = readZdcodeEnv()
  return {
    apiKey: env.AGNES_VIDEO_API_KEY,
    apiUrl: options.apiUrl || env.AGNES_API_URL || DEFAULT_API_URL,
    model: options.model || env.AGNES_VIDEO_MODEL || DEFAULT_VIDEO_MODEL,
  }
}

export const missingApiKeyError = (keyName: string) =>
  `Missing ${keyName} in ${ZDCODE_ENV_PATH}`
