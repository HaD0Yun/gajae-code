import type {
	Assignment,
	DeliveryReceipt,
	StopMode,
	TeamControlPlane,
	WorkerHandle,
	WorkerProbe,
	WorkerSpec,
} from "./team-control-plane";

export interface TmuxControlPlanePrimitives {
	spawn(spec: WorkerSpec): Promise<{ handle: WorkerHandle; delivery: DeliveryReceipt }>;
	awaitReady(handle: WorkerHandle, timeoutMs: number): Promise<void>;
	deliver(handle: WorkerHandle, assignment: Assignment): Promise<DeliveryReceipt>;
	probe(handle: WorkerHandle): Promise<WorkerProbe>;
	stop(handle: WorkerHandle, mode: StopMode): Promise<boolean>;
}

/** A deliberately thin adapter: tmux command construction remains owned by the runtime. */
export function createTmuxTeamControlPlane(primitives: TmuxControlPlanePrimitives): TeamControlPlane {
	return {
		kind: "tmux",
		spawnWorker: spec => primitives.spawn(spec),
		awaitReady: (handle, timeoutMs) => primitives.awaitReady(handle, timeoutMs),
		deliver: (handle, assignment) => primitives.deliver(handle, assignment),
		probe: handle => primitives.probe(handle),
		stopWorker(handle, mode) {
			if (handle.controlPlane !== "tmux" || !handle.createdByDelegate) return Promise.resolve(false);
			return primitives.stop(handle, mode);
		},
	};
}
