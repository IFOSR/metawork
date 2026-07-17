// Compatibility export for source consumers while ownership lives in work-graph.
export {
  validateWorkGraph as validateWorkGraphStructure,
  type WorkGraphViolation,
  type WorkGraphViolationCode,
} from '../work-graph/index.js';
