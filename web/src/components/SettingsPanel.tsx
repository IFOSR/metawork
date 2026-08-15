import type { HttpClient } from '../api/http';

interface SettingsPanelProps {
  http: HttpClient | null;
  onClose: () => void;
}

export function SettingsPanel({ http, onClose }: SettingsPanelProps) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={event => event.stopPropagation()}>
        <div className="drawer-header">
          <span className="drawer-title">设置</span>
          <button className="ghost-button" onClick={onClose}>关闭</button>
        </div>
        <div className="drawer-body">
          <p className="settings-note">
            模型 ID 与凭证的权威是安装期配置（provider.env + 模板）；
            此处激活的 revision 影响 Kernel/Planner 的绑定、路由与开关行为。
          </p>
          {/* Provider / Model / AgentClass 表单在第 5 步实现。 */}
          <div className="empty-hint">设置表单在第 5 步实现（http: {http ? '就绪' : '未就绪'}）。</div>
        </div>
      </div>
    </div>
  );
}
