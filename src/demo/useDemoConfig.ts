import { useEffect, useState } from "react";
import schoolsData from "./schools.json";

export interface DemoSchoolConfig {
  nome: string;
  cidade?: string;
  logo_url: string | null;
  cor_primaria: string;
  cor_secundaria: string;
  /** Name the tutor speaks as on this demo (feeds TutorApp's personaOverride). */
  nome_tutor: string;
  /** School the tutor names when asked where it works (personaOverride). */
  escola_nome_ia: string;
  mensagem_boas_vindas: string;
  /** ISO date string (YYYY-MM-DD or full ISO); null = never expires. */
  expira_em: string | null;
}

const schools = schoolsData as Record<string, DemoSchoolConfig>;

const DEFAULT_CONFIG: DemoSchoolConfig = {
  nome: "English Tutor",
  cidade: undefined,
  logo_url: null,
  cor_primaria: "#1a237e",
  cor_secundaria: "#ffffff",
  nome_tutor: "Tutor",
  escola_nome_ia: "English Tutor",
  mensagem_boas_vindas: "Olá! Como posso te ajudar a aprender inglês hoje?",
  expira_em: null,
};

/**
 * The real design tokens this app's globals.css actually reads for its brand
 * chrome (buttons, the "Falar" mic button, student chat bubbles, the brand
 * dot, accent backgrounds). The generic `--cor-primaria/--cor-secundaria`
 * from the demo spec don't exist in globals.css, so the demo components use
 * those while these drive the already-shipped UI — we point them at the
 * school's primary color so the white-label theming is actually visible.
 *
 * `--text-primary` is deliberately left untouched: it colors body text, and
 * forcing it to a bright brand color (e.g. orange) would wreck readability.
 */
const BRAND_TOKENS = ["--accent", "--brand-navy"] as const;

export function useDemoConfig(slug: string | null | undefined) {
  const [config, setConfig] = useState<DemoSchoolConfig>(DEFAULT_CONFIG);
  const [expirado, setExpirado] = useState(false);
  const [escolaValida, setEscolaValida] = useState(true);

  useEffect(() => {
    if (!slug || !schools[slug]) {
      setEscolaValida(false);
      return;
    }

    setEscolaValida(true);
    setExpirado(false);

    const escolaConfig: DemoSchoolConfig = { ...DEFAULT_CONFIG, ...schools[slug] };
    setConfig(escolaConfig);

    // Expiração
    if (escolaConfig.expira_em) {
      const expira = new Date(escolaConfig.expira_em);
      if (!Number.isNaN(expira.getTime()) && new Date() > expira) {
        setExpirado(true);
      }
    }

    // CSS variables: as da demo + os tokens reais do app
    const root = document.documentElement;
    root.style.setProperty("--cor-primaria", escolaConfig.cor_primaria);
    root.style.setProperty("--cor-secundaria", escolaConfig.cor_secundaria);
    for (const token of BRAND_TOKENS) {
      root.style.setProperty(token, escolaConfig.cor_primaria);
    }

    return () => {
      // Limpa tudo ao sair da rota de demo, para não vazar o tema para
      // outras rotas que compartilham o mesmo documento.
      root.style.removeProperty("--cor-primaria");
      root.style.removeProperty("--cor-secundaria");
      for (const token of BRAND_TOKENS) {
        root.style.removeProperty(token);
      }
    };
  }, [slug]);

  return { config, expirado, escolaValida };
}
