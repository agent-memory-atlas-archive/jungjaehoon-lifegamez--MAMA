const { formatRestart } = require('../mama/response-formatter');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * BMad Workflow Integration Helpers
 * Connects checkpoints to Story files for continuity tracking
 */

/**
 * Find all Story files in the BMad workspace
 * @returns {Array<{path: string, name: string}>}
 */
function findStoryFiles() {
  // Try multiple paths (MCP server may be run from packages/mcp-server or project root)
  const possiblePaths = [
    path.join(process.cwd(), '.docs', 'sprint-artifacts'),
    path.join(process.cwd(), '..', '..', '.docs', 'sprint-artifacts'), // From packages/mcp-server
    path.join(os.homedir(), 'MAMA', '.docs', 'sprint-artifacts'), // Fallback absolute
  ];

  let sprintArtifactsDir = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      sprintArtifactsDir = p;
      break;
    }
  }

  if (!sprintArtifactsDir) {
    return [];
  }

  try {
    const files = fs
      .readdirSync(sprintArtifactsDir)
      .filter(
        (f) =>
          f.match(/^\d+-\d+-.*\.md$/) &&
          !f.includes('UPDATE') &&
          !f.includes('COMPLETION') &&
          !f.startsWith('tech-spec')
      )
      .map((f) => ({
        path: path.join(sprintArtifactsDir, f),
        name: f
          .replace(/\.md$/, '')
          .replace(/^\d+-\d+-/, '')
          .replace(/-/g, ' '),
      }));
    return files;
  } catch (err) {
    return [];
  }
}

/**
 * Parse Story file to extract status and tasks
 * @param {string} filePath - Path to Story markdown file
 * @returns {Object} {status: string, tasks: Array<{done: boolean, text: string}>}
 */
function parseStoryFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    // Extract status
    const statusLine = lines.find((l) => l.startsWith('Status:'));
    const status = statusLine ? statusLine.replace('Status:', '').trim() : 'Unknown';

    // Extract tasks
    const tasks = [];
    for (const line of lines) {
      const taskMatch = line.match(/^- \[([ x])\] (.+)$/);
      if (taskMatch) {
        tasks.push({
          done: taskMatch[1] === 'x',
          text: taskMatch[2],
        });
      }
    }

    return {
      status,
      tasks,
      totalTasks: tasks.length,
      completedTasks: tasks.filter((t) => t.done).length,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Infer current Story from checkpoint summary
 * @param {string} summary - Checkpoint summary text
 * @returns {Object|null} Story info or null
 */
function inferCurrentStory(summary) {
  const stories = findStoryFiles();
  if (stories.length === 0) {
    return null;
  }

  // Look for Story mentions in summary (e.g., "Story 2.1", "Epic 2")
  const storyMatch = summary.match(/Story\s+(\d+\.\d+)/i) || summary.match(/Epic\s+(\d+)/i);
  if (storyMatch) {
    const storyNum = storyMatch[1];
    const story = stories.find(
      (s) => s.name.includes(storyNum) || s.path.includes(storyNum.replace('.', '-'))
    );
    if (story) {
      return { ...story, details: parseStoryFile(story.path) };
    }
  }

  // Fallback: find In Progress stories
  for (const story of stories) {
    const details = parseStoryFile(story.path);
    if (details && details.status === 'In Progress') {
      return { ...story, details };
    }
  }

  return null;
}

const createSaveCheckpointTool = ({ call }) => ({
  name: 'save_checkpoint',
  description: `Save the current session state (checkpoint) to MAMA memory.

Required format (be honest, include unfinished work):
1) 🎯 Goal & Progress: What was the goal and how far did you get? If unfinished, note where/why you stopped.
2) ✅ Evidence: Files/logs/commands + status [Verified | Not run | Assumed].
3) ⏳ Unfinished & Risks: Remaining work, unrun tests, risks/unknowns.

For next_steps:
4) 🚦 Next Agent Briefing: Next session Definition of Done and quick health/start commands.

Before saving: scan for TODOs or missing tests and state them plainly.`,
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          '1) Goal & Progress 2) Evidence (paths/logs/commands + status [Verified|Not run|Assumed]) 3) Unfinished & Risks (remaining work/unknowns/missing tests). Be explicit about unfinished or assumed items; check for TODOs/missing tests before saving.',
      },
      open_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of currently relevant or open files.',
      },
      next_steps: {
        type: 'string',
        description:
          '4) Next Agent Briefing: Next session Definition of Done and quick commands to run (e.g., npm test, curl ...). Describe the target state, not just a task list.',
      },
    },
    required: ['summary'],
  },
  handler: async (args) => {
    const { summary, open_files, next_steps } = args;

    // BMad Workflow Integration: Check Story status before saving
    const currentStory = inferCurrentStory(summary);
    let bmadWorkflowWarning = '';

    if (currentStory && currentStory.details) {
      const { status, completedTasks, totalTasks, tasks } = currentStory.details;
      const progress = totalTasks > 0 ? `${completedTasks}/${totalTasks}` : '0/0';

      bmadWorkflowWarning =
        `\n\n📋 BMad Workflow Status:\n` +
        `- Story: ${currentStory.name}\n` +
        `- Status: ${status}\n` +
        `- Tasks: ${progress} completed\n`;

      // Warn if tasks are not updated (for In Progress or drafted stories)
      if (
        (status === 'In Progress' || status === 'drafted') &&
        completedTasks === 0 &&
        totalTasks > 0
      ) {
        bmadWorkflowWarning += `\n⚠️ Tasks not updated:\n`;
        tasks.slice(0, 3).forEach((t) => {
          bmadWorkflowWarning += `  - [ ] ${t.text}\n`;
        });
        if (tasks.length > 3) {
          bmadWorkflowWarning += `  ... and ${tasks.length - 3} more\n`;
        }
        bmadWorkflowWarning += `\n💡 Remember to:\n`;
        bmadWorkflowWarning += `  1. Update Story file: ${currentStory.path}\n`;
        bmadWorkflowWarning += `  2. Check tasks [x] for completed work\n`;
        bmadWorkflowWarning += `  3. Update Status if Story is complete\n`;
      }

      // Warn if status should be updated
      if (
        completedTasks === totalTasks &&
        totalTasks > 0 &&
        status !== 'Completed' &&
        status !== 'Review'
      ) {
        bmadWorkflowWarning += `\n✅ All tasks complete! Consider updating Status to "Completed" or "Review"\n`;
      }
    }

    const saved = await call('memory.checkpoint.save', {
      summary,
      ...(open_files && { open_files }),
      ...(next_steps && { next_steps }),
    });
    const id = saved?.id;
    return {
      content: [
        {
          type: 'text',
          text: `✅ Checkpoint saved (ID: ${id})\nSummary: ${summary}${bmadWorkflowWarning}`,
        },
      ],
    };
  },
});

