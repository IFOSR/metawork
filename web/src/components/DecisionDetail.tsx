interface DecisionDetailProps {
  decision: {
    type: string;
    subtask: string;
    reason: string;
  };
}

export function DecisionDetail({ decision }: DecisionDetailProps) {
  return (
    <details className="decision-detail">
      <summary>
        <span className="decision-type">{decision.type}</span>
        <span className="decision-subtask">{decision.subtask}</span>
      </summary>
      <div className="decision-reason">{decision.reason}</div>
    </details>
  );
}
