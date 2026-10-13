"use client";

import { useState } from "react";
import type { CurriculumLesson } from "@/app-config/curriculum";
import TutorApp from "@/app/TutorApp";
import { useDemoConfig } from "./useDemoConfig";
import { DemoBanner } from "./DemoBanner";

/**
 * Wrapper white-label para prospecção. Envolve o TutorApp que já existe, sem
 * alterá-lo: aplica as cores da escola (via useDemoConfig) e esconde as
 * marcas "The Way To English" por CSS escopado sob `.demo-root` — nada no
 * componente do tutor ou em produção é tocado.
 *
 * Limitação conhecida: o nome falado da tutora ("Debbie") e "The Way To
 * English" estão embutidos em app-config/persona.ts, que o TutorApp importa
 * direto. Trocar isso por `nome_tutor` exigiria editar o componente/persona
 * de produção — fora do escopo desta demo. O white-label aqui é visual.
 */
export function DemoPage({
  slug,
  lessons,
}: {
  slug: string;
  lessons: CurriculumLesson[];
}) {
  const { config, expirado, escolaValida } = useDemoConfig(slug);
  const [logoOk, setLogoOk] = useState(true);

  if (!escolaValida) {
    return (
      <div style={centerScreen}>
        <h2 style={{ margin: 0 }}>Demo não encontrada</h2>
        <p style={{ color: "#666", maxWidth: 420, textAlign: "center" }}>
          O link que você acessou não corresponde a nenhuma demonstração ativa.
        </p>
      </div>
    );
  }

  if (expirado) {
    return (
      <div style={{ ...centerScreen, textAlign: "center", padding: 24 }}>
        {config.logo_url && logoOk && (
          <img
            src={config.logo_url}
            alt={config.nome}
            onError={() => setLogoOk(false)}
            style={{ maxHeight: 80, marginBottom: 24 }}
          />
        )}
        <h2 style={{ margin: 0 }}>Demonstração encerrada</h2>
        <p>
          O período de demonstração para <strong>{config.nome}</strong> foi
          encerrado.
        </p>
        <p style={{ marginTop: 16, fontSize: 14, color: "#666" }}>
          Para contratar ou renovar, entre em contato com a{" "}
          <a href="https://somar.ia.br" target="_blank" rel="noopener noreferrer">
            Somar Soluções Digitais
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="demo-root">
      {/* CSS escopado: esconde a marca The Way To English nas superfícies
          que o TutorApp/LoadingScreen renderizam, sem editar esses arquivos. */}
      <style dangerouslySetInnerHTML={{ __html: DEMO_SCOPED_CSS }} />

      {/* Logo flutuante da escola — não reserva espaço no layout, então não
          quebra o 100dvh que o avatar (sobretudo no mobile) depende. */}
      {config.logo_url && logoOk && (
        <div className="demo-logo-badge" title={config.mensagem_boas_vindas}>
          <img
            src={config.logo_url}
            alt={config.nome}
            onError={() => setLogoOk(false)}
          />
        </div>
      )}

      <TutorApp lessons={lessons} />

      <DemoBanner escolaNome={config.nome} />
    </div>
  );
}

const centerScreen: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100dvh",
  gap: 8,
  fontFamily: "'Poppins', ui-sans-serif, system-ui, sans-serif",
};

const DEMO_SCOPED_CSS = `
/* Marca textual/logo da The Way To English — ocultas só dentro da demo. */
.demo-root .topbar .brand { display: none !important; }
.demo-root .footer { display: none !important; }
.demo-root .wtes-wordmark { display: none !important; }
.demo-root .wtes-logo-big { visibility: hidden !important; }

/* Badge flutuante com o logo da escola. */
.demo-root .demo-logo-badge {
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9998;
  background: var(--cor-secundaria, #fff);
  border-radius: 10px;
  padding: 6px 12px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
  pointer-events: none;
}
.demo-root .demo-logo-badge img {
  display: block;
  max-height: 36px;
  max-width: 160px;
  object-fit: contain;
}
`;
