import * as net from 'net';

const handle = process.env['CHANGELINE_ASKPASS_HANDLE'];
if (!handle) {
	process.exit(1);
}
const socket = net.connect(handle, () => {
	socket.write(JSON.stringify({ argv: process.argv.slice(2) }) + '\n');
});
let data = '';
socket.on('data', (d) => (data += d.toString('utf8')));
socket.on('end', () => {
	try {
		const msg = JSON.parse(data) as { answer?: string };
		if (msg.answer === undefined) {
			process.exit(1);
		}
		process.stdout.write(msg.answer + '\n');
		process.exit(0);
	} catch {
		process.exit(1);
	}
});
socket.on('error', () => process.exit(1));
