import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { type ChoiceAnswer, judgeQuestions, type Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleChain } from "../config/model-resolver";
import { MODEL_ROLE_IDS, roleCandidatePool } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { hasNativeJudge, type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import questionFile from "../prompts/judge/task-model.json" with { type: "json" };
import type { CostGate } from "../session/cost-gate";
import { MAX_TINY_MESSAGE_CHARS, truncateTinyMessage } from "../tiny/message-preproc";

export type AutoTaskModelRole = string;

/** Minimum probability for the winning role; uncertainty must not downgrade a task. */
export const AUTO_TASK_MODEL_MIN_PROBABILITY = 0.7;
export const AUTO_TASK_MODEL_TIMEOUT_MS = 4000;

export interface AutoTaskModelOptions {
	settings: Settings;
	registry: ModelRegistry;
	sessionModel?: Model;
	task: string;
	context?: string;
	agent?: string;
	signal?: AbortSignal;
	sessionId?: string;
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
	costGate?: CostGate;
}

export interface AutoTaskModelDecision {
	/** Pass this selector through the ordinary model-role resolver. */
	role: `@${string}`;
	/** True when the conservative route was chosen without a confident usable judgment. */
	fallback: boolean;
}

const QUESTIONS = judgeQuestions(questionFile);
/** Configured aliases only: built-in semantic roles are routing policies, not model choices. */
function availableRoles(options: AutoTaskModelOptions): Map<string, string> {
	const roles = new Map<string, string>();
	for (const [role, selector] of Object.entries(options.settings.getModelRoles())) {
		if (!selector?.trim() || MODEL_ROLE_IDS.some(id => id === role)) continue;
		try {
			if (resolveRoleChain(role, options.settings, roleCandidatePool(role, options.settings, options.registry)).length > 0) {
				roles.set(role, selector);
			}
		} catch {
			// An unusable alias must not prevent another configured role from routing.
		}
	}
	return roles;
}

function usableAnswer(answer: ChoiceAnswer<string>, roles: readonly string[]): boolean {
	const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
	if (!roles.includes(answer.choice) || !valid(answer.confidence) || !roles.every(role => valid(answer.probabilities?.[role]))) return false;
	const probabilities = answer.probabilities;
	const total = roles.reduce((sum, role) => sum + probabilities[role], 0);
	return Math.abs(total - 1) <= 1e-3 &&
		roles.every(role => probabilities[role] <= probabilities[answer.choice]) &&
		probabilities[answer.choice] >= AUTO_TASK_MODEL_MIN_PROBABILITY &&
		answer.confidence >= AUTO_TASK_MODEL_MIN_PROBABILITY;
}

/**
 * Classify an omitted-model task. The caller must enforce explicit-model precedence.
 * Undefined preserves normal routing when the chosen role is not configured and usable.
 * Caller cancellation propagates; timeouts and judgment failures use the conservative role.
 */
export async function classifyAutoTaskModel(options: AutoTaskModelOptions): Promise<AutoTaskModelDecision | undefined> {
	options.signal?.throwIfAborted();
	let roles: Map<string, string>;
	try {
		roles = availableRoles(options);
	} catch {
		options.signal?.throwIfAborted();
		return undefined;
	}
	options.signal?.throwIfAborted();
	const fallback = (): AutoTaskModelDecision | undefined =>
		roles.has("sonnet") ? { role: "@sonnet", fallback: true } : undefined;
	try {
		if (!options.task.trim() || roles.size < 2 || !hasNativeJudge(options.settings, options.registry)) return fallback();
		const judge = resolveJudge({
			settings: options.settings,
			registry: options.registry,
			sessionModel: options.sessionModel,
			sessionId: options.sessionId,
			purpose: "auto-task-model",
			onUsage: options.onUsage,
			telemetry: options.telemetry,
			costGate: options.costGate,
			cache: sharedJudgmentCache(),
		});
		const timeout = AbortSignal.timeout(AUTO_TASK_MODEL_TIMEOUT_MS);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		const state: Record<string, string> = { task: truncateTinyMessage(options.task) };
		if (options.context) state.context = truncateTinyMessage(options.context);
		if (options.agent) state.agent = truncateTinyMessage(options.agent);
		const roleSelectors = JSON.stringify(Object.fromEntries(roles));
		// Never truncate the candidate map: the judge must see every offered role and its full selector.
		if (roleSelectors.length > MAX_TINY_MESSAGE_CHARS) return fallback();
		state.role_selectors = roleSelectors;
		const criteria: Record<string, string | null> = Object.create(null);
		for (const role of roles.keys()) {
			criteria[role] = Object.hasOwn(QUESTIONS.model.criteria, role)
				? QUESTIONS.model.criteria[role as keyof typeof QUESTIONS.model.criteria]
				: null;
		}
		const questions = { model: { ...QUESTIONS.model, criteria } };
		const { answers } = await judge.withCandidate((candidate, kind) => {
			if (kind !== "native") throw new Error("auto-task-model: native judge required");
			return candidate.judge({ state, questions }, { signal });
		}, { signal });
		options.signal?.throwIfAborted();
		const answer = answers.model;
		if (!usableAnswer(answer, [...roles.keys()])) return fallback();
		return { role: `@${answer.choice}`, fallback: false };
	} catch {
		options.signal?.throwIfAborted();
		return fallback();
	}
}
