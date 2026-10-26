import './dialog.css';
import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { overlayFits, OVERLAY_PADDING } from '../../src/shared/dialogs';
import type { DialogField, DialogSpec, DialogValues } from '../../src/shared/types';
import { Checkbox } from './components';
import { t } from './l10n';
import { call, on, send } from './rpc';

export interface DialogSubmitResult {
	ok?: boolean;
	errors?: Record<string, string>;
}

interface DialogFormProps {
	spec: DialogSpec;
	active: boolean;
	validate(values: DialogValues, button: string): Promise<Record<string, string>>;
	submit(values: DialogValues, button: string): Promise<DialogSubmitResult | undefined>;
}

function defaults(spec: DialogSpec): DialogValues {
	const v: DialogValues = {};
	for (const f of spec.fields) {
		if (f.type === 'label') {
			continue;
		}
		if (f.type === 'checkbox') {
			v[f.id] = f.value === true;
		} else if (f.type === 'checklist') {
			v[f.id] = Array.isArray(f.value) ? f.value : (f.options ?? []).map((o) => o.value);
		} else {
			v[f.id] = (f.value as string) ?? (f.type === 'select' || f.type === 'radio' ? f.options?.[0]?.value ?? '' : '');
		}
	}
	return v;
}

/** The form of a dialog: fields, local and remote validation, Escape / Enter, buttons. */
export function DialogForm({ spec, active, validate, submit: send }: DialogFormProps) {
	const [values, setValues] = useState<DialogValues>(defaults(spec));
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const root = useRef<HTMLDivElement | null>(null);
	const firstInput = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!active) {
			return;
		}
		setTimeout(() => {
			const focus = root.current?.querySelector('[data-focus="1"]') as HTMLElement | null;
			(focus ?? firstInput.current)?.focus();
			if (focus instanceof HTMLInputElement) {
				focus.select();
			}
		}, 50);
	}, [active]);

	const localErrors = (v: DialogValues) => {
		const e: Record<string, string> = {};
		for (const f of spec.fields) {
			if (!visible(f, v)) {
				continue;
			}
			const val = v[f.id];
			if (f.required && (val === '' || val === undefined || (Array.isArray(val) && !val.length))) {
				e[f.id] = t('{0} is required', (f.label ?? t('Value')).replace(/:$/, ''));
			} else if (f.pattern && typeof val === 'string' && val && !new RegExp(f.pattern).test(val)) {
				e[f.id] = f.patternMessage ?? t('Invalid value');
			}
		}
		return e;
	};

	const set = (id: string, value: string | boolean | string[]) => {
		const next = { ...values, [id]: value };
		setValues(next);
		const local = localErrors(next);
		if (spec.liveValidation) {
			validate(next, 'ok').then((remote) => setErrors({ ...local, ...remote }));
		} else {
			setErrors(Object.fromEntries(Object.entries(errors).filter(([k]) => k !== id).concat(Object.entries(local).filter(([k]) => k === id))));
		}
	};

	const submit = async (button: string) => {
		if (button !== 'cancel') {
			const local = localErrors(values);
			if (Object.keys(local).length) {
				setErrors(local);
				return;
			}
		}
		setBusy(true);
		try {
			const res = await send(values, button);
			if (res?.errors) {
				setErrors(res.errors);
			}
		} finally {
			setBusy(false);
		}
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			void submit('cancel');
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !(e.target instanceof HTMLTextAreaElement))) {
			if (e.target instanceof HTMLButtonElement) {
				return;
			}
			e.preventDefault();
			void submit('ok');
		}
	};

	const hasErrors = Object.keys(errors).length > 0;

	return (
		<div class="jg-dialog" ref={root} role="dialog" aria-label={spec.title} onKeyDown={onKeyDown as any} style={{ maxWidth: `${spec.width ?? 620}px` }}>
			<h2>{spec.title}</h2>
			{spec.description && <p class="description">{spec.description}</p>}
			<div class="fields">
				{spec.fields.map((f) => {
					if (!visible(f, values)) {
						return null;
					}
					const err = errors[f.id];
					const refFirst = (el: HTMLElement | null) => {
						if (el && !firstInput.current) {
							firstInput.current = el;
						}
					};
					switch (f.type) {
						case 'label':
							return <div class={`label-field${f.monospace ? ' jg-code' : ''}`}>{f.label}</div>;
						case 'checkbox':
							return (
								<div class="field check">
									<Checkbox checked={values[f.id] === true} onChange={(v) => set(f.id, v)} label={f.label} />
									{f.description && <div class="hint">{f.description}</div>}
								</div>
							);
						case 'radio':
							return (
								<div class="field">
									{f.label && <div class="field-label">{f.label}</div>}
									<div class="radios">
										{(f.options ?? []).map((o) => (
											<label class="radio">
												<input type="radio" name={f.id} checked={values[f.id] === o.value} onChange={() => set(f.id, o.value)} />
												<span>
													<strong>{o.label}</strong>
													{o.description && <span class="hint"> {o.description}</span>}
												</span>
											</label>
										))}
									</div>
								</div>
							);
						case 'select':
							return (
								<div class="field row">
									{f.label && <label class="field-label">{f.label}</label>}
									<select ref={refFirst as any} data-focus={f.focus ? '1' : undefined} value={values[f.id] as string} onChange={(e) => set(f.id, (e.target as HTMLSelectElement).value)}>
										{(f.options ?? []).map((o) => (
											<option value={o.value}>{o.label}</option>
										))}
									</select>
									{f.description && <div class="hint">{f.description}</div>}
								</div>
							);
						case 'checklist': {
							const sel = new Set(values[f.id] as string[]);
							const all = (f.options ?? []).map((o) => o.value);
							return (
								<div class="field">
									{f.label && (
										<div class="field-label checklist-head">
											<Checkbox
												checked={sel.size === all.length}
												indeterminate={sel.size > 0 && sel.size < all.length}
												onChange={(v) => set(f.id, v ? all : [])}
												label={f.label}
											/>
										</div>
									)}
									<div class="checklist">
										{(f.options ?? []).map((o) => (
											<div class="jg-row">
												<Checkbox
													checked={sel.has(o.value)}
													onChange={(v) => {
														const n = new Set(sel);
														if (v) {
															n.add(o.value);
														} else {
															n.delete(o.value);
														}
														set(f.id, all.filter((x) => n.has(x)));
													}}
													label={
														<span>
															{o.label} {o.description && <span class="jg-muted">{o.description}</span>}
														</span>
													}
												/>
											</div>
										))}
									</div>
									{err && <div class="error">{err}</div>}
								</div>
							);
						}
						case 'textarea':
							return (
								<div class="field">
									{f.label && <label class="field-label">{f.label}</label>}
									<textarea
										ref={refFirst as any}
										data-focus={f.focus ? '1' : undefined}
										class={f.monospace ? 'jg-code' : ''}
										rows={f.rows ?? 6}
										placeholder={f.placeholder}
										value={values[f.id] as string}
										onInput={(e) => set(f.id, (e.target as HTMLTextAreaElement).value)}
									/>
									{f.description && <div class="hint">{f.description}</div>}
									{err && <div class="error">{err}</div>}
								</div>
							);
						default:
							return (
								<div class="field row">
									{f.label && <label class="field-label">{f.label}</label>}
									<input
										ref={refFirst as any}
										data-focus={f.focus ? '1' : undefined}
										type="text"
										class={`${f.monospace ? 'jg-code' : ''}${err ? ' invalid' : ''}`}
										placeholder={f.placeholder}
										value={values[f.id] as string}
										list={f.type === 'combo' ? `dl-${f.id}` : undefined}
										onInput={(e) => set(f.id, (e.target as HTMLInputElement).value)}
									/>
									{f.type === 'combo' && (
										<datalist id={`dl-${f.id}`}>
											{(f.options ?? []).map((o) => (
												<option value={o.value}>{o.label !== o.value ? o.label : undefined}</option>
											))}
										</datalist>
									)}
									{f.description && <div class="hint">{f.description}</div>}
									{err && <div class="error">{err}</div>}
								</div>
							);
					}
				})}
			</div>
			<div class="buttons">
				{(spec.extraButtons ?? []).map((b) => (
					<button class="jg-btn" disabled={busy} onClick={() => submit(b.id)}>
						{b.label}
					</button>
				))}
				<span class="spacer" />
				<button class="jg-btn" disabled={busy} onClick={() => submit('cancel')}>
					{spec.cancelLabel ?? t('Cancel')}
				</button>
				<button class="jg-btn primary" disabled={busy || hasErrors} onClick={() => submit('ok')}>
					{spec.okLabel ?? t('OK')}
				</button>
			</div>
		</div>
	);
}

