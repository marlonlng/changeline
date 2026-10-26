export type Listener<T> = (e: T) => unknown;

export interface Disposable {
	dispose(): void;
}

export type Event<T> = (listener: Listener<T>) => Disposable;

export class Emitter<T> {
	private listeners = new Set<Listener<T>>();

	readonly event: Event<T> = (listener) => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	fire(e: T): void {
		for (const l of [...this.listeners]) {
			try {
				l(e);
			} catch (err) {
				console.error(err);
			}
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}
