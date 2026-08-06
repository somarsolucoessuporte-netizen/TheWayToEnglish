export function StatusPills({ connected, stateLabel }: { connected: boolean | null; stateLabel: string }) {
  const connText = connected === null ? "Conectando…" : connected ? "Conectado" : "Sem conexão";
  return (
    <div className="status">
      <span className="pill">{connText}</span>
      <span className="pill pill-soft">{stateLabel}</span>
    </div>
  );
}
