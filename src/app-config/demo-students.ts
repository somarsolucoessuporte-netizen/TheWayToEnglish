// TODO: no produto real estes dados vêm da autenticação e do sistema
// acadêmico da escola (login → identifica o aluno → busca a lição atual
// dele no sistema da escola). Este seletor é só um substituto de
// demonstração para o protótipo comercial — remover quando houver login
// real e integração com o sistema acadêmico.
// Plain `string` fields (not `as const` literals): a real request can also
// build one of these from URL params (?aluno=&licao=, see page.tsx) with a
// lesson code that isn't one of the three demo codes below.
export interface DemoStudent {
  id: string;
  name: string;
  currentLesson: string;
  lastSession: string;
}

export const DEMO_STUDENTS: DemoStudent[] = [
  { id: "pedro", name: "Pedro", currentLesson: "A", lastSession: "Boas-vindas" },
  { id: "marina", name: "Marina", currentLesson: "1A", lastSession: "Lesson 1A — Introductions" },
  { id: "lucas", name: "Lucas", currentLesson: "1B", lastSession: "Lesson 1B — Alphabet" },
];
