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
export interface ProviderRequest { model: string; prompt: string; cwd: string; reasoning: string; sandbox: 'read-only' | 'danger-full-access'; network?: boolean; timeoutMs?: number; outputFile?: string }
export interface ProviderResult { output?: string; stdout?: string; stderr?: string; processId: number; usage: null | { inputTokens?: number; outputTokens?: number; cost?: number } }
export interface CapabilityGrant { id: string; worker: WorkerRole; scope: string; resource: string; duration: 'action' | 'project' | 'remembered'; projectId?: string | null; status: 'pending' | 'approved' | 'denied'; decidedBy?: 'local-user' }
export interface MemoryRecord { id: string; role: WorkerRole | 'shared'; kind: 'fact' | 'lesson' | 'preference' | 'metric' | 'correction'; content: string; provenance: string; confidence: number; status: 'proposed' | 'approved' | 'rejected' | 'forgotten'; correctionOf?: string | null; projectId?: string | null }
export interface MeetingProposal { id: string; workdayId: string; contributingRoles: WorkerRole[]; unanimous: boolean; memoryId?: string | null; status: 'proposed' | 'approved' | 'rejected' }
export interface ParticipantIdentity { id: string; label: string; publicKey: string; deviceColor: string }
export interface RoomEnvelope { version: string; roomId: string; senderId: string; nonce: string; issuedAt: string; expiresAt: string; type: string; encrypted: { nonce: string; ciphertext: string; tag: string }; signature: string }
export interface SharedArtifact { id: string; ownerParticipantId: string; taskId: string; name: string; mimeType: string; bytes: number; sha256: string; quarantined: boolean; approvedAt?: string | null }
export interface ReleaseSnapshot { schemaVersion: number; appVersion: string; createdAt: string; signature: string; checksums: Record<string, string>; migrationVersion: number; rollbackId: string }
