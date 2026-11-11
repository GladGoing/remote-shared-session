import { pluginSettings } from '../runtime/plugin-settings.mjs';
import { Bridge } from '../runtime/bridge.mjs';
import { HandoffReceiver } from '../runtime/handoffs.mjs';

// Hooks are advisory: missing login, offline services and old hosts do not block a chat.
const deadline = setTimeout(() => process.exit(0), 10000); deadline.unref();
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk; if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('hook_input_too_large');
  }
  const event = JSON.parse(input);
  const settings = await pluginSettings();
  const bridge = new Bridge({ ...settings, readerOptions: { binary: process.env.SHARED_CODEX_BINARY || 'codex',
    args: JSON.parse(process.env.SHARED_CODEX_ARGS || '[]') } });
  const receiver = new HandoffReceiver(bridge, { defaultEnabled: settings.chatNotifications, mode: settings.receiveMode, workspace: settings.workspace });
  await receiver.check(event, value => new Promise((ok, fail) => {
    process.stdout.write(JSON.stringify(value) + '\n', error => error ? fail(error) : ok());
  }));
} catch { /* no content, credentials, prompts or errors are written to hook output */ }
finally { clearTimeout(deadline); }
