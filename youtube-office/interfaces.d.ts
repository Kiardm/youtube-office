export type WorkerRole = 'researcher' | 'editor' | 'manager'
export type ProviderFailureKind = 'authentication' | 'usage' | 'timeout' | 'model_unavailable' | 'not_installed' | 'process'

export interface ProviderAdapter {
  readonly id: string
  readonly displayName: string
  getStatus(): Promise<{ installed: boolean; authenticated: boolean; version?: string; detail?: string }>
  listModels(): Promise<string[]>
  chat(request: ProviderRequest): Promise<ProviderResult>
  executeWorker(request: ProviderRequest): Promise<ProviderResult>
  cancel(handle: unknown): void
}
export interface ProviderRequest { model: string; prompt: string; cwd: string; reasoning: string; sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'; network?: boolean; timeoutMs?: number; outputFile?: string }
export interface ProviderResult { output?: string; stdout?: string; stderr?: string; processId: number; usage: null | { inputTokens?: number; outputTokens?: number; cost?: number } }
export interface CapabilityGrant { id: string; worker: WorkerRole; scope: string; resource: string; duration: 'action' | 'project' | 'remembered'; projectId?: string | null; status: 'pending' | 'approved' | 'denied'; decidedBy?: 'local-user' }
export interface MemoryRecord { id: string; role: WorkerRole | 'shared'; kind: 'fact' | 'lesson' | 'preference' | 'metric' | 'correction'; content: string; provenance: string; confidence: number; status: 'proposed' | 'approved' | 'rejected' | 'forgotten'; correctionOf?: string | null; projectId?: string | null }
export interface MeetingProposal { id: string; workdayId: string; contributingRoles: WorkerRole[]; unanimous: boolean; memoryId?: string | null; status: 'proposed' | 'approved' | 'rejected' }
export interface ParticipantIdentity { id: string; label: string; publicKey: string; deviceColor: string }
export interface RoomEnvelope { version: string; roomId: string; senderId: string; nonce: string; issuedAt: string; expiresAt: string; type: string; encrypted: { nonce: string; ciphertext: string; tag: string }; signature: string }
export interface SharedArtifact { id: string; ownerParticipantId: string; taskId: string; name: string; mimeType: string; bytes: number; sha256: string; quarantined: boolean; approvedAt?: string | null }
export interface ReleaseSnapshot { schemaVersion: number; appVersion: string; createdAt: string; signature: string; checksums: Record<string, string>; migrationVersion: number; rollbackId: string }
export interface SideTask { id: string; agentId: WorkerRole; mode: 'quick-research' | 'mini-project'; title: string; request: string; status: string; workspace: string; outputFile: string; approvedScopes: string[]; shareWithRoom: boolean; createdAt: string; startedAt?: string; completedAt?: string; citations?: string[] }
export interface UsageLedgerRecord { id: string; category: 'production' | 'employee-chat' | 'quick-research' | 'mini-project' | 'escalation'; agentId: WorkerRole | null; provider: string; model: string; reasoning: string; status: string; startedAt: string; completedAt: string; durationMs: number | null; inputTokens: number | null; outputTokens: number | null; cost: number | null }
export interface DeliveryManifest { schemaVersion: 1; projectId: string; projectTitle: string; candidatePath: string; finalPath: string; artifactType: 'video' | 'file'; fileName: string; bytes: number; sha256: string; revisionFamilyId: string; inspectedAt: string; deliveredAt: string; status: 'delivered' }
export interface YouTubeConnection { clientId: string; connected: boolean; channelId: string | null; channelTitle: string | null; scopes: string[]; autoPublishEnabled: boolean; connectedAt: string | null; lastCheckedAt: string | null; blocker: string | null }
export interface PublishJob { id: string; projectId: string; revisionFamilyId: string; deliveryPath: string; sha256: string; status: 'uploading' | 'processing' | 'private-blocked' | 'publishing' | 'public' | 'failed' | 'interrupted'; visibility: 'private' | 'public'; videoId: string | null; publicUrl: string | null; uploadedBytes: number; totalBytes: number; retryable: boolean; blocker?: string | null }
export interface RevisionFamily { id: string; projectId: string; publicVideoId: string; previousVideoIds: string[]; updatedAt: string }
