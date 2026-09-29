# Ponto de restauração — v1-ciclo-funcionando

| | |
|---|---|
| **Tag** | `v1-ciclo-funcionando` (anotada) |
| **Branch congelada** | `estavel-v1`: **nunca recebe commit** |
| **Código da aplicação** | `f5f106d` (`f5f106d9f5ab9604ea087eee762ac6203b5a0d97`). A tag aponta para o commit que adiciona este arquivo; o código é idêntico ao de `f5f106d` |
| **Data** | 2026-09-28 |
| **Repositório** | https://github.com/somarsolucoessuporte-netizen/TheWayToEnglish |
| **Produção** | https://the-way-to-english.vercel.app (alias: https://prototipotheway.somar.ia.br) |
| **Deploy da Vercel (f5f106d)** | ID `E1UpT87dE3WHa36a9pcdyMKoqypm`: https://vercel.com/coffee-beats/the-way-to-english/E1UpT87dE3WHa36a9pcdyMKoqypm |
| **URL imutável do deploy** | ⚠️ PENDENTE: copiar do link acima (campo "Domains", formato `the-way-to-english-<hash>-coffee-beats.vercel.app`). A CLI deste ambiente não tem acesso a esse projeto da Vercel |
| **Backup do currículo** | `backup/v1-ciclo-funcionando/book01-unit01.json` (sha256 `ef6d5b46d8bd884f94cafbb5fc7435c2c27a5dee4faa7e83bf93c691acda414c`) |

## O que funciona neste ponto

Os 17 scripts `scripts/test-*.cjs` passam e o `tsc --noEmit` está limpo.

- Ciclo completo de uma lição: saudação, anúncio da lição, tarefas, reação a
  cada resposta (elogio ou correção) e encerramento.
- **O encerramento é terminal** (`19bf879`): depois da última tarefa, ou
  quando o tempo acaba, não sai mais nenhum turno, nudge ou microfone. A fala
  de encerramento ainda toca.
- **O modelo recebe o progresso** (`f5f106d`): a cada turno ele vê as tarefas
  concluídas e a tarefa atual, e não recomeça a lição.
- Voz: TTS OpenAI com fallback para speechSynthesis, um único `<audio>`
  compartilhado (iOS), fila de fala com watchdog, e português nunca falado
  (só escrito na tela).
- Microfone push-to-talk (Falar) com Whisper. Descarta o eco da própria voz
  e as alucinações do Whisper, que viram "unclear".
- Nudges por silêncio (6/14/25/40 s) com teto de 3 seguidos, depois avança.
- Botão Pausar/Retomar.
- Correção com card, drill de pronúncia e escalonamento por tentativa.
- Dependência de imagem por tarefa: tarefas image-only são puladas e ficam
  fora do progresso.
- Seletor Book → Unit → Lesson e o link direto `?aluno=&licao=`.

## O que não funciona / limitações conhecidas

Detalhes em `BACKLOG.md`.

- O fluxo ainda é decidido pelo **modelo**: qual é a tarefa atual, quando
  avançar, repetições, avaliação e toda a fala. O progresso enviado ajuda,
  mas não impõe nada.
- O modelo às vezes marca como concluída a tarefa que acabou de começar, o
  que pode encerrar a lição cedo.
- Não há autenticação, persistência de sessão nem banco: o conteúdo é um
  JSON no bundle, e recarregar a página perde a sessão.
- Só existe a Book 1 / Unit 1. Não há imagens das lições.
- As lições 3B, 3C, 3E e 3G não têm tarefas, e o modelo improvisa.
- A persona tem inconsistências (seções citadas que não existem, campo
  `hint` antigo) e o histórico da conversa não tem limite.

## Como voltar

**Mais rápido (produção, sem git):** no painel da Vercel do projeto
`the-way-to-english`, abra o deploy `E1UpT87dE3WHa36a9pcdyMKoqypm` e use
**Instant Rollback / Promote to Production**.

**Pelo git (o deploy automático vem pelo push em `main`), sem reescrever
histórico:**

```sh
git fetch origin --tags
git checkout main
git revert --no-edit v1-ciclo-funcionando..HEAD   # desfaz tudo que veio depois
git push origin main
```

**Só inspecionar/rodar localmente:**

```sh
git checkout v1-ciclo-funcionando    # ou: git checkout estavel-v1
```

**Restaurar só o currículo:**

```sh
cp backup/v1-ciclo-funcionando/book01-unit01.json src/app-config/curriculum/book01-unit01.json
```
