import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatLastUserMessage } from '../../src/runtime/native-turn.js';

describe('TG-02/TG-03 native image evidence', () => {
  it('states the available image path without forcing one tool or a tool order', () => {
    const text = formatLastUserMessage(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare these files' },
            { type: 'image', localPath: '/private/workspace/media/page.png' } as never,
          ],
        },
      ],
      {}
    );

    expect(text).toContain('Compare these files');
    expect(text).toContain('/private/workspace/media/page.png');
    expect(text).not.toContain('MUST call');
    expect(text).not.toContain('view_image tool');
  });

  it('materializes a received base64 image as data without a mandatory reader call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-native-media-'));
    try {
      const text = formatLastUserMessage(
        [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
              },
            ],
          },
        ],
        { mediaDir: dir }
      );
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(text).toContain(join(dir, files[0]));
      expect(text).not.toContain('MUST call');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
