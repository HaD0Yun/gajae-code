import { describe, expect, test } from "bun:test";
import type { WorkerHandle } from "../../src/gjc-runtime/team-control-plane";
import { createTmuxTeamControlPlane } from "../../src/gjc-runtime/team-control-plane-tmux";
import { resolveGjcTeamControlPlaneKind } from "../../src/gjc-runtime/team-runtime";

const workerHandle: WorkerHandle = {
	workerId: "worker-1",
	sessionId: "%2",
	controlPlane: "tmux",
	createdByDelegate: true,
};

describe("tmux team control plane", () => {
	test("is selected for an unset or explicit tmux backend", () => {
		expect(resolveGjcTeamControlPlaneKind({})).toBe("tmux");
		expect(resolveGjcTeamControlPlaneKind({ GJC_TEAM_BACKEND: "tmux" })).toBe("tmux");
		expect(resolveGjcTeamControlPlaneKind({ GJC_TEAM_BACKEND: "headless" })).toBe("headless");
	});

	test("delegates operations in call order and scopes stop to owned tmux workers", async () => {
		const calls: string[] = [];
		const probe = { workerId: "worker-1", sessionId: "%2", live: true, state: "running" };
		const delivery = {
			workerId: "worker-1",
			sessionId: "%2",
			turnId: "turn-1",
			accepted: true,
			queued: false,
			status: "delivering",
		};
		const plane = createTmuxTeamControlPlane({
			async spawn() {
				calls.push("spawn");
				return { handle: workerHandle, delivery };
			},
			async awaitReady() {
				calls.push("awaitReady");
				return;
			},
			async deliver() {
				calls.push("deliver");
				return delivery;
			},
			async probe() {
				calls.push("probe");
				return probe;
			},
			async stop(_handle, mode) {
				calls.push(`stop:${mode}`);
				return true;
			},
		});

		const spawned = await plane.spawnWorker({ id: "worker-1", cwd: "/tmp", prompt: "work" });
		await plane.awaitReady(spawned.handle, 1000);
		await plane.deliver(spawned.handle, { workerId: "worker-1", prompt: "next", idempotencyKey: "next-1" });
		await plane.probe(spawned.handle);
		await plane.stopWorker(spawned.handle, "graceful");
		expect(calls).toEqual(["spawn", "awaitReady", "deliver", "probe", "stop:graceful"]);

		const leader = { ...workerHandle, workerId: "leader", sessionId: "%1", createdByDelegate: false };
		const foreign = { ...workerHandle, controlPlane: "headless" as const };
		expect(await plane.stopWorker(leader, "force")).toBe(false);
		expect(await plane.stopWorker(foreign, "force")).toBe(false);
		expect(calls).toEqual(["spawn", "awaitReady", "deliver", "probe", "stop:graceful"]);
	});
});