const createLoadCheckpointTool = ({ call }) => ({
  name: 'load_checkpoint',
  description:
    'Load the latest active session checkpoint with narrative and links. Use this at the start of a new session to resume work seamlessly.',
  inputSchema: {
    type: 'object',
    properties: {
      include_narrative: {
        type: 'boolean',
        description: 'Include related narrative/decisions (default: true)',
        default: true,
      },
      include_links: {
        type: 'boolean',
        description: 'Include approved links (default: true)',
        default: true,
      },
      link_depth: {
        type: 'number',
        description: 'Link expansion depth (default: 1)',
        default: 1,
      },
    },
  },
  handler: async (args = {}) => {
    const start = Date.now();
    const { include_narrative = true, include_links = true, link_depth = 1 } = args;

    const checkpoint = await call('memory.checkpoint.load', {});

    if (!checkpoint) {
      const end = Date.now();
      const durationMs = end - start;

      return {
        content: [
          {
            type: 'text',
            text:
              `ℹ️ No active checkpoint found.\n\n` +
              `⏱️ load_checkpoint: start ${new Date(start).toISOString()}, end ${new Date(end).toISOString()}, duration ${durationMs}ms`,
          },
        ],
      };
    }

    // Load related narrative if requested
    let narrative = [];
    if (include_narrative) {
      // Search for decisions around checkpoint time (1 hour window)
      const timeWindow = 3600000; // 1 hour in ms
      const checkpointTime = checkpoint.timestamp;

      // Use checkpoint summary as query for semantic search
      try {
        const searchResult = await call('memory.search', {
          query: checkpoint.summary,
          limit: 5,
          threshold: 0.7,
        });
        const searchResults = Array.isArray(searchResult?.results) ? searchResult.results : [];
        narrative = searchResults.filter((d) => {
          // Filter decisions within time window of checkpoint
          const decisionTime = new Date(d.created_at).getTime();
          return Math.abs(decisionTime - checkpointTime) < timeWindow;
        });
      } catch (error) {
        console.error('[loadCheckpoint] Failed to load narrative:', error.message);
        // Continue without narrative
      }
    }

    // Expand links if requested — twin-edge neighbors stand in for the old
    // decision_edges expansion; the response keeps the legacy link shape.
    let links = [];
    if (include_links && narrative.length > 0) {
      try {
        const allLinks = [];
        for (const decision of narrative) {
          const page = await call('graph.query', {
            view: 'neighbors',
            seeds: [{ kind: 'memory', id: decision.id }],
            maxDepth: link_depth,
            history: 'all',
          });
          for (const edge of page?.edges ?? []) {
            allLinks.push({
              from_id: edge.from?.id,
              to_id: edge.to?.id,
              relationship: edge.relation,
              direction: edge.from?.id === decision.id ? 'outgoing' : 'incoming',
              depth: 1,
            });
          }
        }

        // Deduplicate links
        const linkMap = new Map();
        allLinks.forEach((link) => {
          const key = `${link.from_id}-${link.to_id}-${link.relationship}`;
          if (!linkMap.has(key)) {
            linkMap.set(key, link);
          }
        });
        links = Array.from(linkMap.values());
      } catch (error) {
        console.error('[loadCheckpoint] Failed to expand links:', error.message);
        // Continue without links
      }
    }

    // Format response using response-formatter
    const formattedResponse = formatRestart(checkpoint, narrative, links);

    // BMad Workflow Integration: Add Story context
    const currentStory = include_narrative ? inferCurrentStory(checkpoint.summary) : null;
    let bmadWorkflowContext = '';

    if (currentStory && currentStory.details) {
      const { status, completedTasks, totalTasks, tasks } = currentStory.details;
      const progress = totalTasks > 0 ? `${completedTasks}/${totalTasks}` : '0/0';
      const remainingTasks = tasks.filter((t) => !t.done);

      bmadWorkflowContext =
        `\n\n📋 BMad Workflow Context:\n` +
        `- Story: ${currentStory.name}\n` +
        `- File: ${currentStory.path}\n` +
        `- Status: ${status}\n` +
        `- Progress: ${progress} tasks completed\n`;

      if (remainingTasks.length > 0) {
        bmadWorkflowContext += `\n🎯 Remaining Tasks:\n`;
        remainingTasks.slice(0, 5).forEach((t, i) => {
          bmadWorkflowContext += `  ${i + 1}. [ ] ${t.text}\n`;
        });
        if (remainingTasks.length > 5) {
          bmadWorkflowContext += `  ... and ${remainingTasks.length - 5} more\n`;
        }
      } else if (totalTasks > 0) {
        bmadWorkflowContext += `\n✅ All tasks completed! Consider updating Story status.\n`;
      }
    }

    const end = Date.now();
    const durationMs = end - start;

    return {
      content: [
        {
          type: 'text',
          text:
            `🔄 Resuming Session (from ${new Date(checkpoint.timestamp).toLocaleString()})\n\n` +
            `${JSON.stringify(formattedResponse, null, 2)}\n` +
            `${bmadWorkflowContext}\n\n` +
            `⏱️ load_checkpoint: duration ${durationMs}ms (p95 target: <2500ms)`,
        },
      ],
    };
  },
});

module.exports = {
  createSaveCheckpointTool,
  createLoadCheckpointTool,
};
