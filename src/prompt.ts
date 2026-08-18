/**
 * `/sandbox prompt [id] <text>`. An explicit id always wins. Bare `prompt 2`
 * with no text is rejected so a mistyped switch is not sent as a prompt.
 * A missing id is the only session, not "this" session.
 */
export function parsePromptArgs(
	args: string,
): { id?: number; text: string } | undefined {
	const trimmed = args.trim();
	if (!trimmed.startsWith("prompt")) return undefined;
	const rest = trimmed.slice("prompt".length).trim();
	if (!rest) return undefined;
	const numbered = /^(\d+)\s+(\S[\s\S]*)$/.exec(rest);
	if (numbered) return { id: Number(numbered[1]), text: numbered[2] };
	if (/^\d+$/.test(rest)) return undefined;
	return { text: rest };
}

export function resolvePromptTarget(
	requested: number | undefined,
	sessions: readonly { id: number }[],
): number {
	if (requested !== undefined) {
		if (!sessions.some((session) => session.id === requested))
			throw new Error(`unknown sandbox session #${requested}`);
		return requested;
	}
	if (sessions.length === 1) return sessions[0]!.id;
	if (sessions.length === 0) throw new Error("no sandbox sessions to prompt");
	throw new Error(
		`this sandbox has ${sessions.length} sessions; say /sandbox prompt <id> <text>`,
	);
}
