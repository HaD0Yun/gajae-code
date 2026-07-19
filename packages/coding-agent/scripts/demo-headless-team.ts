import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readTeamWatchFrame, renderTeamWatchPlain } from "../src/commands/team-watch";
import type { TeamControlPlane } from "../src/gjc-runtime/team-control-plane";
import {
	appendGjcTeamEvent,
	claimGjcTeamTask,
	readGjcTeamEvents,
	readGjcTeamSnapshot,
	readGjcTeamTask,
	resumeGjcTeam,
	shutdownGjcTeam,
	startGjcTeam,
	transitionGjcTeamTaskStatus,
	updateGjcWorkerHeartbeat,
	updateGjcWorkerStatus,
} from "../src/gjc-runtime/team-runtime";

const TEAM = "headless-demo";
const WATCH_NOW = Date.parse("2030-01-01T00:00:30.000Z");
const BRIEF = `### Lane A — Prepare shared input
Produce the deterministic input.

### Lane B — Consume shared input (after: A)
Consume A's result.`;

const deadSessions = new Set<string>();
const probes: Array<{ sessionId: string; live: boolean }> = [];

const fakeControlPlane: TeamControlPlane = {
	kind: "headless",
	async spawnWorker(spec) {
		return {
			handle: {
				workerId: spec.id,
				sessionId: `fake-${spec.id}-${spec.generation ?? 1}`,
				controlPlane: "headless",
				createdByDelegate: true,
			},
			delivery: {
				workerId: spec.id,
				sessionId: `fake-${spec.id}-${spec.generation ?? 1}`,
				turnId: "fake-turn",
				accepted: true,
				queued: false,
				status: "accepted",
			},
		};
	},
	async awaitReady() {},
	async deliver(handle) {
		return {
			workerId: handle.workerId,
			sessionId: handle.sessionId,
			turnId: "fake-turn",
			accepted: true,
			queued: false,
			status: "accepted",
		};
	},
	async probe(handle) {
		const live = !deadSessions.has(handle.sessionId);
		probes.push({ sessionId: handle.sessionId, live });
		return {
			workerId: handle.workerId,
			sessionId: handle.sessionId,
			live,
			state: live ? "ready" : "stale",
			liveness: live ? "alive" : "dead",
		};
	},
	async stopWorker() {
		return true;
	},
};

