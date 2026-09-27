/**
 * report.* action registrations — the §4.2 adapter seam. The slot store stays
 * outside core; the catalog reaches it through the injected ports. These tests
 * pin the contract (schema gate, late binding, failure codes) through the real
 * dispatcher — not the executor's tool names.
 */
import { describe, expect, it, vi } from 'vitest';
import { createCatalog, createDispatcher } from '@jungjaehoon/mama-core';
import { reportActionRegistrations, type ReportPorts } from '../../src/api/report-actions.js';
import { createReportPublisher, createReportStore } from '../../src/api/report-handler.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const timeZone = createTimeZoneSetting('UTC');

const access = {
  principalId: 'owner',
  agentId: 'agent',
  scopes: [],
  // Dispatch compares the call against this grant.
  actions: ['report.publish', 'report.read'],
};

function dispatch(ports: ReportPorts) {
  return createDispatcher(createCatalog(reportActionRegistrations(ports)));
}

describe('report.* action registrations', () => {
  it('lists exactly the two report actions with their schemas', () => {
    const catalog = createCatalog(reportActionRegistrations({ timeZone }));
    const names = catalog.list().map((contract) => contract.name);
    expect(names.sort()).toEqual(['report.publish', 'report.read']);
    const publish = catalog.describe('report.publish');
    expect(publish.inputSchema.required).toEqual(['slots']);
    expect(publish.summary).toContain('report-card');
    expect(publish.summary).not.toContain('basis');
    expect(publish.inputSchema.properties).not.toHaveProperty('basis_revision');
    expect(catalog.describe('report.read').summary).toContain('dated presentation snapshot');
  });

  it('rejects the removed basis_revision input', async () => {
    const call = dispatch({ publisher: vi.fn(), timeZone });
    const result = await call(
      {
        action: 'report.publish',
        input: { slots: { briefing: '<p>report</p>' }, basis_revision: 'unused' },
      },
      { access }
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'invalid_input' } });
  });

  it('report.read fails closed until routes init binds the reader port', async () => {
    const ports: ReportPorts = { timeZone };
    const call = dispatch(ports);
    const early = await call({ action: 'report.read', input: {} }, { access });
    expect(early).toMatchObject({
      status: 'failed',
      error: { code: 'board_unavailable' },
    });

    // Late binding: filling the same holder makes the action serve — no
    // catalog rebuild, exactly like boot wiring.
    ports.reader = () => ({
      briefing: { html: '<p>b</p>', updatedAt: '2026-09-17T00:00:00.000Z' },
    });
    const later = await call({ action: 'report.read', input: {} }, { access });
    expect(later).toMatchObject({
      status: 'completed',
      data: { success: true, slots: [{ name: 'briefing' }] },
    });
  });

  it('report.publish writes through the injected store and reports accepted/changed', async () => {
    const store = createReportStore();
    const ports: ReportPorts = {
      publisher: createReportPublisher(store, new Set()),
      timeZone,
    };
    const call = dispatch(ports);

    const first = await call(
      {
        action: 'report.publish',
        input: { slots: { briefing: '<div class="report-card">v1</div>' } },
      },
      { access }
    );
    expect(first).toMatchObject({
      status: 'completed',
      data: { success: true, acceptedSlotIds: ['briefing'], changedSlotIds: ['briefing'] },
    });
    expect(store.get('briefing')?.html).toBe('<div class="report-card">v1</div>');

    const same = await call(
      {
        action: 'report.publish',
        input: { slots: { briefing: '<div class="report-card">v1</div>' } },
      },
      { access }
    );
    expect(same).toMatchObject({
      status: 'completed',
      data: { acceptedSlotIds: ['briefing'], changedSlotIds: [] },
    });
  });

  it('treats identical slot HTML as unchanged and exposes no analysis basis', async () => {
    const html = '<div class="report-card">Changed</div>';
    const store = createReportStore({
      initialSlots: {
        decisions: {
          slotId: 'decisions',
          html,
          priority: 0,
          updatedAt: Date.now(),
        },
      },
    });
    const call = dispatch({ publisher: createReportPublisher(store, new Set()), timeZone });
    const result = await call(
      { action: 'report.publish', input: { slots: { decisions: html } } },
      { access }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { acceptedSlotIds: ['decisions'], changedSlotIds: [] },
    });
    expect(store.get('decisions')).toMatchObject({ html });
    expect(store.get('decisions')).not.toHaveProperty('basisRevision');
  });

  it('report.publish rejects non-string slot values and keeps the code', async () => {
    const publisher = vi.fn();
    const call = dispatch({ publisher, timeZone });
    const result = await call(
      { action: 'report.publish', input: { slots: { briefing: 42 } } },
      { access }
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_slots' },
    });
    expect(publisher).not.toHaveBeenCalled();
  });

  it('report.publish reports the unbound publisher port instead of a silent noop', async () => {
    const call = dispatch({ timeZone });
    const result = await call(
      { action: 'report.publish', input: { slots: { briefing: '<p>x</p>' } } },
      { access }
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'publisher_unavailable', message: 'Report publisher not configured' },
    });
  });

  it('publishes the agent-authored pipeline with the other board slots', async () => {
    const onChange = vi.fn();
    const store = createReportStore({ onChange });
    store.update('briefing', '<div class="report-card">old</div>', 0);
    onChange.mockClear();
    const call = dispatch({ publisher: createReportPublisher(store, new Set()), timeZone });

    const result = await call(
      {
        action: 'report.publish',
        input: {
          slots: {
            briefing: '<div class="report-card">new</div>',
            pipeline: '<div class="report-table">current</div>',
          },
        },
      },
      { access }
    );

    expect(result).toMatchObject({
      status: 'completed',
      data: { acceptedSlotIds: ['briefing', 'pipeline'], changedSlotIds: ['briefing', 'pipeline'] },
    });
    expect(store.get('pipeline')?.html).toBe('<div class="report-table">current</div>');
    expect(onChange).toHaveBeenCalled();
  });
});
