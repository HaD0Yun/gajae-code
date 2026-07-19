import { createHash } from "node:crypto";
import { getAgentDir } from "@gajae-code/utils";
import { createCoordinatorMcpServer } from "../coordinator-mcp/server";
import { ensureBroker } from "../sdk/broker/ensure";
import type {
	Assignment,
	DeliveryReceipt,
	TeamControlPlane,
	WorkerHandle,
	WorkerProbe,
	WorkerSpec,
} from "./team-control-plane";

export interface CoordinatorToolCaller {
	callTool(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface HeadlessTeamControlPlaneOptions {
	env?: NodeJS.ProcessEnv;
	allowedWorkdir: string;
	coordinator?: CoordinatorToolCaller;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	readyStates?: readonly string[];
}

function key(parts: string[]): string {
	return `team-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`headless_coordinator_missing_${field}`);
	return value;
}

function requireOk(result: Record<string, unknown>, operation: string): Record<string, unknown> {
	if (result.ok !== true) {
		const error = result.error as Record<string, unknown> | undefined;
		throw new Error(typeof error?.message === "string" ? error.message : `headless_${operation}_failed`);
	}
	return result;
}

function receipt(workerId: string, sessionId: string, result: Record<string, unknown>): DeliveryReceipt {
	return {
		workerId,
		sessionId,
		turnId: requiredString(result.turn_id, "turn_id"),
		accepted: result.delivered === true,
		queued: result.queued === true,
		status: typeof result.status === "string" ? result.status : "unknown",
	};
}

export function createHeadlessTeamControlPlane(options: HeadlessTeamControlPlaneOptions): TeamControlPlane {
	const env: NodeJS.ProcessEnv = {
		...(options.env ?? process.env),
		GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
		GJC_COORDINATOR_MCP_WORKDIR_ROOTS: options.allowedWorkdir,
		GJC_COORDINATOR_MCP_FORCE_STOP: "1",
	};
	const agentDir = env.GJC_AGENT_DIR ?? env.GJC_CODING_AGENT_DIR ?? getAgentDir();
	const coordinator =
		options.coordinator ??
		(() => {
			const server = createCoordinatorMcpServer({
				env,
				services: { getAgentDir: () => agentDir },
			});
			return {
				async callTool(name: string, args?: Record<string, unknown>) {
					if (name === "gjc_coordinator_start_session") await ensureBroker({ agentDir, env });
					return await server.callTool(name, args);
				},
			};
		})();
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? Bun.sleep;
	const probe = async (handle: WorkerHandle): Promise<WorkerProbe & { readyForInput?: boolean }> => {
		let result: Record<string, unknown>;
		try {
			result = await coordinator.callTool("gjc_coordinator_read_status", { session_id: handle.sessionId });
		} catch {
			return {
				workerId: handle.workerId,
				sessionId: handle.sessionId,
				live: false,
				liveness: "unknown",
				state: "unavailable",
			};
		}
		if (result.ok !== true) {
			const error = result.error as Record<string, unknown> | undefined;
			const confirmedMissing = error?.code === "not_found";
			return {
				workerId: handle.workerId,
				sessionId: handle.sessionId,
				live: false,
				liveness: confirmedMissing ? "dead" : "unknown",
				state:
					typeof result.reason === "string"
						? result.reason
						: typeof error?.code === "string"
							? error.code
							: "unavailable",
			};
		}
		const transport = (result.status ?? {}) as Record<string, unknown>;
		const lifecycle = (result.session_state ?? {}) as Record<string, unknown>;
		const state = typeof lifecycle.state === "string" ? lifecycle.state : "unknown";
		const transportLive = transport.live;
		const terminalLifecycle = state === "completed" || state === "errored" || state === "stale";
		const staleDelegate = transportLive === false && !terminalLifecycle;
		const liveness =
			transportLive === true && !terminalLifecycle ? "alive" : transportLive === false ? "dead" : "unknown";
		return {
			workerId: handle.workerId,
			sessionId: handle.sessionId,
			live: liveness === "alive",
			liveness,
			state: staleDelegate ? "stale_delegate" : state,
			readyForInput: lifecycle.ready_for_input === true,
			...(typeof lifecycle.current_turn_id === "string" ? { activeTurnId: lifecycle.current_turn_id } : {}),
		};
	};
	return {
		kind: "headless",
		async spawnWorker(spec: WorkerSpec) {
			const result = requireOk(
				await coordinator.callTool("gjc_coordinator_start_session", {
					cwd: spec.cwd,
					...(spec.modelPreset ? { mpreset: spec.modelPreset } : {}),
					idempotency_key: key(["spawn", spec.id, String(spec.generation ?? 1), spec.cwd]),
					allow_mutation: true,
				}),
				"spawn",
			);
			const session = (result.session ?? {}) as Record<string, unknown>;
			const sessionId = requiredString(result.session_id ?? session.session_id, "session_id");
			const discoveryRef = `.gjc/state/sdk/${sessionId}.json`;
			return {
				handle: {
					workerId: spec.id,
					sessionId,
					controlPlane: "headless",
					discoveryRef,
					createdByDelegate: true,
				},
				delivery: {
					workerId: spec.id,
					sessionId,
					turnId: sessionId,
					accepted: true,
					queued: false,
					status: "created",
				},
			};
		},
		async deliver(handle: WorkerHandle, assignment: Assignment) {
			const result = requireOk(
				await coordinator.callTool("gjc_coordinator_send_prompt", {
					session_id: handle.sessionId,
					prompt: assignment.prompt,
					idempotency_key: assignment.idempotencyKey,
					queue: assignment.queue === true,
					allow_mutation: true,
				}),
				"delivery",
			);
			return receipt(handle.workerId, handle.sessionId, result);
		},
		async awaitReady(handle: WorkerHandle, timeoutMs: number) {
			const deadline = now() + timeoutMs;
			do {
				const status = await probe(handle);
				if (status.live && status.readyForInput) return;
				if (now() >= deadline) break;
				await sleep(Math.min(50, Math.max(0, deadline - now())));
			} while (now() <= deadline);
			throw new Error(`headless_worker_ready_timeout:${handle.workerId}`);
		},
		probe,
		async stopWorker(handle: WorkerHandle, mode) {
			if (!handle.createdByDelegate) return false;
			const result = await coordinator.callTool("gjc_coordinator_stop_session", {
				session_id: handle.sessionId,
				reason: "team_shutdown",
				allow_mutation: true,
				force: mode === "force",
			});
			return result.ok === true && result.closed === true;
		},
	};
}
