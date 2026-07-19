import {
	type GjcTeamEvent,
	type GjcTeamSnapshot,
	type GjcTeamTask,
	listGjcTeamTasks,
	readGjcTeamEvents,
	readGjcTeamSnapshot,
	readGjcWorkerHeartbeat,
} from "../gjc-runtime/team-runtime";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

function safeText(value: unknown): string {
	return String(value ?? "").replace(CONTROL_CHARACTERS, "�");
}

export function parseTeamWatchTarget(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (!arg) continue;
		if (arg === "--interval-ms") {
			index += 1;
			continue;
		}
		if (arg.startsWith("--")) continue;
		return arg;
	}
	return undefined;
}

export interface TeamWatchWorker {
	id: string;
	role: string;
	lifecycle: string;
	claim: string | null;
	title: string | null;
	task_status: string | null;
	reason: string | null;
	heartbeat_age_ms: number | null;
	latest_event: string | null;
	integration: string;
}

export interface TeamWatchFrame {
	team_name: string;
	phase: string;
	task_counts: Record<string, number>;
	workers: TeamWatchWorker[];
	latest_event: string | null;
}

function eventLabel(event: GjcTeamEvent | undefined): string | null {
	if (!event) return null;
	return safeText([event.type, event.task_id, event.message].filter(Boolean).join(": "));
}

function heartbeatAge(value: string | undefined, nowMs: number): number | null {
	const timestamp = Date.parse(value ?? "");
	return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : null;
}

export async function readTeamWatchFrame(teamName: string, nowMs = Date.now()): Promise<TeamWatchFrame> {
	const [snapshot, tasks, events] = await Promise.all([
		readGjcTeamSnapshot(teamName),
		listGjcTeamTasks(teamName),
		readGjcTeamEvents(teamName),
	]);
	const heartbeats = await Promise.all(snapshot.workers.map(worker => readGjcWorkerHeartbeat(teamName, worker.id)));
	return buildTeamWatchFrame(snapshot, tasks, events, heartbeats, nowMs);
}

export function buildTeamWatchFrame(
	snapshot: GjcTeamSnapshot,
	tasks: GjcTeamTask[],
	events: GjcTeamEvent[],
	heartbeats: Array<{ last_turn_at?: string } | null>,
	nowMs: number,
): TeamWatchFrame {
	return {
		team_name: safeText(snapshot.team_name),
		phase: safeText(snapshot.phase),
		task_counts: snapshot.task_counts,
		workers: snapshot.workers.map((worker, index) => {
			const claimedTask =
				tasks.find(candidate => candidate.status === "in_progress" && candidate.claim?.owner === worker.id) ??
				tasks.find(
					candidate =>
						candidate.status === "in_progress" &&
						candidate.assignee === worker.id &&
						(!candidate.claim || candidate.claim.owner === worker.id),
				);
			const pendingTask = tasks.find(
				candidate =>
					candidate.status === "pending" && (candidate.owner === worker.id || candidate.assignee === worker.id),
			);
			const task = claimedTask ?? pendingTask;
			const blockingDependency = pendingTask?.depends_on?.find(
				dependencyId => tasks.find(candidate => candidate.id === dependencyId)?.status !== "completed",
			);
			const latestEvent = [...events].reverse().find(event => event.worker === worker.id);
			const integration = snapshot.integration_by_worker?.[worker.id];
			return {
				id: safeText(worker.id),
				role: safeText(worker.role),
				lifecycle: safeText(snapshot.worker_lifecycle_by_id[worker.id]?.lifecycle_state ?? worker.status),
				claim: claimedTask ? safeText(claimedTask.id) : null,
				title: task ? safeText(task.title) : null,
				task_status: blockingDependency ? "blocked" : task ? safeText(task.status) : null,
				reason: blockingDependency ? safeText(`blocked_by_dependency:${blockingDependency}`) : null,
				heartbeat_age_ms: heartbeatAge(heartbeats[index]?.last_turn_at ?? worker.last_heartbeat, nowMs),
				latest_event: eventLabel(latestEvent),
				integration: safeText(integration?.status ?? "idle"),
			};
		}),
		latest_event: eventLabel(events.at(-1)),
	};
}

function ageLabel(age: number | null): string {
	if (age === null) return "unknown";
	return `${Math.floor(age / 1000)}s`;
}

export function renderTeamWatchPlain(frame: TeamWatchFrame): string {
	const counts = Object.entries(frame.task_counts)
		.map(([status, count]) => `${status}=${count}`)
		.join(" ");
	return [
		`team: ${frame.team_name}`,
		`phase: ${frame.phase}`,
		`tasks: ${counts}`,
		`latest event: ${frame.latest_event ?? "none"}`,
		"workers:",
		...frame.workers.map(
			worker =>
				`- ${worker.id} role=${worker.role} lifecycle=${worker.lifecycle} claim=${worker.claim ?? "none"} title=${worker.title ?? "none"} task_status=${worker.task_status ?? "none"} reason=${worker.reason ?? "none"} heartbeat=${ageLabel(worker.heartbeat_age_ms)} event=${worker.latest_event ?? "none"} integration=${worker.integration}`,
		),
	].join("\n");
}

export async function runTeamWatch(
	teamName: string,
	options: { json: boolean; plain: boolean; once: boolean; intervalMs: number },
): Promise<void> {
	if (options.json || options.once) {
		const frame = await readTeamWatchFrame(teamName);
		process.stdout.write(`${options.json ? JSON.stringify(frame, null, 2) : renderTeamWatchPlain(frame)}\n`);
		return;
	}

	await new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		let first = true;
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		};
		const stop = (): void => {
			if (stopped) return;
			stopped = true;
			cleanup();
			resolve();
		};
		const poll = async (): Promise<void> => {
			try {
				const frame = await readTeamWatchFrame(teamName);
				if (stopped) return;
				const prefix = options.plain ? (first ? "" : "\n") : "\u001b[2J\u001b[H";
				process.stdout.write(`${prefix}${renderTeamWatchPlain(frame)}\n`);
				first = false;
				timer = setTimeout(() => void poll(), options.intervalMs);
			} catch (error) {
				stopped = true;
				cleanup();
				reject(error);
			}
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		void poll();
	});
}
