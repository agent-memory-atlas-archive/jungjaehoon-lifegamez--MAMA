import { homedir } from 'node:os';
import { CliInputError, createTerminalPrompt, requireTTY, type PromptAdapter } from '../prompt.js';
import { listSecrets, secretName, updateSecrets } from '../secrets.js';

export async function runSecret(
  args: string[],
  options: { home?: string; prompt?: PromptAdapter } = {}
): Promise<void> {
  const home = options.home ?? homedir();
  const prompt = options.prompt ?? createTerminalPrompt();
  if (args[0] === 'list' && args.length === 1) {
    for (const name of listSecrets(home)) prompt.write(name);
    return;
  }
  if (args[0] !== 'set' || args.length !== 2) {
    throw new CliInputError('Usage: mama secret set <NAME> | mama secret list');
  }
  requireTTY(prompt);
  const name = secretName(args[1]);
  const value = await prompt.secret(name);
  updateSecrets(home, { [name]: value });
  prompt.write(`Updated ${name}. Restart the daemon to use the new value.`);
}
