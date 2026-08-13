export class MockPageDriver {
  constructor() {
    this.roundIndex = new Map();
  }

  async createTaskProject({ task }) {
    const session = task.mock_session ?? { projectName: task.project_id, sessionId: 'mock-session-1' };
    this.roundIndex.set(task.task_id, 0);
    return structuredClone(session);
  }

  async initializeTask({ task }) {
    return structuredClone(task.mock_initialization ?? { contextLimit: false, assistantText: 'initialized' });
  }

  async runRound({ task }) {
    const rounds = task.mock_rounds ?? [{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }];
    const index = this.roundIndex.get(task.task_id) ?? 0;
    const round = rounds[index] ?? { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    this.roundIndex.set(task.task_id, index + 1);
    return structuredClone(round);
  }

  async deleteTaskProject() {
    return { ok: true };
  }
}
