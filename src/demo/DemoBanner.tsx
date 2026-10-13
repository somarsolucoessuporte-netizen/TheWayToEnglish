export function DemoBanner({ escolaNome }: { escolaNome: string }) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: "#111",
        color: "#fff",
        textAlign: "center",
        padding: "8px 16px",
        fontSize: "12px",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "12px",
        flexWrap: "wrap",
        // Respeita a safe-area dos iPhones com barra de gestos.
        paddingBottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <span>
        🎯 Esta é uma demonstração personalizada para <strong>{escolaNome}</strong>
      </span>
      <span style={{ opacity: 0.6 }}>|</span>
      <span>
        Powered by{" "}
        <a
          href="https://somar.ia.br"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#60a5fa", textDecoration: "none" }}
        >
          Somar Soluções Digitais
        </a>
      </span>
    </div>
  );
}
