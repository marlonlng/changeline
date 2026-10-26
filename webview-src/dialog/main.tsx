import '../common/base.css';
import './style.css';
import { render } from 'preact';
import type { DialogSpec } from '../../src/shared/types';
import { DialogForm, DialogSubmitResult } from '../common/dialog';
import { call, initial } from '../common/rpc';

render(
	<DialogForm
		spec={initial as DialogSpec}
		active
		validate={(values, button) => call<Record<string, string>>('validate', { values, button })}
		submit={(values, button) => call<DialogSubmitResult>('submit', { values, button })}
	/>,
	document.getElementById('app')!,
);