async function main(): Promise<void> {
	const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-headless-team-demo-"));
	const stateRoot = path.join(fixture, ".gjc", "team");
	const env = { ...process.env, GJC_TEAM_BACKEND: "headless", GJC_TEAM_STATE_ROOT: stateRoot };
	const previousStateRoot = process.env.GJC_TEAM_STATE_ROOT;
	process.env.GJC_TEAM_STATE_ROOT = stateRoot;
	const checks: Array<[string, boolean]> = [];
	const output: string[] = [];
	const check = (label: string, condition: boolean): void => {
		checks.push([label, condition]);
	};
	const scene = async (label: string): Promise<void> => {
		output.push(`=== ${label} ===`, renderTeamWatchPlain(await readTeamWatchFrame(TEAM, WATCH_NOW)), "");
	};

	try {
		await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: BRIEF,
			teamName: TEAM,
			cwd: fixture,
			env,
			dryRun: true,
			controlPlane: fakeControlPlane,
		});
		await updateGjcWorkerHeartbeat(
			TEAM,
			"worker-1",
			{ pid: 0, last_turn_at: "2030-01-01T00:00:20.000Z", turn_count: 1, alive: true },
			fixture,
			env,
		);
		await updateGjcWorkerHeartbeat(
			TEAM,
			"worker-2",
			{ pid: 0, last_turn_at: "2030-01-01T00:00:15.000Z", turn_count: 1, alive: true },
			fixture,
			env,
		);
		await scene("two workers");
		check("two workers are visible", (await readGjcTeamSnapshot(TEAM, fixture, env)).workers.length === 2);

		await updateGjcWorkerHeartbeat(
			TEAM,
			"worker-1",
			{ pid: 0, last_turn_at: "2030-01-01T00:00:29.000Z", turn_count: 2, alive: true },
			fixture,
			env,
		);
		await appendGjcTeamEvent(TEAM, "heartbeat_observed", "worker-1", fixture, env);
		await scene("heartbeat update");
		check(
			"heartbeat update is rendered",
			(await readTeamWatchFrame(TEAM, WATCH_NOW)).workers[0]?.heartbeat_age_ms === 1_000,
		);

		const blockedClaim = await claimGjcTeamTask(TEAM, "worker-2", fixture, env, "task-2");
		await updateGjcWorkerStatus(TEAM, "worker-2", "blocked", fixture, env, "task-2", blockedClaim.reason);
		await scene("B blocked by A");
		check("dependency blocks B", !blockedClaim.ok && blockedClaim.reason === "blocked_by_dependency:task-1");

		const claimA = await claimGjcTeamTask(TEAM, "worker-1", fixture, env, "task-1");
		if (!claimA.ok || !claimA.claim_token) throw new Error(`claim A failed: ${claimA.reason}`);
		await transitionGjcTeamTaskStatus(TEAM, "task-1", "completed", fixture, env, claimA.claim_token, "worker-1", {
			summary: "A produced input",
			items: [{ kind: "inspection", status: "verified", summary: "Fake worker assertion" }],
		});
		const claimB = await claimGjcTeamTask(TEAM, "worker-2", fixture, env, "task-2");
		if (!claimB.ok || !claimB.claim_token) throw new Error(`claim B failed: ${claimB.reason}`);
		await updateGjcWorkerStatus(TEAM, "worker-2", "working", fixture, env, "task-2");
		await scene("B progressing after A");
		check("B claims after A completes", claimB.task?.status === "in_progress");

		const workerTwoSession = (await readGjcTeamSnapshot(TEAM, fixture, env)).workers[1]?.session_id;
		if (!workerTwoSession) throw new Error("worker-2 session missing");
		deadSessions.add(workerTwoSession);

		const resumed = await resumeGjcTeam(TEAM, fixture, env, fakeControlPlane);
		const resumedWorker = resumed.workers.find(worker => worker.id === "worker-2");
		const releasedTask = await readGjcTeamTask(TEAM, "task-2", fixture, env);
		check(
			"production resume authoritatively probes the interrupted worker dead",
			probes.some(probe => probe.sessionId === workerTwoSession && !probe.live),
		);
		check("resume releases the dead worker claim", releasedTask?.status === "pending" && releasedTask.claim == null);
		check(
			"resume replaces the dead worker session",
			resumedWorker?.session_id !== workerTwoSession && resumedWorker?.spawn_generation === 2,
		);

		const reclaimedB = await claimGjcTeamTask(TEAM, "worker-2", fixture, env, "task-2");
		if (!reclaimedB.ok || !reclaimedB.claim_token) throw new Error(`reclaim B failed: ${reclaimedB.reason}`);
		check(
			"resumed worker reclaims B with a new token",
			reclaimedB.task?.status === "in_progress" && reclaimedB.claim_token !== claimB.claim_token,
		);
		await updateGjcWorkerStatus(TEAM, "worker-2", "working", fixture, env, "task-2");
		await updateGjcWorkerHeartbeat(
			TEAM,
			"worker-2",
			{ pid: 0, last_turn_at: "2030-01-01T00:00:30.000Z", turn_count: 2, alive: true },
			fixture,
			env,
		);
		await scene("B resumed and reclaimed");

		await transitionGjcTeamTaskStatus(TEAM, "task-2", "completed", fixture, env, reclaimedB.claim_token, "worker-2", {
			summary: "B consumed input after recovery",
			items: [{ kind: "inspection", status: "verified", summary: "Fake worker assertion" }],
		});
		await shutdownGjcTeam(TEAM, fixture, env, fakeControlPlane);
		await scene("terminal complete");
		const finalSnapshot = await readGjcTeamSnapshot(TEAM, fixture, env);
		const events = await readGjcTeamEvents(TEAM, fixture, env);
		check("terminal phase is complete", finalSnapshot.phase === "complete");
		check("both tasks completed", finalSnapshot.task_counts.completed === 2);
		const recoverySequence = [
			"task_claim_released",
			"worker_resumed",
			"task_claimed",
			"task_transitioned",
			"team_shutdown",
		];
		let recoveryCursor = -1;
		check(
			"runtime recovery event sequence preserves dependency order",
			recoverySequence.every(type => {
				recoveryCursor = events.findIndex((event, index) => index > recoveryCursor && event.type === type);
				return recoveryCursor >= 0;
			}),
		);

		output.push("=== assertions ===", ...checks.map(([label, passed]) => `${passed ? "PASS" : "FAIL"}: ${label}`));
		process.stdout.write(`${output.join("\n")}\n`);
		if (checks.some(([, passed]) => !passed)) process.exitCode = 1;
	} finally {
		if (previousStateRoot === undefined) delete process.env.GJC_TEAM_STATE_ROOT;
		else process.env.GJC_TEAM_STATE_ROOT = previousStateRoot;
		await fs.rm(fixture, { recursive: true, force: true });
	}
}

await main().catch(error => {
	process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
