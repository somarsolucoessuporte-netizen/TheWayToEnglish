# Backlog

Pendências registradas — não resolvidas ainda. Origem: auditoria de
conteúdo/fluxo das lições (2026-09-28).

## Persona / prompt

- [ ] `persona.ts` não tem as seções **ACTIVE TUTOR** e **TIME MANAGEMENT**,
  mas `route.ts`, `orchestrator.ts`, `AIProvider.ts` e `page.tsx` remetem a elas.
- [ ] OUTPUT FORMAT da persona documenta o campo antigo `hint` (string), e
  não `hints[]`, `expectedAnswer` e `level` do `TutorResponseSchema`.
- [ ] `findLeakedAnswer` (`route.ts`) está inerte: depende de `expectedAnswer`,
  que a persona nunca pede ao modelo.
- [ ] A persona vai 2x por turno: o cliente manda como mensagem `system`
  (`orchestrator.ts` runTurn) e o servidor descarta (`route.ts`).
- [ ] O histórico da conversa cresce sem limite, sem corte nem resumo.
- [ ] O modelo marca como concluída (`completedGoals`) a tarefa que acabou de
  **começar**, na mesma resposta. Visto em produção em 2026-09-28, lição B:
  depois de receber "task-1 concluída, atual task-2", ele respondeu
  iniciando a task-2 com `completedGoals: ["task-2"]`. Isso pode encerrar a
  lição antes da hora.

## Conteúdo / compilação

- [ ] 4 lições sem tarefas (3B, 3C, 3E, 3G): o modelo improvisa tudo a
  partir do conteúdo de referência.
- [ ] Rótulos de tipo com erro em `scripts/processar-unit.py`: regex por
  palavra-chave com "primeira que casar vence". `correct`, `offer_repeat`
  e `explain` nunca são produzidos. Exemplos errados: B.1 e 3H.2 viram
  `demonstrate`, 2F.1 vira `student_answers`, 3A.5 e 3D.1 viram `other`, e
  4D.2 e 4E.3 (notas "ATENÇÃO: USAR AS MESMAS IMAGENS") viram tarefas.
