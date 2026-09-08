/** Tipado mínimo de node-media-server v4 (el paquete no incluye tipos TS) */
declare module "node-media-server" {
  export interface NMSSession {
    id: string
    ip: string
    isPublisher: boolean
    protocol: string
    streamHost: string
    streamApp: string
    streamName: string
    streamPath: string
    streamQuery: Record<string, string>
    createTime: number
    endTime: number
    videoCodec: number
    videoWidth: number
    videoHeight: number
    videoFramerate: number
    videoDatarate: number
    audioCodec: number
    audioChannels: number
    audioSamplerate: number
    audioDatarate: number
    inBytes: number
    outBytes: number
    playCount: number
    close(): void
  }

  export interface NMSConfig {
    bind?: string
    notify?: { url: string }
    store?: { path?: string }
    auth?: {
      play?: boolean
      publish?: boolean
      secret?: string
      jwt?: unknown
    }
    rtmp?: { port?: number }
    rtmps?: { port?: number; key?: string; cert?: string }
    http?: { port?: number }
    https?: { port?: number; key?: string; cert?: string }
    record?: { auto?: boolean; path?: string }
    static?: { router?: string; root?: string }
  }

  export default class NodeMediaServer {
    constructor(config: NMSConfig)
    on(event: string, listener: (session: NMSSession) => void): void
    run(): Promise<void>
    stop(): Promise<void>
  }
}
