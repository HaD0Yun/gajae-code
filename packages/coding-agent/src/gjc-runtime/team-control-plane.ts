export type TeamControlPlaneKind = "tmux" | "headless";

export interface WorkerSpec {
	id: string;
	cwd: string;
	generation?: number;
	prompt: string;
	modelPreset?: string;
}

export interface WorkerHandle {
	workerId: string;
	sessionId: string;
	controlPlane: TeamControlPlaneKind;
	discoveryRef?: string;
	createdByDelegate: boolean;
}

export interface Assignment {
	workerId: string;
	prompt: string;
	idempotencyKey: string;
	queue?: boolean;
}

export interface DeliveryReceipt {
	workerId: string;
	sessionId: string;
	turnId: string;
	accepted: boolean;
	queued: boolean;
	status: string;
}

export interface WorkerProbe {
	workerId: string;
	sessionId: string;
	live: boolean;
	state: string;
	activeTurnId?: string;
	liveness?: "alive" | "dead" | "unknown";
}

export type StopMode = "graceful" | "force";

export interface TeamControlPlane {
	readonly kind: TeamControlPlaneKind;
	spawnWorker(spec: WorkerSpec): Promise<{ handle: WorkerHandle; delivery: DeliveryReceipt }>;
	awaitReady(handle: WorkerHandle, timeoutMs: number): Promise<void>;
	deliver(handle: WorkerHandle, assignment: Assignment): Promise<DeliveryReceipt>;
	probe(handle: WorkerHandle): Promise<WorkerProbe>;
	stopWorker(handle: WorkerHandle, mode: StopMode): Promise<boolean>;
}
