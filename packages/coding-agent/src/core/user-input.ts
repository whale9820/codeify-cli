export interface UserInputQuestion {
	question: string;
	options?: string[];
}

export interface UserInputRequest {
	id: string;
	questions: UserInputQuestion[];
}

export class UserInputManager {
	private pending?: {
		request: UserInputRequest;
		resolve: (answers: string[]) => void;
	};

	getPending(): UserInputRequest | undefined {
		return this.pending?.request;
	}

	async request(
		request: UserInputRequest,
		signal: AbortSignal | undefined,
		notify: (request: UserInputRequest) => void,
	): Promise<string[]> {
		if (signal?.aborted) throw new Error("Question cancelled.");
		if (this.pending) throw new Error("Another question is already waiting for an answer.");
		return new Promise<string[]>((resolve, reject) => {
			const abort = () => {
				this.pending = undefined;
				signal?.removeEventListener("abort", abort);
				reject(new Error("Question cancelled. No answer was provided."));
			};
			this.pending = {
				request,
				resolve: (answers) => {
					this.pending = undefined;
					signal?.removeEventListener("abort", abort);
					resolve(answers);
				},
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				notify(request);
			} catch (error) {
				this.pending = undefined;
				signal?.removeEventListener("abort", abort);
				reject(error);
			}
		});
	}

	answer(id: string, answers: string[]): void {
		const pending = this.pending;
		if (!pending || pending.request.id !== id) throw new Error("Unknown or expired question request.");
		if (
			!Array.isArray(answers) ||
			answers.length !== pending.request.questions.length ||
			answers.some((answer) => typeof answer !== "string" || !answer.trim())
		) {
			throw new Error("Provide a nonempty answer for every question.");
		}
		pending.resolve(answers.map((answer) => answer.trim()));
	}
}
