import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	Assignment,
	TeamControlPlane,
	WorkerHandle,
	WorkerProbe,
	WorkerSpec,
} from "../../src/gjc-runtime/team-control-plane";
import { createHeadlessTeamControlPlane } from "../../src/gjc-runtime/team-control-plane-headless";
import {
	claimGjcTeamTask,
	resumeGjcTeam,
	shutdownGjcTeam,
	startGjcTeam,
	transitionGjcTeamTaskStatus,
} from "../../src/gjc-runtime/team-runtime";
import { brokerOwnerForTest } from "../../src/sdk/broker/ensure";

async function waitFor<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function readTree(root: string, excludedPaths: ReadonlySet<string> = new Set()): Promise<string> {
	const chunks: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const target = path.join(dir, entry.name);
			if (entry.isDirectory()) await visit(target);
			else {
				const relative = path.relative(root, target);
				if (!excludedPaths.has(relative))
					chunks.push(`${relative}\n${await fs.readFile(target, "utf8").catch(() => "")}`);
			}
		}
	};
	await visit(root);
	return chunks.join("\n");
}
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function initializeGitRepository(root: string): Promise<void> {
	await Bun.write(path.join(root, "README.txt"), "fixture\n");
	for (const command of [
		["git", "init"],
		["git", "add", "README.txt"],
		["git", "-c", "user.name=GJC Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"],
	]) {
		const result = Bun.spawnSync(command, { cwd: root, stdout: "ignore", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
}

function fakeControlPlane() {
	const spawned: WorkerSpec[] = [];
	const stopped: WorkerHandle[] = [];
	const dead = new Set<string>();
	const unknown = new Set<string>();
	const activeTurns = new Map<string, string>();
	let stopSucceeds = true;
	let generation = 0;
	const plane: TeamControlPlane = {
		kind: "headless",
		async spawnWorker(spec) {
			spawned.push(spec);
			generation += 1;
			const sessionId = `session-${spec.id}-${generation}`;
			return {
				handle: {
					workerId: spec.id,
					sessionId,
					controlPlane: "headless",
					discoveryRef: `.gjc/state/sdk/${sessionId}.json`,
					createdByDelegate: true,
				},
				delivery: {
					workerId: spec.id,
					sessionId,
					turnId: `turn-${spec.id}-${generation}`,
					accepted: true,
					queued: false,
					status: "delivering",
				},
			};
		},
		async awaitReady() {},
		async deliver(handle: WorkerHandle, assignment: Assignment) {
			return {
				workerId: handle.workerId,
				sessionId: handle.sessionId,
				turnId: assignment.idempotencyKey,
				accepted: true,
				queued: false,
				status: "delivering",
			};
		},
		async probe(handle: WorkerHandle): Promise<WorkerProbe> {
			if (dead.has(handle.sessionId))
				return {
					workerId: handle.workerId,
					sessionId: handle.sessionId,
					live: false,
					liveness: "dead",
					state: "stale",
				};
			if (unknown.has(handle.sessionId))
				return {
					workerId: handle.workerId,
					sessionId: handle.sessionId,
					live: false,
					liveness: "unknown",
					state: "unavailable",
				};
			const activeTurnId = activeTurns.get(handle.sessionId);
			if (activeTurnId)
				return {
					workerId: handle.workerId,
					sessionId: handle.sessionId,
					live: true,
					liveness: "alive",
					state: "running",
					activeTurnId,
				};
			return {
				workerId: handle.workerId,
				sessionId: handle.sessionId,
				live: true,
				liveness: "alive",
				state: "running",
			};
		},
		async stopWorker(handle) {
			if (!handle.createdByDelegate || !stopSucceeds) return false;
			stopped.push(handle);
			return true;
		},
	};
	return {
		plane,
		spawned,
		stopped,
		dead,
		unknown,
		activeTurns,
		setStopSucceeds(value: boolean) {
			stopSucceeds = value;
		},
	};
}

describe("headless team control plane", () => {
	test("reads canonical lifecycle separately from broker liveness", async () => {
		const responses = [
			{
				ok: true,
				status: { authority: "sdk_broker", live: true },
				session_state: {
					state: "ready_for_input",
					ready_for_input: true,
					current_turn_id: null,
				},
			},
			{
				ok: true,
				status: { authority: "sdk_broker", live: false },
				session_state: { state: "stale", ready_for_input: false, current_turn_id: null },
			},
		];
		const plane = createHeadlessTeamControlPlane({
			allowedWorkdir: process.cwd(),
			coordinator: {
				async callTool() {
					return responses.shift() ?? { ok: false };
				},
			},
		});
		const handle: WorkerHandle = {
			workerId: "worker-1",
			sessionId: "session-1",
			controlPlane: "headless",
			createdByDelegate: true,
		};
		expect(await plane.probe(handle)).toMatchObject({
			live: true,
			liveness: "alive",
			state: "ready_for_input",
		});
		expect(await plane.probe(handle)).toMatchObject({ live: false, liveness: "dead", state: "stale" });
	});

	test("awaits canonical ready_for_input instead of treating running as ready", async () => {
		let clock = 0;
		let readyForInput = false;
		const plane = createHeadlessTeamControlPlane({
			allowedWorkdir: process.cwd(),
			now: () => clock,
			sleep: async milliseconds => {
				clock += milliseconds;
			},
			coordinator: {
				async callTool() {
					return {
						ok: true,
						status: { authority: "sdk_broker", live: true },
						session_state: {
							state: "running",
							ready_for_input: readyForInput,
							current_turn_id: null,
						},
					};
				},
			},
		});
		const handle: WorkerHandle = {
			workerId: "worker-1",
			sessionId: "session-1",
			controlPlane: "headless",
			createdByDelegate: true,
		};

		await expect(plane.awaitReady(handle, 50)).rejects.toThrow("headless_worker_ready_timeout:worker-1");
		readyForInput = true;
		await expect(plane.awaitReady(handle, 50)).resolves.toBeUndefined();
	});

	test("distinguishes transient unknown from authoritative stale delegates", async () => {
		const responses = [
			{ ok: false, error: { code: "temporarily_unavailable" } },
			{
				ok: true,
				status: { authority: "sdk_broker", live: false },
				session_state: { state: "running", current_turn_id: "turn-1" },
			},
		];
		const plane = createHeadlessTeamControlPlane({
			allowedWorkdir: process.cwd(),
			coordinator: {
				async callTool() {
					return responses.shift() ?? { ok: false };
				},
			},
		});
		const handle: WorkerHandle = {
			workerId: "worker-1",
			sessionId: "session-1",
			controlPlane: "headless",
			createdByDelegate: true,
		};
		expect(await plane.probe(handle)).toMatchObject({ liveness: "unknown", state: "temporarily_unavailable" });
		expect(await plane.probe(handle)).toMatchObject({
			liveness: "dead",
			state: "stale_delegate",
			activeTurnId: "turn-1",
		});
	});
	test("spawns workers without tmux and persists only credential-free SDK discovery references", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-headless-"));
		roots.push(root);
		await initializeGitRepository(root);
		const stateRoot = path.join(root, ".gjc", "state");
		const fake = fakeControlPlane();
		const env = {
			...process.env,
			GJC_TEAM_BACKEND: "headless",
			GJC_TEAM_STATE_ROOT: stateRoot,
			PATH: "",
		};
		const snapshot = await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: "do durable work",
			teamName: "headless-fixture",
			cwd: root,
			env,
			worktreeMode: { enabled: false },
			controlPlane: fake.plane,
		});
		expect(fake.spawned).toHaveLength(2);
		expect(snapshot.workers.map(worker => worker.session_id)).toEqual(["session-worker-1-1", "session-worker-2-2"]);
		const identity = await fs.readFile(path.join(snapshot.state_dir, "config.json"), "utf8");
		expect(identity).not.toMatch(/token|credential|authorization/i);
		expect(JSON.parse(identity)).toMatchObject({
			control_plane: "headless",
			workers: [
				{ sdk_discovery_ref: ".gjc/state/sdk/session-worker-1-1.json" },
				{ sdk_discovery_ref: ".gjc/state/sdk/session-worker-2-2.json" },
			],
		});
		await shutdownGjcTeam(snapshot.team_name, root, env, fake.plane);
		expect(fake.stopped.map(handle => handle.sessionId)).toEqual(["session-worker-1-1", "session-worker-2-2"]);
	});

	test("uses the production coordinator and broker lifecycle without tmux", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-headless-production-"));
		roots.push(root);
		await initializeGitRepository(root);
		const agentDir = path.join(root, "agent");
		const fixture = path.join(root, "offline-session-host.ts");
		await fs.writeFile(
			fixture,
			`import { AgentSession } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/session/agent-session.ts"))};
import { runSessionHost } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/commands/sdk.ts"))};
AgentSession.prototype.sendUserMessage = async (_content, options) => {
	options?.onPreflightAccepted?.();
};
const request = JSON.parse(process.env.GJC_SDK_LIFECYCLE_REQUEST ?? "{}");
request.body = "";
process.env.GJC_SDK_LIFECYCLE_REQUEST = JSON.stringify(request);
await runSessionHost();
`,
		);
		const previous = {
			command: process.env.GJC_SDK_SESSION_COMMAND,
			agentDir: process.env.GJC_AGENT_DIR,
			codingAgentDir: process.env.GJC_CODING_AGENT_DIR,
		};
		const capturedOutput: string[] = [];
		const originalLog = console.log;
		const originalError = console.error;
		console.log = (...values: unknown[]) => capturedOutput.push(values.map(String).join(" "));
		console.error = (...values: unknown[]) => capturedOutput.push(values.map(String).join(" "));
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		process.env.GJC_AGENT_DIR = agentDir;
		process.env.GJC_CODING_AGENT_DIR = agentDir;
		const env = {
			...process.env,
			GJC_TEAM_BACKEND: "headless",
			GJC_TEAM_STATE_ROOT: path.join(root, ".gjc", "state"),
			PATH: path.join(root, "path-without-tmux"),
		};
		const plane = createHeadlessTeamControlPlane({ env, allowedWorkdir: root });
		try {
			const started = await startGjcTeam({
				workerCount: 1,
				agentType: "executor",
				task: "production lifecycle fixture",
				teamName: "headless-production",
				cwd: root,
				env,
				worktreeMode: { enabled: false },
				controlPlane: plane,
			});
			const first = started.workers[0];
			if (!first?.sdk_discovery_ref || !first.session_id) throw new Error("Missing production SDK worker identity.");
			const firstEndpointPath = path.join(first.worktree_path ?? root, first.sdk_discovery_ref);
			const firstEndpoint = await waitFor(async () => {
				try {
					return JSON.parse(await fs.readFile(firstEndpointPath, "utf8")) as { pid: number; token: string };
				} catch {
					return undefined;
				}
			}, "first SDK endpoint");
			expect(firstEndpoint.token).toBeTruthy();
			expect(
				await Promise.all([
					plane.probe({
						workerId: first.id,
						sessionId: first.session_id,
						controlPlane: "headless",
						discoveryRef: first.sdk_discovery_ref,
						createdByDelegate: true,
					}),
					fs.readFile(path.join(started.state_dir, "config.json"), "utf8"),
				]),
			).toEqual([
				expect.objectContaining({ liveness: "alive" }),
				expect.not.stringMatching(/token|authorization|credential/i),
			]);

			const claim = await claimGjcTeamTask(started.team_name, first.id, root, env, "task-1");
			expect(claim.ok).toBe(true);
			process.kill(firstEndpoint.pid, "SIGTERM");
			await waitFor(async () => {
				try {
					process.kill(firstEndpoint.pid, 0);
					return undefined;
				} catch {
					return true;
				}
			}, "first SDK host reap");
			await expect(
				plane.probe({
					workerId: first.id,
					sessionId: first.session_id!,
					controlPlane: "headless",
					discoveryRef: first.sdk_discovery_ref,
					createdByDelegate: true,
				}),
			).resolves.toMatchObject({ liveness: "dead", state: "stale_delegate" });

			const resumed = await resumeGjcTeam(started.team_name, root, env, plane);
			const replacement = resumed.workers[0];
			expect(replacement?.session_id).not.toBe(first.session_id);
			expect(replacement?.spawn_generation).toBeGreaterThan(first.spawn_generation ?? 0);
			if (!replacement?.sdk_discovery_ref || !replacement.session_id)
				throw new Error("Missing replacement production SDK worker identity.");
			const replacementEndpointPath = path.join(replacement.worktree_path ?? root, replacement.sdk_discovery_ref);
			const replacementEndpoint = await waitFor(async () => {
				try {
					return JSON.parse(await fs.readFile(replacementEndpointPath, "utf8")) as {
						pid: number;
						token: string;
					};
				} catch {
					return undefined;
				}
			}, "replacement SDK endpoint");
			expect(replacementEndpoint.token).toBeTruthy();
			expect(replacementEndpoint.token).not.toBe(firstEndpoint.token);
			const generatedEndpoints = [
				{ path: firstEndpointPath, token: firstEndpoint.token, contents: JSON.stringify(firstEndpoint) },
				{
					path: replacementEndpointPath,
					token: replacementEndpoint.token,
					contents: JSON.stringify(replacementEndpoint),
				},
			];
			for (const endpoint of generatedEndpoints) {
				const otherDiscoveryContents = generatedEndpoints
					.filter(candidate => candidate.path !== endpoint.path)
					.map(candidate => candidate.contents)
					.join("\n");
				expect(otherDiscoveryContents).not.toContain(endpoint.token);
				expect(await readTree(root, new Set([path.relative(root, endpoint.path)]))).not.toContain(endpoint.token);
			}
			const released = JSON.parse(await fs.readFile(path.join(resumed.state_dir, "tasks", "task-1.json"), "utf8"));
			expect(released).toMatchObject({ status: "pending" });
			expect(released.claim).toBeUndefined();
			const replacementClaim = await claimGjcTeamTask(started.team_name, replacement!.id, root, env, "task-1");
			if (!replacementClaim.ok || !replacementClaim.claim_token)
				throw new Error("Replacement worker did not reclaim task-1.");
			await transitionGjcTeamTaskStatus(
				started.team_name,
				"task-1",
				"completed",
				root,
				env,
				replacementClaim.claim_token,
				replacement!.id,
				{
					recorded_by: replacement!.id,
					summary: "Production broker lifecycle verified offline.",
					items: [
						{
							kind: "inspection",
							status: "verified",
							summary: "Replacement generation reclaimed task-1.",
						},
					],
				},
			);

			const replacementHandle = {
				workerId: replacement!.id,
				sessionId: replacement!.session_id!,
				controlPlane: "headless" as const,
				discoveryRef: replacement!.sdk_discovery_ref,
				createdByDelegate: true,
			};
			await expect(plane.probe(replacementHandle)).resolves.toMatchObject({ liveness: "alive" });
			await expect(plane.stopWorker(replacementHandle, "force")).resolves.toBe(true);
			await waitFor(async () => {
				const probe = await plane.probe(replacementHandle);
				return probe.liveness === "dead" ? probe : undefined;
			}, "replacement worker reap");
			const stopped = await shutdownGjcTeam(started.team_name, root, env, plane);
			expect(stopped).toMatchObject({
				phase: "complete",
				task_counts: { completed: 1, failed: 0 },
				workers: [{ spawn_generation: replacement!.spawn_generation, status: "stopped" }],
			});
			await expect(plane.probe(replacementHandle)).resolves.toMatchObject({ liveness: "dead" });
			for (const endpoint of generatedEndpoints) {
				expect(await readTree(root, new Set([path.relative(root, endpoint.path)]))).not.toContain(endpoint.token);
				expect(capturedOutput.join("\n")).not.toContain(endpoint.token);
			}
		} finally {
			console.log = originalLog;
			console.error = originalError;
			const owner = brokerOwnerForTest(agentDir);
			await owner?.stop();
			if (previous.command === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
			else process.env.GJC_SDK_SESSION_COMMAND = previous.command;
			if (previous.agentDir === undefined) delete process.env.GJC_AGENT_DIR;
			else process.env.GJC_AGENT_DIR = previous.agentDir;
			if (previous.codingAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previous.codingAgentDir;
		}
	}, 90_000);

	test("resume releases dead worker claims and respawns with the original worker spec", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-headless-resume-"));
		roots.push(root);
		await initializeGitRepository(root);
		const fake = fakeControlPlane();
		const env = {
			...process.env,
			GJC_TEAM_BACKEND: "headless",
			GJC_TEAM_STATE_ROOT: path.join(root, ".gjc", "state"),
		};
		const started = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "recoverable work",
			teamName: "headless-resume",
			cwd: root,
			env,
			worktreeMode: { enabled: false },
			controlPlane: fake.plane,
		});
		const claim = await claimGjcTeamTask(started.team_name, "worker-1", root, env, "task-1");
		expect(claim.ok).toBe(true);
		fake.dead.add("session-worker-1-1");

		const resumed = await resumeGjcTeam(started.team_name, root, env, fake.plane);
		expect(fake.stopped).toEqual([expect.objectContaining({ sessionId: "session-worker-1-1" })]);
		expect(started.workers[0]?.worktree_path).toBeUndefined();
		expect(fake.spawned).toEqual([
			expect.objectContaining({ id: "worker-1", cwd: root, prompt: "recoverable work" }),
			expect.objectContaining({ id: "worker-1", cwd: root, prompt: "recoverable work" }),
		]);
		expect(resumed.workers[0]).toMatchObject({
			session_id: "session-worker-1-2",
			sdk_discovery_ref: ".gjc/state/sdk/session-worker-1-2.json",
			status: "idle",
		});
		const task = JSON.parse(await fs.readFile(path.join(resumed.state_dir, "tasks", "task-1.json"), "utf8"));
		expect(task).toMatchObject({ status: "pending" });
		expect(task.claim).toBeUndefined();
		const manifest = JSON.parse(await fs.readFile(path.join(resumed.state_dir, "manifest.v2.json"), "utf8"));
		expect(manifest.workers[0].session_id).toBe("session-worker-1-2");
	});
	test("resume preserves claims and sessions when liveness is unknown", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-headless-unknown-"));
		roots.push(root);
		await initializeGitRepository(root);
		const fake = fakeControlPlane();
		const env = {
			...process.env,
			GJC_TEAM_BACKEND: "headless",
			GJC_TEAM_STATE_ROOT: path.join(root, ".gjc", "state"),
		};
		const started = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "preserve work",
			teamName: "headless-unknown",
			cwd: root,
			env,
			worktreeMode: { enabled: false },
			controlPlane: fake.plane,
		});
		const claim = await claimGjcTeamTask(started.team_name, "worker-1", root, env, "task-1");
		expect(claim.ok).toBe(true);
		fake.unknown.add("session-worker-1-1");

		const resumed = await resumeGjcTeam(started.team_name, root, env, fake.plane);
		expect(fake.spawned).toHaveLength(1);
		expect(resumed.workers[0]?.session_id).toBe("session-worker-1-1");
		expect(resumed.worker_lifecycle_by_id["worker-1"]).toMatchObject({
			lifecycle_state: "unavailable",
			stop_reason: "headless_session_unavailable",
		});
		const task = JSON.parse(await fs.readFile(path.join(resumed.state_dir, "tasks", "task-1.json"), "utf8"));
		expect(task).toMatchObject({ status: "in_progress", claim: { owner: "worker-1" } });
	});

	test("shutdown refuses terminal state when stopping a live worker fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-headless-stop-failure-"));
		roots.push(root);
		await initializeGitRepository(root);
		const fake = fakeControlPlane();
		const env = {
			...process.env,
			GJC_TEAM_BACKEND: "headless",
			GJC_TEAM_STATE_ROOT: path.join(root, ".gjc", "state"),
		};
		const started = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "surviving work",
			teamName: "headless-stop-failure",
			cwd: root,
			env,
			worktreeMode: { enabled: false },
			controlPlane: fake.plane,
		});
		fake.setStopSucceeds(false);
		await expect(shutdownGjcTeam(started.team_name, root, env, fake.plane)).rejects.toThrow(
			"headless_shutdown_stop_failed",
		);
		const config = JSON.parse(await fs.readFile(path.join(started.state_dir, "config.json"), "utf8"));
		expect(config.workers[0].status).not.toBe("stopped");
	});
	test("shutdown refuses terminal state while a worker has an active turn", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-headless-active-turn-"));
		roots.push(root);
		await initializeGitRepository(root);
		const fake = fakeControlPlane();
		const env = {
			...process.env,
			GJC_TEAM_BACKEND: "headless",
			GJC_TEAM_STATE_ROOT: path.join(root, ".gjc", "state"),
		};
		const started = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "active work",
			teamName: "headless-active-turn",
			cwd: root,
			env,
			worktreeMode: { enabled: false },
			controlPlane: fake.plane,
		});
		fake.activeTurns.set("session-worker-1-1", "turn-active");
		await expect(shutdownGjcTeam(started.team_name, root, env, fake.plane)).rejects.toThrow(
			"headless_shutdown_active_turn",
		);
		expect(fake.stopped).toEqual([]);
		const config = JSON.parse(await fs.readFile(path.join(started.state_dir, "config.json"), "utf8"));
		expect(config.workers[0].status).not.toBe("stopped");
	});
	test("headless dry-run is deterministic and does not call the coordinator", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-headless-dry-"));
		roots.push(root);
		const fake = fakeControlPlane();
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "dry work",
			teamName: "headless-dry",
			cwd: root,
			dryRun: true,
			env: { ...process.env, GJC_TEAM_BACKEND: "headless", GJC_TEAM_STATE_ROOT: path.join(root, ".gjc", "state") },
			worktreeMode: { enabled: false },
			controlPlane: fake.plane,
		});
		expect(fake.spawned).toEqual([]);
		expect(snapshot.workers[0]).toMatchObject({
			control_plane: "headless",
			session_id: "dry-run-worker-1",
			sdk_discovery_ref: "dry-run/worker-1",
		});
	});
});
