export interface ConversationTurn {
  taskId: string;
  userInput: string;
  systemOutput: string;
  createdAt: string;
  source: 'task' | 'session' | 'timeline' | 'keyword' | 'llm';
}
