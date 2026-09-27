import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { daemonStatus, requestDaemonStop } from '../../src/cli/commands/daemon.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

function launchctl(status: number, stdout = '') {
  vi.mocked(spawnSync).mockReturnValue({
    status,
    stdout,
    stderr: '',
    signal: null,
    pid: 1,
    output: [null, stdout, ''],
  });
}

describe('launchd daemon control', () => {
  it('gets running status from the current user launchd service without a pid file', () => {
    launchctl(0, 'service = {\n state = running\n pid = 123\n}');
    expect(daemonStatus()).toBe('running');
    expect(spawnSync).toHaveBeenLastCalledWith(
      'launchctl',
      ['print', `gui/${process.getuid!()}/com.mama.server`],
      { encoding: 'utf8' }
    );
  });

  it('reports loaded non-running and absent services as stopped', () => {
    launchctl(0, 'service = {\n state = waiting\n}');
    expect(daemonStatus()).toBe('stopped');
    launchctl(113);
    expect(daemonStatus()).toBe('stopped');
  });

  it('unloads the launchd service so KeepAlive cannot restart it', () => {
    launchctl(0);
    requestDaemonStop();
    expect(spawnSync).toHaveBeenLastCalledWith(
      'launchctl',
      ['bootout', `gui/${process.getuid!()}/com.mama.server`],
      { encoding: 'utf8' }
    );
  });

  it('surfaces unavailable launchctl and service-control failures', () => {
    const unavailable = Object.assign(new Error('fixture unavailable'), { code: 'ENOENT' });
    vi.mocked(spawnSync).mockReturnValue({ error: unavailable } as never);
    expect(() => daemonStatus()).toThrow(unavailable);
    launchctl(5);
    expect(() => daemonStatus()).toThrow('launchctl print failed');
    expect(() => requestDaemonStop()).toThrow('launchctl bootout failed');
  });
});
