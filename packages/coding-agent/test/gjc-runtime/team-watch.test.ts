import { describe, expect, test } from "bun:test";
import { buildTeamWatchFrame, parseTeamWatchTarget, renderTeamWatchPlain } from "../../src/commands/team-watch";
import type { GjcTeamSnapshot, GjcTeamTask } from "../../src/gjc-runtime/team-runtime";

const NOW = Date.parse("2026-01-01T00:00:10.000Z");

function snapshot(phase: GjcTeamSnapshot["phase"]): GjcTeamSnapshot {
	return {
		team_name: "watch-fixture",
		display_name: "Watch Fixture",
		phase,
		state_dir: "/tmp/read-only",
		tmux_session: "fixture:0",
		tmux_session_name: "fixture",
		tmux_target: "fixture:0",
		task_total: 1,
		task_counts: { pending: 0, blocked: 0, in_progress: 1, completed: 0, failed: 0 },
		workers: [
			{
				id: "worker-1",
				name: "Worker 1",
				index: 1,
				agent_type: "gjc",
				role: "executor",
				status: "busy",
				last_heartbeat: "2026-01-01T00:00:05.000Z",
				assigned_tasks: ["task-1"],
			},
		],
		integration_by_worker: { "worker-1": { status: "integrated" } },
		worker_lifecycle_by_id: {
			"worker-1": {
				worker: "worker-1",
				lifecycle_state: "working",
				worker_status_state: "working",
				updated_at: "2026-01-01T00:00:05.000Z",
			},
		},
		notification_summary: {
			total: 0,
			replay_eligible: 0,
			by_state: { pending: 0, sent: 0, queued: 0, deferred: 0, failed: 0, delivered: 0, acknowledged: 0 },
		},
		updated_at: "2026-01-01T00:00:05.000Z",
	};
}

const task: GjcTeamTask = {
	id: "task-1",
	subject: "Implement",
	description: "Implement watch",
	title: "Implement watch",
	objective: "Observe",
	status: "in_progress",
	assignee: "worker-1",
	version: 1,
	claim: { owner: "worker-1", token: "secret-token", leased_until: "2026-01-01T00:01:00.000Z" },
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:05.000Z",
};

function render(phase: GjcTeamSnapshot["phase"]): string {
	return renderTeamWatchPlain(
		buildTeamWatchFrame(
			snapshot(phase),
			[task],
			[
				{
					event_id: "e1",
					ts: "2026-01-01T00:00:06.000Z",
					type: "task_claimed",
					worker: "worker-1",
					task_id: "task-1",
				},
			],
			[{ last_turn_at: "2026-01-01T00:00:05.000Z" }],
			NOW,
		),
	);
}

describe("team watch", () => {
	test.each(["running", "complete", "cancelled"] as const)("renders stable ANSI-free %s state", phase => {
		const output = render(phase);
		expect(output).toContain(`phase: ${phase}`);
		expect(output).toContain(
			"worker-1 role=executor lifecycle=working claim=task-1 title=Implement watch task_status=in_progress reason=none heartbeat=5s",
		);
		expect(output).not.toMatch(/\u001b\[/);
	});

	test("frame is deterministic and does not expose claim tokens", () => {
		const source = JSON.stringify({ snapshot: snapshot("running"), task });
		const frame = buildTeamWatchFrame(snapshot("running"), [task], [], [null], NOW);
		expect(JSON.stringify(frame)).not.toContain("secret-token");
		expect(JSON.stringify({ snapshot: snapshot("running"), task })).toBe(source);
	});

	test("sanitizes worker-controlled text and prioritizes active claims", () => {
		const claimed = { ...task, id: "active\u001b[31m", title: "claimed\nwork", assignee: "other" };
		const staleAssignment = { ...task, id: "assigned", title: "assigned", claim: undefined };
		const unsafeSnapshot = snapshot("running");
		unsafeSnapshot.workers[0] = {
			...unsafeSnapshot.workers[0],
			role: "executor\u001b[2J",
			assigned_tasks: ["assigned"],
		};
		const frame = buildTeamWatchFrame(
			unsafeSnapshot,
			[staleAssignment, claimed],
			[
				{
					event_id: "e2",
					ts: "2026-01-01T00:00:06.000Z",
					type: "note",
					worker: "worker-1",
					message: "x\r\u001b[H",
				},
			],
			[null],
			NOW,
		);
		const output = renderTeamWatchPlain(frame);
		expect(frame.workers[0]?.claim).toBe("active�[31m");
		expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
		expect(output).toContain("claimed�work");
	});
	test("does not use an assignee fallback that conflicts with an authoritative owner claim", () => {
		const conflictingClaim = {
			...task,
			assignee: "worker-1",
			claim: { ...task.claim!, owner: "worker-2" },
		};
		const frame = buildTeamWatchFrame(snapshot("running"), [conflictingClaim], [], [null], NOW);

		expect(frame.workers[0]?.claim).toBeNull();
		expect(frame.workers[0]?.title).toBeNull();
	});

	test("renders dependency-blocked ownership without an active claim, then the actual claim after transition", () => {
		const prerequisite = {
			...task,
			id: "task-0",
			title: "Prerequisite",
			status: "in_progress" as const,
			assignee: "worker-2",
			claim: { ...task.claim!, owner: "worker-2" },
		};
		const blocked = {
			...task,
			status: "pending" as const,
			claim: undefined,
			owner: "worker-1",
			depends_on: ["task-0"],
		};
		const blockedFrame = buildTeamWatchFrame(snapshot("running"), [prerequisite, blocked], [], [null], NOW);
		expect(renderTeamWatchPlain(blockedFrame)).toContain(
			"claim=none title=Implement watch task_status=blocked reason=blocked_by_dependency:task-0",
		);

		const completedPrerequisite = { ...prerequisite, status: "completed" as const };
		const claimed = { ...blocked, status: "in_progress" as const, claim: task.claim };
		const inProgressFrame = buildTeamWatchFrame(
			snapshot("running"),
			[completedPrerequisite, claimed],
			[],
			[null],
			NOW,
		);
		expect(renderTeamWatchPlain(inProgressFrame)).toContain(
			"claim=task-1 title=Implement watch task_status=in_progress reason=none",
		);
	});
	test("parses the team name independently of watch flag ordering", () => {
		expect(parseTeamWatchTarget(["--interval-ms", "500", "--plain", "demo"])).toBe("demo");
		expect(parseTeamWatchTarget(["demo", "--interval-ms=500", "--once"])).toBe("demo");
	});
});