function visible(f: DialogField, v: DialogValues): boolean {
	if (!f.visibleWhen) {
		return true;
	}
	const neg = f.visibleWhen.startsWith('!');
	const key = neg ? f.visibleWhen.slice(1) : f.visibleWhen;
	const [id, expected] = key.split('=');
	const val = v[id];
	const on = expected !== undefined ? val === expected : val === true;
	return neg ? !on : on;
}

interface OpenOverlay {
	id: number;
	spec: DialogSpec;
}

/** Dialogs the extension opens in this webview: a modal overlay that first checks that it fits. */
function DialogLayer() {
	const [open, setOpen] = useState<OpenOverlay | undefined>();
	const [shown, setShown] = useState(false);
	const layer = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const offOpen = on<OpenOverlay>('dialog.open', (d) => {
			setShown(false);
			setOpen(d);
		});
		const offClose = on<{ id: number }>('dialog.close', (d) => setOpen((o) => (o?.id === d.id ? undefined : o)));
		return () => {
			offOpen();
			offClose();
		};
	}, []);

	useLayoutEffect(() => {
		if (!open || shown) {
			return;
		}
		const box = layer.current?.querySelector('.jg-dialog') as HTMLElement | null;
		const fits = !!box && overlayFits({ width: window.innerWidth, height: window.innerHeight }, box.offsetHeight);
		void call('dialog.shown', { id: open.id, fits });
		if (fits) {
			setShown(true);
		} else {
			setOpen(undefined);
		}
	}, [open, shown]);

	if (!open) {
		return null;
	}
	const id = open.id;
	return (
		<div class={`jg-dialog-overlay${shown ? '' : ' measuring'}`} ref={layer} style={{ padding: `${OVERLAY_PADDING}px` }} onKeyDown={(e) => e.stopPropagation()}>
			<DialogForm
				key={id}
				spec={open.spec}
				active={shown}
				validate={(values, button) => call<Record<string, string>>('dialog.validate', { id, values, button })}
				submit={(values, button) => call<DialogSubmitResult>('dialog.submit', { id, values, button })}
			/>
		</div>
	);
}

/** Lets the extension show dialogs as an overlay in this webview. */
export function mountDialogLayer(): void {
	const container = document.createElement('div');
	document.body.appendChild(container);
	render(<DialogLayer />, container);
	send('dialog.ready');
}
