// Versioned capability, state, action and result contracts.
// Runtime validators live in validate.ts. Types here are erasable-only (Node type stripping).

export const CONTRACT_VERSION = 1;

export type RiskClass = 'read' | 'low' | 'medium' | 'high' | 'prohibited';

export type ActionStatus =
  | 'pending'
  | 'executing'
  | 'verified'
  | 'failed'
  | 'unknown'
  | 'cancelled';

export type SourceMethod = 'api' | 'dom-semantic' | 'uia' | 'gui-keyboard' | 'visual' | 'fixture';

export interface ArgField {
  type: 'string' | 'boolean' | 'number' | 'enum';
  maxLength?: number;
  min?: number;
  max?: number;
  values?: string[];
  required?: boolean;
  /** Material args invalidate an approval token when changed. */
  material?: boolean;
  /** Default shown in create forms. */
  default?: string;
}

export interface Capability {
  id: string;
  schemaVersion: number;
  adapterId: string;
  adapterVersion: string;
  appId: string;
  operation: string;
  label: string;
  argumentSchema: Record<string, ArgField>;
  requiredScopes: string[];
  riskClass: RiskClass;
  reversible: boolean;
  /** Human-readable preconditions; enforced in adapter code. */
  preconditions: string[];
  verificationMethod: string;
  supportedVersions: string[];
}

export interface TargetIdentity {
  appId: string;
  origin: string;
  documentInstanceId: string;
  objectId: string | null;
  /** Display-only names. Never used for identity matching. */
  display: { app: string; document: string; object?: string };
}

export interface ObservedObject {
  objectId: string;
  revision: number;
  fields: Record<string, string | number | boolean>;
  /** Optional deep link into the original app (same origin as the state). */
  link?: string;
}

/** An app the extension knows how to adapt, and the origins it may be granted on. */
export interface AppDescriptor {
  appId: string;
  name: string;
  origins: string[];
  kind: 'controlled-fixture' | 'third-party';
  needsToken: boolean;
}

/** Field roles per collection, so generic components (e.g. attention) can rank and filter without app-specific code. */
export interface CollectionRoles {
  status?: string;
  doneValues?: string[];
  rank?: string;
  /** Rank values from least to most important. */
  rankOrder?: string[];
}

export interface ObservedState {
  appId: string;
  /** Human-readable app name for display only. */
  appName: string;
  origin: string;
  documentInstanceId: string;
  documentTitle: string;
  workspaceRevision: number;
  observedAt: number;
  sourceMethod: SourceMethod;
  collections: Record<string, ObservedObject[]>;
  /** Field names per collection as declared by the adapter (authoritative; works for empty collections). */
  collectionSchema?: Record<string, string[]>;
  /** What fields mean, declared by the adapter: which field is status, which values are done, what ranks importance. */
  collectionRoles?: Record<string, CollectionRoles>;
  availableCapabilityIds: string[];
  limitations: string[];
}

export interface ActionRequest {
  actionId: string;
  capabilityId: string;
  target: TargetIdentity;
  expectedRevision: number | null;
  args: Record<string, string | number | boolean>;
  approvalToken: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface ActionResult {
  actionId: string;
  status: ActionStatus;
  beforeRevision: number | null;
  afterRevision: number | null;
  observedPostcondition: string | null;
  errorCode: string | null;
  message: string;
  recoveryOptions: string[];
}

export type ErrorCode =
  | 'UNKNOWN_CAPABILITY'
  | 'INVALID_ARGS'
  | 'TARGET_MISMATCH'
  | 'STALE_REVISION'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_INVALID'
  | 'APPROVAL_EXPIRED'
  | 'REQUEST_EXPIRED'
  | 'DUPLICATE_ACTION'
  | 'TARGET_LOCKED'
  | 'PERMISSION_MISSING'
  | 'APP_PAUSED'
  | 'PROHIBITED'
  | 'ADAPTER_ERROR'
  | 'POSTCONDITION_NOT_OBSERVED'
  | 'OUTCOME_UNKNOWN';
