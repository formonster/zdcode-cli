import fs from 'fs'
import os from 'os'
import path from 'path'
import { ChannelConnectionRecord } from '../types'

type ChannelConnectionsStore = {
  version: 1
  connections: Record<string, ChannelConnectionRecord>
}

const STORE_VERSION = 1 as const
export const ZDCODE_CHANNELS_HOME = path.join(os.homedir(), '.zdcode', 'channels')
export const ZDCODE_CHANNELS_CONNECTIONS_PATH = path.join(ZDCODE_CHANNELS_HOME, 'connections.json')

const ensureDir = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true })
}

const defaultStore = (): ChannelConnectionsStore => ({
  version: STORE_VERSION,
  connections: {},
})

const withConnectionId = (id: string, connection: ChannelConnectionRecord | Omit<ChannelConnectionRecord, 'id'>) => ({
  ...connection,
  id,
}) as ChannelConnectionRecord

export const initChannelsStore = () => {
  ensureDir(ZDCODE_CHANNELS_HOME)
  if (!fs.existsSync(ZDCODE_CHANNELS_CONNECTIONS_PATH)) {
    fs.writeFileSync(ZDCODE_CHANNELS_CONNECTIONS_PATH, `${JSON.stringify(defaultStore(), null, 2)}\n`, 'utf-8')
  }

  return {
    home: ZDCODE_CHANNELS_HOME,
    configPath: ZDCODE_CHANNELS_CONNECTIONS_PATH,
  }
}

export const readChannelsStore = (): ChannelConnectionsStore => {
  initChannelsStore()
  try {
    const parsed = JSON.parse(fs.readFileSync(ZDCODE_CHANNELS_CONNECTIONS_PATH, 'utf-8')) as Partial<ChannelConnectionsStore>
    if (parsed.version !== STORE_VERSION || !parsed.connections || typeof parsed.connections !== 'object') {
      throw new Error('invalid shape')
    }
    return {
      version: STORE_VERSION,
      connections: parsed.connections as Record<string, ChannelConnectionRecord>,
    }
  } catch {
    throw new Error(`Invalid channels store: ${ZDCODE_CHANNELS_CONNECTIONS_PATH}`)
  }
}

export const writeChannelsStore = (store: ChannelConnectionsStore) => {
  initChannelsStore()
  fs.writeFileSync(ZDCODE_CHANNELS_CONNECTIONS_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf-8')
}

export const listChannelConnections = () =>
  Object.entries(readChannelsStore().connections)
    .map(([id, connection]) => withConnectionId(id, connection))
    .sort((a, b) => a.name.localeCompare(b.name))

export const resolveChannelConnection = (id: string) => {
  const store = readChannelsStore()
  const connection = store.connections[id]
  if (!connection) {
    throw new Error(`Channel connection "${id}" not found in ${ZDCODE_CHANNELS_CONNECTIONS_PATH}`)
  }
  return withConnectionId(id, connection)
}

export const createChannelConnection = (connection: Omit<ChannelConnectionRecord, 'createdAt' | 'updatedAt'>) => {
  const store = readChannelsStore()
  if (store.connections[connection.id]) {
    throw new Error(`Channel connection "${connection.id}" already exists`)
  }
  const now = new Date().toISOString()
  const record: ChannelConnectionRecord = {
    ...connection,
    createdAt: now,
    updatedAt: now,
  }
  store.connections[record.id] = record
  writeChannelsStore(store)
  return record
}
