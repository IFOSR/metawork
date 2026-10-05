import type { SettingsModelEntry } from '../settings-model';

export function ModelCapabilityDetails({ notes }: {
  notes: NonNullable<SettingsModelEntry['routingNotes']>;
}) {
  const sections = [
    ['具体优势', notes.strengths],
    ['适合的任务', notes.preferredTaskTypes],
    ['能力局限', notes.limitations],
    ['不适合的任务', notes.avoidTaskTypes],
  ] as const;
  const populated = sections.filter(([, items]) => items?.length);
  return (
    <section className="model-capability-details" aria-label="能力与适用范围">
      <strong>能力与适用范围</strong>
      {notes.summary && <p>{notes.summary}</p>}
      {!notes.summary && populated.length === 0 && (
        <p className="field-help">暂无详细能力说明，点击“获取模型信息”补充。</p>
      )}
      <dl>
        {populated.map(([title, items]) => (
          <div key={title}>
            <dt>{title}</dt>
            <dd><ul>{items!.map((item, index) => <li key={index}>{item}</li>)}</ul></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
