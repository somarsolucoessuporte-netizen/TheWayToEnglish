// TODO: no produto real estes dados vêm da autenticação e do sistema
// acadêmico da escola (login → identifica o aluno → busca a lição atual
// dele no sistema da escola). Este seletor é só um substituto de
// demonstração para o protótipo comercial — remover quando houver login
// real e integração com o sistema acadêmico.
export const DEMO_STUDENTS = [
  { id: "pedro", name: "Pedro", currentLesson: "A", lastSession: "Boas-vindas" },
  { id: "marina", name: "Marina", currentLesson: "1A", lastSession: "Lesson 1A — Introductions" },
  { id: "lucas", name: "Lucas", currentLesson: "1B", lastSession: "Lesson 1B — Alphabet" },
] as const;

export type DemoStudent = (typeof DEMO_STUDENTS)[number];
