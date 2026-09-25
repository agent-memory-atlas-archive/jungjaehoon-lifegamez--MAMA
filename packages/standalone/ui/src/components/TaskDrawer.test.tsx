import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OperatorTask, OperatorTaskDetail } from '../api/client';
import TaskDrawer from './TaskDrawer';

const task: OperatorTask = {
  id: 7,
  commitment_id: 'commitment-1',
  title: 'work title',
  status: 'in_progress',
  priority: 'high',
  assignee: null,
  due_date: null,
  due_at: null,
  deadline_offset_minutes: null,
  revision: 2,
  temporal_epoch: 0,
  temporal_reconciled_occurrence_key: null,
  last_temporal_checked_at: null,
  next_temporal_check_at: null,
  last_temporal_attempt_id: null,
  temporal_state: 'unscheduled',
  source_channel: null,
  latest_event: null,
  auto_created: false,
  confirmed: true,
  created_at: 100,
  updated_at: 300,
};

const detail: OperatorTaskDetail = {
  commitmentId: 'commitment-1',
  rowId: 7,
  revision: 2,
  title: 'work title',
  project: null,
  stage: null,
  assignee: null,
  lastEventTime: 300,
  updatedAt: 300,
  createdAt: 100,
  withdrawn: false,
  revisions: [
    {
      revision: 1,
      operation: 'create',
      eventTime: 100,
      eventTimeSource: 'event',
      recordedAt: 101,
      summary: 'Created the work',
      reasoning: 'The source request requires this work.',
      change: { title: 'work title' },
      clear: [],
      feedback: null,
      roles: null,
      files: null,
      evidence: [
        {
          observationRef: 'observation-1',
          source: 'connector',
          channel: 'channel-1',
          sourceAt: 90,
          observedAt: 95,
          content: 'bounded source.read text',
        },
      ],
    },
    {
      revision: 2,
      operation: 'revise',
      eventTime: 300,
      eventTimeSource: 'event',
      recordedAt: 301,
      summary: 'Updated the work',
      reasoning: 'The owner feedback changed the next step.',
      change: { latestEvent: 'next step' },
      clear: [],
      feedback: 'owner feedback',
      roles: null,
      files: null,
      evidence: [],
    },
  ],
};

describe('TaskDrawer', () => {
  it('renders revision history and cited source observations in the existing drawer', () => {
    const html = renderToStaticMarkup(
      <TaskDrawer
        task={task}
        detail={detail}
        now={400}
        opener={null}
        fallbackFocusRef={{ current: null }}
        onDismiss={() => undefined}
      />
    );

    expect(html).toContain('History');
    expect(html).toContain('Created the work');
    expect(html).toContain('The source request requires this work.');
    expect(html).toContain('observation-1');
    expect(html).toContain('bounded source.read text');
    expect(html).toContain('channel-1');
  });
});
