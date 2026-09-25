/* eslint-env browser */
const state = { view: 'tasks' };

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function display(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return escapeHtml(value);
}

function jsonText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return escapeHtml(JSON.stringify(value, null, 2));
}

function timeText(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const parsed = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : display(value);
}

async function fetchJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function setPanelError(element, error) {
  element.innerHTML = `<div class="viewer-error">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  document.querySelectorAll('[data-view-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== view;
  });
  if (view === 'tasks') {
    void loadTasks();
  }
  if (view === 'graph') {
    void loadGraph();
  }
}

function renderTasks(data) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  if (tasks.length === 0) {
    return '<div class="viewer-empty">No task rows.</div>';
  }
  return `<table class="viewer-table">
    <thead><tr><th>Title</th><th>Project</th><th>Stage</th><th>Assignee</th><th>Last event</th></tr></thead>
    <tbody>${tasks
      .map(
        (task) => `<tr>
          <td><button class="viewer-link-button" data-task-id="${escapeHtml(task.commitmentId)}">${display(task.title)}</button><div class="viewer-task-id">${display(task.commitmentId)}</div></td>
          <td>${display(task.project)}</td>
          <td>${display(task.stage)}</td>
          <td>${display(task.assignee)}</td>
          <td>${timeText(task.lastEventTime)}</td>
        </tr>`
      )
      .join('')}</tbody>
  </table>`;
}

async function loadTasks() {
  const content = document.getElementById('tasks-content');
  content.innerHTML = '<div class="viewer-loading">Loading tasks...</div>';
  try {
    content.innerHTML = renderTasks(await fetchJson('/api/viewer/tasks?limit=100'));
    content.querySelectorAll('[data-task-id]').forEach((button) => {
      button.addEventListener('click', () => void openTask(button.dataset.taskId));
    });
  } catch (error) {
    setPanelError(content, error);
  }
}

function renderEvidence(evidence) {
  return (Array.isArray(evidence) ? evidence : [])
    .map(
      (item) => `<details class="viewer-evidence">
        <summary>Citation ${display(item.observationRef)} · ${display(item.source)}</summary>
        <pre>${display(item.content)}</pre>
      </details>`
    )
    .join('');
}

function renderTaskDetail(task) {
  const revisions = Array.isArray(task.revisions) ? task.revisions : [];
  return revisions
    .map(
      (revision) => `<article class="viewer-revision">
        <div class="viewer-revision-header"><strong>Revision ${display(revision.revision)} · ${display(revision.operation)}</strong><span>${timeText(revision.eventTime)}</span></div>
        <h3>${display(revision.summary)}</h3>
        <p>${display(revision.reasoning)}</p>
        <ul class="viewer-detail-list">
          <li>Changed: <code>${jsonText(revision.change)}</code></li>
          <li>Cleared: <code>${jsonText(revision.clear)}</code></li>
          <li>Feedback: ${display(revision.feedback)}</li>
          <li>Roles: <code>${jsonText(revision.roles)}</code></li>
          <li>Files: <code>${jsonText(revision.files)}</code></li>
        </ul>
        ${renderEvidence(revision.evidence)}
      </article>`
    )
    .join('');
}

async function openTask(commitmentId) {
  const dialog = document.getElementById('task-dialog');
  const content = document.getElementById('task-dialog-content');
  const summary = document.getElementById('task-dialog-summary');
  content.innerHTML = '<div class="viewer-loading">Loading history...</div>';
  summary.textContent = commitmentId ?? '';
  dialog.showModal();
  try {
    const task = await fetchJson(`/api/viewer/tasks/${encodeURIComponent(commitmentId)}`);
    document.getElementById('task-dialog-title').textContent = task.title ?? 'Task history';
    summary.textContent = `${task.commitmentId} · ${task.project ?? ''} · ${task.stage ?? ''}`;
    content.innerHTML = renderTaskDetail(task);
  } catch (error) {
    setPanelError(content, error);
  }
}

function renderGraph(data) {
  const graph = data.graph ?? { nodes: [], edges: [] };
  const nodeHtml = (graph.nodes ?? [])
    .map(
      (node) => `<div class="viewer-node">
        <div class="viewer-node-kind">${display(node.ref?.kind)}</div>
        <div class="viewer-node-label">${display(node.label)}</div>
        <div class="viewer-muted">${display(node.ref?.id)}</div>
      </div>`
    )
    .join('');
  const edgeHtml = (graph.edges ?? [])
    .map(
      (edge) => `<div class="viewer-edge">
        <div class="viewer-edge-relation">${display(edge.relation)}</div>
        <div>${display(edge.from?.kind)}:${display(edge.from?.id)} → ${display(edge.to?.kind)}:${display(edge.to?.id)}</div>
      </div>`
    )
    .join('');
  document.getElementById('graph-content').innerHTML =
    `<div class="viewer-card"><h2 class="viewer-panel-title">Nodes</h2><div class="viewer-node-list">${nodeHtml || '<div class="viewer-empty">No graph nodes.</div>'}</div></div><div class="viewer-card"><h2 class="viewer-panel-title">Edges</h2><div class="viewer-edge-list">${edgeHtml || '<div class="viewer-empty">No graph edges.</div>'}</div></div>`;
  document.getElementById('graph-missing').innerHTML = (data.missing ?? [])
    .map(
      (item) =>
        `<div class="viewer-missing"><strong>${display(item.kind)}</strong><div>${display(item.message)}</div></div>`
    )
    .join('');
}

async function loadGraph() {
  const content = document.getElementById('graph-content');
  const kind = document.getElementById('graph-kind').value;
  content.innerHTML =
    '<div class="viewer-card"><div class="viewer-loading">Loading graph...</div></div>';
  try {
    const suffix = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    renderGraph(await fetchJson(`/api/viewer/graph${suffix}`));
  } catch (error) {
    setPanelError(content, error);
  }
}

function renderSearch(data) {
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    return '<div class="viewer-empty">No memory records.</div>';
  }
  return `<div class="viewer-search-results">${results
    .map(
      (item) => `<article class="viewer-search-result">
        <div class="viewer-search-topic">${display(item.topic)}</div>
        <div class="viewer-muted">${display(item.id)} · ${timeText(item.created_at)}</div>
        <div class="viewer-search-decision">${display(item.decision)}</div>
        <div class="viewer-muted">${display(item.reasoning)}</div>
      </article>`
    )
    .join('')}</div>`;
}

async function searchMemory(query) {
  const content = document.getElementById('memory-search-content');
  content.innerHTML = '<div class="viewer-loading">Searching memory...</div>';
  try {
    const suffix = query ? `?q=${encodeURIComponent(query)}&limit=50` : '?limit=50';
    content.innerHTML = renderSearch(await fetchJson(`/api/viewer/memory/search${suffix}`));
  } catch (error) {
    setPanelError(content, error);
  }
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});
document.getElementById('tasks-refresh').addEventListener('click', () => void loadTasks());
document.getElementById('graph-refresh').addEventListener('click', () => void loadGraph());
document.getElementById('graph-kind').addEventListener('change', () => void loadGraph());
document.getElementById('memory-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  searchMemory(document.getElementById('memory-query').value.trim());
});
document.getElementById('task-dialog-close').addEventListener('click', () => {
  document.getElementById('task-dialog').close();
});
document.getElementById('task-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    event.currentTarget.close();
  }
});
void loadTasks();
